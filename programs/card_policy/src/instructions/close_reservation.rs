//! Closes a terminal Reservation and returns its ER rent (and its
//! permission's) to the card prefund, without weakening replay protection:
//! the `auth_id_hash` moves into the card's `AuthGuard` ring in the same
//! instruction, so there is no moment where neither the Reservation nor the
//! guard entry exists.

use crate::{
    constants::*,
    er::{self, PermissionAccounts, MAGIC_PROGRAM_ADDR},
    errors::CardPolicyError,
    hashes::{append_ledger, LedgerEvent},
    instructions::common::*,
    state::{guard_bytes, reservation_state, CardPeriod, CardPolicy, Reservation},
};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    access_control::structs::PERMISSION_SEED,
    consts::{EPHEMERAL_VAULT_ID, PERMISSION_PROGRAM_ID},
};

#[derive(Accounts)]
pub struct CloseReservation<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [CARD_POLICY_SEED, policy.binding.as_ref()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, CardPolicy>>,
    #[account(
        seeds = [CARD_PERIOD_SEED, policy.binding.as_ref()],
        bump = period.bump,
        constraint = period.policy == policy.key() @ CardPolicyError::InvalidAccount,
    )]
    pub period: Box<Account<'info, CardPeriod>>,
    /// CHECK: Reservation of this card; loaded and its PDA re-derived in the
    /// handler. Unchecked (like `close_checkout_intent`'s intent) so Anchor
    /// never re-serializes an account the magic program just closed.
    #[account(mut, owner = crate::ID @ CardPolicyError::InvalidAccount)]
    pub reservation: UncheckedAccount<'info>,
    /// CHECK: reservation permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, reservation.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub reservation_permission: UncheckedAccount<'info>,
    /// CHECK: AuthGuard PDA, created here on the card's first close.
    #[account(mut, seeds = [AUTH_GUARD_SEED, policy.key().as_ref()], bump)]
    pub auth_guard: UncheckedAccount<'info>,
    /// CHECK: AuthGuard permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, auth_guard.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub auth_guard_permission: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: magic program.
    #[account(address = MAGIC_PROGRAM_ADDR)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

/// A hold is final when nothing remains reserved and the issuer can no longer
/// move it inside the reservation: fully captured, reversed or expired, with
/// no open dispute. Later issuer events for a closed hold post without a
/// Reservation (refund with none, `record_exception` for a late capture).
pub fn is_final(reservation: &Reservation) -> bool {
    matches!(
        reservation.state,
        reservation_state::CAPTURED | reservation_state::REVERSED | reservation_state::EXPIRED
    ) && reservation.amount_reserved_cents == 0
        && reservation.dispute_state != DISPUTE_OPEN
}

pub fn closed_head(head: &[u8; 32], r: &Reservation) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[
        CLOSED_DOMAIN,
        head,
        &r.auth_id_hash,
        &r.captured_cents.to_le_bytes(),
        &r.reversed_cents.to_le_bytes(),
        &r.refunded_cents.to_le_bytes(),
        &[r.state, r.dispute_state, r.flags],
    ])
    .to_bytes()
}

