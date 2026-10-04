use crate::{
    constants::*,
    er::{self, PermissionAccounts, MAGIC_PROGRAM_ADDR},
    errors::CardPolicyError,
    instructions::{common::*, permission::ephemeral_identity},
    state::{CardBinding, CardCommitment, CardPeriod, CardPolicy},
};
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use ephemeral_rollups_sdk::{
    access_control::structs::PERMISSION_SEED,
    anchor::delegate,
    consts::{EPHEMERAL_VAULT_ID, MAGIC_CONTEXT_ID, PERMISSION_PROGRAM_ID},
    cpi::DelegateConfig,
};

// ---------------------------------------------------------------- init_card

#[derive(Accounts)]
#[instruction(card_id: [u8; 32])]
pub struct InitCard<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + CardBinding::INIT_SPACE,
        seeds = [CARD_BINDING_SEED, owner.key().as_ref(), card_id.as_ref()],
        bump
    )]
    pub binding: Box<Account<'info, CardBinding>>,
    #[account(
        init,
        payer = owner,
        space = 8 + CardPolicy::INIT_SPACE,
        seeds = [CARD_POLICY_SEED, binding.key().as_ref()],
        bump
    )]
    pub policy: Box<Account<'info, CardPolicy>>,
    #[account(
        init,
        payer = owner,
        space = 8 + CardPeriod::INIT_SPACE,
        seeds = [CARD_PERIOD_SEED, binding.key().as_ref()],
        bump
    )]
    pub period: Box<Account<'info, CardPeriod>>,
    #[account(
        init,
        payer = owner,
        space = 8 + CardCommitment::INIT_SPACE,
        seeds = [CARD_COMMITMENT_SEED, binding.key().as_ref()],
        bump
    )]
    pub commitment: Box<Account<'info, CardCommitment>>,
    pub system_program: Program<'info, System>,
}

pub fn init_card(
    ctx: Context<InitCard>,
    card_id: [u8; 32],
    issuer: u8,
    issuer_card_ref_hash: [u8; 32],
    prefund_lamports: u64,
) -> Result<()> {
    require!(card_id != [0u8; 32], CardPolicyError::InvalidPolicy);
    require!(
        issuer == ISSUER_LITHIC_SANDBOX || issuer == ISSUER_CARD_SIM,
        CardPolicyError::InvalidPolicy
    );
    require!(
        prefund_lamports >= MIN_PREFUND,
        CardPolicyError::PrefundTooLow
    );

    // The policy PDA carries these lamports onto the ER, where it sponsors
    // ephemeral reservations, intents and their permissions.
    transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.policy.to_account_info(),
            },
        ),
        prefund_lamports,
    )?;

    let binding_key = ctx.accounts.binding.key();
    let binding = &mut ctx.accounts.binding;
    binding.version = 1;
    binding.owner = ctx.accounts.owner.key();
    binding.card_id = card_id;
    binding.issuer = issuer;
    binding.issuer_card_ref_hash = issuer_card_ref_hash;
    binding.policy = ctx.accounts.policy.key();
    binding.period = ctx.accounts.period.key();
    binding.commitment = ctx.accounts.commitment.key();
    binding.status = BINDING_ACTIVE;
    binding.created_at = now()?;
    binding.bump = ctx.bumps.binding;

    // Everything else stays zero: these bytes are public on the base layer
    // until delegation and stay the base snapshot afterwards (CD-2).
    let policy = &mut ctx.accounts.policy;
    policy.binding = binding_key;
    policy.owner = ctx.accounts.owner.key();
    policy.bump = ctx.bumps.policy;

    let period = &mut ctx.accounts.period;
    period.policy = ctx.accounts.policy.key();
    period.bump = ctx.bumps.period;

    let commitment = &mut ctx.accounts.commitment;
    commitment.binding = binding_key;
    commitment.bump = ctx.bumps.commitment;
    Ok(())
}

// ------------------------------------------------------------ delegate_card

#[delegate]
#[derive(Accounts)]
pub struct DelegateCard<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ CardPolicyError::Unauthorized,
        seeds = [CARD_BINDING_SEED, owner.key().as_ref(), binding.card_id.as_ref()],
        bump = binding.bump,
    )]
    pub binding: Box<Account<'info, CardBinding>>,
    /// CHECK: card policy PDA, delegated as-is (zeroed apart from binding/owner).
    #[account(mut, del, address = binding.policy)]
    pub policy: UncheckedAccount<'info>,
    /// CHECK: card period PDA, delegated as-is (zeroed apart from policy).
    #[account(mut, del, address = binding.period)]
    pub period: UncheckedAccount<'info>,
}

