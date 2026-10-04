use crate::{
    constants::*,
    er::{self, PermissionAccounts, MAGIC_PROGRAM_ADDR},
    errors::CardPolicyError,
    hashes::{append_ledger, LedgerEvent},
    instructions::common::*,
    policy::{add, add_exposure, validate_authorize, AuthorizeArgs},
    state::{guard_bytes, reservation_state, CardPeriod, CardPolicy, CheckoutIntent, Reservation},
};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    access_control::structs::PERMISSION_SEED,
    consts::{EPHEMERAL_VAULT_ID, PERMISSION_PROGRAM_ID},
};

#[derive(Accounts)]
#[instruction(args: AuthorizeArgs)]
pub struct Authorize<'info> {
    pub authorizer: Signer<'info>,
    #[account(
        mut,
        seeds = [CARD_POLICY_SEED, policy.binding.as_ref()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, CardPolicy>>,
    #[account(
        mut,
        seeds = [CARD_PERIOD_SEED, policy.binding.as_ref()],
        bump = period.bump,
        constraint = period.policy == policy.key() @ CardPolicyError::InvalidAccount,
    )]
    pub period: Box<Account<'info, CardPeriod>>,
    /// CHECK: CheckoutIntent PDA; loaded in the handler so a missing or foreign
    /// intent maps to `IntentInvalid` instead of a generic account error.
    #[account(mut, seeds = [INTENT_SEED, policy.key().as_ref(), args.intent_id.as_ref()], bump)]
    pub intent: UncheckedAccount<'info>,
    /// CHECK: ephemeral Reservation PDA; its existence is the replay guard.
    #[account(mut, seeds = [RESERVATION_SEED, policy.key().as_ref(), args.auth_id_hash.as_ref()], bump)]
    pub reservation: UncheckedAccount<'info>,
    /// CHECK: reservation permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, reservation.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub reservation_permission: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: magic program.
    #[account(address = MAGIC_PROGRAM_ADDR)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
    /// CHECK: the card's AuthGuard PDA (appended in final fixes). Empty until
    /// the first reservation is closed; read in the handler.
    #[account(seeds = [AUTH_GUARD_SEED, policy.key().as_ref()], bump)]
    pub auth_guard: UncheckedAccount<'info>,
}

/// `true` when a closed reservation for this `auth_id_hash` is still inside
/// the guard's window. An empty guard (no closes yet) holds nothing.
fn recently_closed(guard: &AccountInfo, policy: &Pubkey, auth_id_hash: &[u8; 32]) -> Result<bool> {
    if guard.data_is_empty() {
        return Ok(false);
    }
    require!(guard.owner == &crate::ID, CardPolicyError::InvalidAccount);
    let data = guard.try_borrow_data()?;
    require!(
        guard_bytes::policy(&data) == Some(*policy),
        CardPolicyError::InvalidAccount
    );
    Ok(guard_bytes::contains(&data, auth_id_hash))
}

fn load_intent(info: &AccountInfo, policy: &Pubkey) -> Result<CheckoutIntent> {
    require!(
        info.owner == &crate::ID && !info.data_is_empty(),
        CardPolicyError::IntentInvalid
    );
    let data = info.try_borrow_data()?;
    let intent = CheckoutIntent::try_deserialize(&mut &data[..])
        .map_err(|_| error!(CardPolicyError::IntentInvalid))?;
    require!(intent.policy == *policy, CardPolicyError::IntentInvalid);
    Ok(intent)
}

