use crate::{
    constants::*,
    errors::CardPolicyError,
    hashes::{append_ledger, LedgerEvent},
    instructions::{common::*, OwnerCardEvent},
    policy::{apply_policy_args, validate_policy_args, PolicyArgs},
    state::{CardPeriod, CardPolicy},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct FreezeCard<'info> {
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
}

/// Owner or authorizer. The authorizer may only freeze for `authorizer_safety`
/// (the fail-safe direction); it can never unfreeze. Works before a policy is
/// set, so the owner can always stop a card.
pub fn freeze(ctx: Context<FreezeCard>, reason: u8) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    let is_owner = require_owner_or_authorizer(&a.policy, &a.signer.key())?;
    if is_owner {
        require!(
            reason == FREEZE_OWNER || reason == FREEZE_EXPIRY,
            CardPolicyError::InvalidPolicy
        );
    } else {
        require!(
            reason == FREEZE_AUTHORIZER_SAFETY,
            CardPolicyError::Unauthorized
        );
    }
    if !a.policy.frozen {
        a.policy.frozen = true;
        a.policy.freeze_reason = reason;
    }
    let mut event = LedgerEvent::new(EV_FREEZE);
    event.state_after = reason;
    append_ledger(&mut a.policy, event, a.period.period_index, now)
}

pub fn unfreeze(ctx: Context<OwnerCardEvent>) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require!(
        a.policy.recovery_state == RECOVERY_NORMAL,
        CardPolicyError::RecoveryFrozen
    );
    require!(
        a.policy.exceptions_open == 0,
        CardPolicyError::ExceptionsOpen
    );
    a.policy.frozen = false;
    a.policy.freeze_reason = FREEZE_NONE;
    append_ledger(
        &mut a.policy,
        LedgerEvent::new(EV_UNFREEZE),
        a.period.period_index,
        now,
    )
}

pub fn recovery_freeze(ctx: Context<FreezeCard>, reason: u8) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require_owner_or_authorizer(&a.policy, &a.signer.key())?;
    a.policy.frozen = true;
    a.policy.freeze_reason = FREEZE_RECOVERY;
    // A new loss during restored_pending_reconcile sends the card back to
    // recovery_frozen, so the owner restores again from fresh issuer truth.
    a.policy.recovery_state = RECOVERY_FROZEN;
    let mut event = LedgerEvent::new(EV_RECOVERY_FREEZE);
    event.state_after = reason;
    append_ledger(&mut a.policy, event, a.period.period_index, now)
}

/// Restore is co-signed: the owner approves the numbers and the authorizer
/// attests they come from issuer truth (contracts.md §8 reconciliation report).
/// Neither can rewrite counters or credit exposure alone.
#[derive(Accounts)]
pub struct RestoreCard<'info> {
    pub owner: Signer<'info>,
    pub authorizer: Signer<'info>,
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
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RestoreArgs {
    pub policy: PolicyArgs,
    pub period_index: u32,
    pub captured_cents: u64,
    pub reserved_cents: u64,
    pub refunded_cents: u64,
    pub purchases_count: u16,
    pub exception_cents: u64,
    pub statement_outstanding_cents: u64,
    pub ledger_head: [u8; 32],
    pub ledger_seq: u64,
    pub recon_digest: [u8; 32],
}

/// Owner-assisted restore from the reconciliation report (contracts.md §8).
/// Writes the reconciled values; never zeroes counters; the card stays frozen.
pub fn restore(ctx: Context<RestoreCard>, args: RestoreArgs) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require!(
        a.policy.member_count >= 2 && a.policy.members[1] == a.authorizer.key(),
        CardPolicyError::Unauthorized
    );
    require!(
        a.policy.recovery_state == RECOVERY_FROZEN,
        CardPolicyError::NotInRecovery
    );
    require!(
        args.recon_digest != [0u8; 32],
        CardPolicyError::InvalidEventId
    );
    validate_policy_args(&args.policy, &a.policy.owner, now)?;
    // Restore restores; rotating the authorizer goes through set_policy.
    require!(
        a.policy.member_count >= 2 && a.policy.members[1] == args.policy.authorizer,
        CardPolicyError::InvalidPolicy
    );
    require!(args.period_index >= 1, CardPolicyError::InvalidPolicy);

    apply_policy_args(&mut a.policy, &args.policy);
    a.policy.policy_version = a
        .policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    a.policy.statement_outstanding_cents = args.statement_outstanding_cents;
    a.policy.ledger_head = args.ledger_head;
    a.policy.ledger_seq = args.ledger_seq;
    a.policy.recon_digest = args.recon_digest;
    a.policy.recovery_state = RECOVERY_RESTORED_PENDING;
    a.policy.frozen = true;
    a.policy.freeze_reason = FREEZE_RECOVERY;

    let period = &mut a.period;
    period.period_index = args.period_index;
    period.period_start = now;
    period.period_end = now
        .checked_add(args.policy.period_seconds as i64)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    period.captured_cents = args.captured_cents;
    period.reserved_cents = args.reserved_cents;
    period.refunded_cents = args.refunded_cents;
    period.purchases_count = args.purchases_count;
    period.exception_cents = args.exception_cents;

    let mut event = LedgerEvent::new(EV_RESTORE);
    event.event_id_hash = args.recon_digest;
    event.state_after = RECOVERY_RESTORED_PENDING;
    append_ledger(&mut a.policy, event, args.period_index, now)
}

pub fn confirm_reconciled(ctx: Context<OwnerCardEvent>, recon_digest: [u8; 32]) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require!(
        a.policy.recovery_state == RECOVERY_RESTORED_PENDING,
        CardPolicyError::NotInRecovery
    );
    require!(
        a.policy.recon_digest == recon_digest,
        CardPolicyError::ReconDigestMismatch
    );
    // Still frozen: only an explicit owner `unfreeze` resumes spending.
    a.policy.recovery_state = RECOVERY_NORMAL;
    let mut event = LedgerEvent::new(EV_CONFIRM_RECONCILED);
    event.event_id_hash = recon_digest;
    append_ledger(&mut a.policy, event, a.period.period_index, now)
}