pub fn delegate_card(ctx: Context<DelegateCard>, validator: Pubkey) -> Result<()> {
    require!(
        TEE_VALIDATOR_ALLOWLIST.contains(&validator),
        CardPolicyError::ValidatorNotAllowed
    );
    require!(
        ctx.accounts.binding.status == BINDING_ACTIVE,
        CardPolicyError::InvalidAccount
    );
    let binding_key = ctx.accounts.binding.key();
    // u32::MAX = never auto-commit. Committing a private account would publish it.
    let config = || DelegateConfig {
        commit_frequency_ms: u32::MAX,
        validator: Some(validator),
    };
    if ctx.accounts.policy.owner != &ephemeral_rollups_sdk::id() {
        ctx.accounts.delegate_policy(
            &ctx.accounts.owner,
            &[CARD_POLICY_SEED, binding_key.as_ref()],
            config(),
        )?;
    }
    if ctx.accounts.period.owner != &ephemeral_rollups_sdk::id() {
        ctx.accounts.delegate_period(
            &ctx.accounts.owner,
            &[CARD_PERIOD_SEED, binding_key.as_ref()],
            config(),
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------- wipe_card

#[derive(Accounts)]
pub struct WipeCard<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ CardPolicyError::Unauthorized,
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
    /// CHECK: policy permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, policy.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub policy_permission: UncheckedAccount<'info>,
    /// CHECK: period permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, period.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub period_permission: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: magic context.
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: magic program.
    #[account(address = MAGIC_PROGRAM_ADDR)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

/// Remaining accounts: pairs of `[ephemeral account, its permission]` for every
/// reservation and intent of this card that should be closed.
pub fn wipe_card<'info>(ctx: Context<'info, WipeCard<'info>>) -> Result<()> {
    let accounts = &ctx.accounts;
    require!(accounts.policy.frozen, CardPolicyError::CardFrozen);
    require!(
        accounts.period.reserved_cents == 0,
        CardPolicyError::OpenReservations
    );
    require!(
        accounts.policy.statement_outstanding_cents == 0,
        CardPolicyError::OutstandingBalance
    );
    require!(
        ctx.remaining_accounts.len().is_multiple_of(2),
        CardPolicyError::InvalidAccount
    );

    let policy_key = accounts.policy.key();
    let binding = accounts.policy.binding;
    let policy_bump = [accounts.policy.bump];
    let policy_seeds: [&[u8]; 3] = [CARD_POLICY_SEED, binding.as_ref(), &policy_bump];
    let period_bump = [accounts.period.bump];
    let period_seeds: [&[u8]; 3] = [CARD_PERIOD_SEED, binding.as_ref(), &period_bump];
    let policy_info = accounts.policy.to_account_info();
    let period_info = accounts.period.to_account_info();
    let vault = accounts.vault.to_account_info();
    let magic_program = accounts.magic_program.to_account_info();
    let permission_program = accounts.permission_program.to_account_info();

    let mut closed: u16 = 0;
    for pair in ctx.remaining_accounts.chunks(2) {
        let (eph, eph_permission) = (&pair[0], &pair[1]);
        require!(eph.owner == &crate::ID, CardPolicyError::InvalidAccount);
        let (seed_prefix, id, bump) = ephemeral_identity(eph, &policy_key)?;
        let eph_bump = [bump];
        let eph_seeds: [&[u8]; 4] = [seed_prefix, policy_key.as_ref(), &id, &eph_bump];
        let (expected_permission, _) = Pubkey::find_program_address(
            &[PERMISSION_SEED, eph.key.as_ref()],
            &PERMISSION_PROGRAM_ID,
        );
        require!(
            expected_permission == *eph_permission.key,
            CardPolicyError::InvalidAccount
        );
        if er::permission_exists(eph_permission) {
            er::close_permission(
                PermissionAccounts {
                    payer: &policy_info,
                    permissioned: eph,
                    permission: eph_permission,
                    vault: &vault,
                    magic_program: &magic_program,
                    permission_program: &permission_program,
                },
                &[&policy_seeds, &eph_seeds],
            )?;
        }
        er::close_ephemeral(&policy_info, eph, &vault, &policy_seeds)?;
        closed = closed.saturating_add(1);
    }
    // Every reservation and intent must be closed here: once the policy is
    // undelegated, nothing can sign for them any more.
    require!(
        accounts.policy.ephemeral_count <= closed,
        CardPolicyError::EphemeralAccountsOpen
    );

    for (permissioned, permission, seeds) in [
        (
            &policy_info,
            accounts.policy_permission.to_account_info(),
            &policy_seeds,
        ),
        (
            &period_info,
            accounts.period_permission.to_account_info(),
            &period_seeds,
        ),
    ] {
        if er::permission_exists(&permission) {
            er::close_permission(
                PermissionAccounts {
                    payer: &policy_info,
                    permissioned,
                    permission: &permission,
                    vault: &vault,
                    magic_program: &magic_program,
                    permission_program: &permission_program,
                },
                &[&policy_seeds, seeds],
            )?;
        }
    }

    let owner = accounts.policy.owner;
    let policy_bump_value = accounts.policy.bump;
    let period_bump_value = accounts.period.bump;
    let accounts = ctx.accounts;
    accounts
        .policy
        .set_inner(zeroed_policy(binding, owner, policy_bump_value));
    accounts
        .period
        .set_inner(zeroed_period(policy_key, period_bump_value));
    // Serialize the zeroed bytes before scheduling the commit: only zeros reach base.
    accounts.policy.exit(&crate::ID)?;
    accounts.period.exit(&crate::ID)?;
    er::commit_and_undelegate(
        &accounts.owner.to_account_info(),
        &accounts.magic_context.to_account_info(),
        &accounts.magic_program.to_account_info(),
        &[
            accounts.policy.to_account_info(),
            accounts.period.to_account_info(),
        ],
    )
}

pub fn zeroed_policy(binding: Pubkey, owner: Pubkey, bump: u8) -> CardPolicy {
    CardPolicy {
        binding,
        owner,
        authorizer: Pubkey::default(),
        policy_version: 0,
        budget_cents: 0,
        max_purchase_cents: 0,
        max_purchases_per_period: 0,
        period_seconds: 0,
        currency: [0; 3],
        merchant_count: 0,
        merchant_id_hashes: [[0; 32]; MAX_MERCHANTS],
        mcc_count: 0,
        mccs: [0; MAX_MCCS],
        expires_at: 0,
        recurring_allowed: false,
        fee_bps: 0,
        frozen: false,
        freeze_reason: 0,
        recovery_state: 0,
        statement_outstanding_cents: 0,
        exceptions_open: 0,
        member_count: 0,
        members: [Pubkey::default(); MAX_MEMBERS],
        member_flags: [0; MAX_MEMBERS],
        ledger_head: [0; 32],
        ledger_seq: 0,
        commit_seq: 0,
        bump,
        recon_digest: [0; 32],
        repayment_digests: [[0; 32]; REPAYMENT_RING],
        repayment_count: 0,
        event_ids: [[0; 32]; EVENT_RING],
        event_count: 0,
        ephemeral_count: 0,
    }
}

pub fn zeroed_period(policy: Pubkey, bump: u8) -> CardPeriod {
    CardPeriod {
        policy,
        period_index: 0,
        period_start: 0,
        period_end: 0,
        captured_cents: 0,
        reserved_cents: 0,
        refunded_cents: 0,
        purchases_count: 0,
        exception_cents: 0,
        bump,
    }
}

// --------------------------------------------------------------- close_card

#[derive(Accounts)]
pub struct CloseCard<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ CardPolicyError::Unauthorized,
        seeds = [CARD_BINDING_SEED, owner.key().as_ref(), binding.card_id.as_ref()],
        bump = binding.bump,
    )]
    pub binding: Box<Account<'info, CardBinding>>,
    #[account(mut, close = owner, address = binding.policy)]
    pub policy: Box<Account<'info, CardPolicy>>,
    #[account(mut, close = owner, address = binding.period)]
    pub period: Box<Account<'info, CardPeriod>>,
}

pub fn close_card(ctx: Context<CloseCard>) -> Result<()> {
    let binding_key = ctx.accounts.binding.key();
    let policy = &ctx.accounts.policy;
    let period = &ctx.accounts.period;
    let wiped_policy = zeroed_policy(binding_key, policy.owner, policy.bump);
    let wiped_period = zeroed_period(policy.key(), period.bump);
    require!(
        to_bytes(&***policy)? == to_bytes(&wiped_policy)?
            && to_bytes(&***period)? == to_bytes(&wiped_period)?,
        CardPolicyError::NotWiped
    );
    ctx.accounts.binding.status = BINDING_CLOSED;
    Ok(())
}

fn to_bytes<T: AnchorSerialize>(value: &T) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    value.serialize(&mut out)?;
    Ok(out)
}