pub fn authorize(ctx: Context<Authorize>, args: AuthorizeArgs) -> Result<()> {
    let now = now()?;
    let accounts = &ctx.accounts;
    require_authorizer(&accounts.policy, &accounts.authorizer.key())?;
    // Replay first: a duplicate of an approved authorization must always come
    // back as DuplicateAuthorization, even though its intent is now consumed.
    require!(
        accounts.reservation.data_is_empty(),
        CardPolicyError::DuplicateAuthorization
    );
    // ...and after its terminal Reservation was closed, the guard ring.
    require!(
        !recently_closed(
            &accounts.auth_guard,
            &accounts.policy.key(),
            &args.auth_id_hash
        )?,
        CardPolicyError::DuplicateAuthorization
    );
    require!(
        args.auth_id_hash != [0u8; 32],
        CardPolicyError::InvalidEventId
    );
    let policy_key = accounts.policy.key();
    let mut intent = load_intent(&accounts.intent, &policy_key)?;
    validate_authorize(&accounts.policy, &accounts.period, &intent, &args, now)?;

    let binding = accounts.policy.binding;
    let policy_bump = [accounts.policy.bump];
    let policy_seeds: [&[u8]; 3] = [CARD_POLICY_SEED, binding.as_ref(), &policy_bump];
    let res_bump = [ctx.bumps.reservation];
    let res_seeds: [&[u8]; 4] = [
        RESERVATION_SEED,
        policy_key.as_ref(),
        &args.auth_id_hash,
        &res_bump,
    ];
    let policy_info = accounts.policy.to_account_info();
    let res_info = accounts.reservation.to_account_info();
    let vault = accounts.vault.to_account_info();

    er::create_ephemeral(
        &policy_info,
        &res_info,
        &vault,
        &policy_seeds,
        &res_seeds,
        RESERVATION_LEN as u32,
    )?;
    let count = accounts.policy.member_count as usize;
    er::create_permission(
        PermissionAccounts {
            payer: &policy_info,
            permissioned: &res_info,
            permission: &accounts.reservation_permission.to_account_info(),
            vault: &vault,
            magic_program: &accounts.magic_program.to_account_info(),
            permission_program: &accounts.permission_program.to_account_info(),
        },
        er::private_members(
            &accounts.policy.members[..count],
            &accounts.policy.member_flags[..count],
        )?,
        &[&policy_seeds, &res_seeds],
    )?;

    let amount = args.amount_cents;
    let mut flags = 0u8;
    if args.single_message {
        flags |= FLAG_SINGLE_MESSAGE;
    }
    if args.merchant_initiated {
        flags |= FLAG_RECURRING;
    }
    let mut reservation = Reservation {
        policy: policy_key,
        auth_id_hash: args.auth_id_hash,
        intent: accounts.intent.key(),
        period_index: accounts.period.period_index,
        amount_reserved_cents: amount,
        captured_cents: 0,
        reversed_cents: 0,
        refunded_cents: 0,
        state: reservation_state::RESERVED,
        dispute_state: 0,
        flags,
        created_at: now,
        hold_expires_at: now
            .checked_add(HOLD_TTL_SECONDS)
            .ok_or(error!(CardPolicyError::MathOverflow))?,
        bump: ctx.bumps.reservation,
        capture_count: 0,
        capture_ids: [[0u8; 32]; CAPTURE_RING],
    };

    let accounts = ctx.accounts;
    ephemeral_created(&mut accounts.policy)?;
    let period = &mut accounts.period;
    period.purchases_count = period
        .purchases_count
        .checked_add(1)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    if args.single_message {
        // Single-message (dual-purpose) transactions settle in the authorization.
        reservation.amount_reserved_cents = 0;
        reservation.captured_cents = amount;
        reservation.state = reservation_state::CAPTURED;
        period.captured_cents = add(period.captured_cents, amount)?;
        add_exposure(&mut accounts.policy, amount)?;
    } else {
        period.reserved_cents = add(period.reserved_cents, amount)?;
    }
    let period_index = period.period_index;
    {
        let mut data = res_info.try_borrow_mut_data()?;
        reservation.try_serialize(&mut &mut data[..])?;
    }

    intent.state = INTENT_CONSUMED;
    intent.reservation = res_info.key();
    {
        let intent_info = accounts.intent.to_account_info();
        let mut data = intent_info.try_borrow_mut_data()?;
        intent.try_serialize(&mut &mut data[..])?;
    }

    let mut event = LedgerEvent::new(EV_AUTHORIZE);
    event.auth_id_hash = args.auth_id_hash;
    event.amount_cents = amount;
    event.state_after = reservation.state;
    append_ledger(&mut accounts.policy, event, period_index, now)
}