pub fn close_reservation(ctx: Context<CloseReservation>) -> Result<()> {
    let now = now()?;
    let a = &ctx.accounts;
    require_owner_or_authorizer(&a.policy, &a.signer.key())?;
    let policy_key = a.policy.key();
    let res_info = a.reservation.to_account_info();
    let reservation = {
        let data = res_info.try_borrow_data()?;
        Reservation::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CardPolicyError::InvalidAccount))?
    };
    require!(
        reservation.policy == policy_key,
        CardPolicyError::InvalidAccount
    );
    let expected = Pubkey::create_program_address(
        &[
            RESERVATION_SEED,
            policy_key.as_ref(),
            &reservation.auth_id_hash,
            &[reservation.bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(CardPolicyError::InvalidAccount))?;
    require!(expected == res_info.key(), CardPolicyError::InvalidAccount);
    require!(is_final(&reservation), CardPolicyError::ReservationNotFinal);

    let binding = a.policy.binding;
    let policy_bump = [a.policy.bump];
    let policy_seeds: [&[u8]; 3] = [CARD_POLICY_SEED, binding.as_ref(), &policy_bump];
    let guard_bump = [ctx.bumps.auth_guard];
    let guard_seeds: [&[u8]; 3] = [AUTH_GUARD_SEED, policy_key.as_ref(), &guard_bump];
    let policy_info = a.policy.to_account_info();
    let guard_info = a.auth_guard.to_account_info();
    let vault = a.vault.to_account_info();
    let magic_program = a.magic_program.to_account_info();
    let permission_program = a.permission_program.to_account_info();

    // 1. Guard: create on first use (private, same members as the card).
    let mut created_guard = false;
    if guard_info.data_is_empty() {
        er::create_ephemeral(
            &policy_info,
            &guard_info,
            &vault,
            &policy_seeds,
            &guard_seeds,
            AUTH_GUARD_LEN as u32,
        )?;
        let count = a.policy.member_count as usize;
        er::create_permission(
            PermissionAccounts {
                payer: &policy_info,
                permissioned: &guard_info,
                permission: &a.auth_guard_permission.to_account_info(),
                vault: &vault,
                magic_program: &magic_program,
                permission_program: &permission_program,
            },
            er::private_members(&a.policy.members[..count], &a.policy.member_flags[..count])?,
            &[&policy_seeds, &guard_seeds],
        )?;
        guard_bytes::init(
            &mut guard_info.try_borrow_mut_data()?,
            &policy_key,
            ctx.bumps.auth_guard,
        );
        created_guard = true;
    } else {
        require!(
            guard_info.owner == &crate::ID,
            CardPolicyError::InvalidAccount
        );
        require!(
            guard_bytes::policy(&guard_info.try_borrow_data()?) == Some(policy_key),
            CardPolicyError::InvalidAccount
        );
    }

    // 2. Record the auth id before the Reservation disappears.
    {
        let mut data = guard_info.try_borrow_mut_data()?;
        let count = guard_bytes::closed_count(&data)
            .checked_add(1)
            .ok_or(error!(CardPolicyError::MathOverflow))?;
        let head = closed_head(&guard_bytes::closed_head(&data), &reservation);
        guard_bytes::push(&mut data, &reservation.auth_id_hash, &head, count);
    }
    let auth_id_hash = reservation.auth_id_hash;
    let captured_cents = reservation.captured_cents;
    let final_state = reservation.state;

    // 3. Close the Reservation and its permission; rent goes back to the policy.
    let res_bump = [reservation.bump];
    let res_seeds: [&[u8]; 4] = [
        RESERVATION_SEED,
        policy_key.as_ref(),
        &auth_id_hash,
        &res_bump,
    ];
    let res_permission = a.reservation_permission.to_account_info();
    if er::permission_exists(&res_permission) {
        er::close_permission(
            PermissionAccounts {
                payer: &policy_info,
                permissioned: &res_info,
                permission: &res_permission,
                vault: &vault,
                magic_program: &magic_program,
                permission_program: &permission_program,
            },
            &[&policy_seeds, &res_seeds],
        )?;
    }
    er::close_ephemeral(&policy_info, &res_info, &vault, &policy_seeds)?;

    let period_index = a.period.period_index;
    let accounts = ctx.accounts;
    ephemeral_closed(&mut accounts.policy);
    if created_guard {
        ephemeral_created(&mut accounts.policy)?;
    }
    let mut event = LedgerEvent::new(EV_CLOSE_RESERVATION);
    event.auth_id_hash = auth_id_hash;
    event.amount_cents = captured_cents;
    event.state_after = final_state;
    append_ledger(&mut accounts.policy, event, period_index, now)
}
