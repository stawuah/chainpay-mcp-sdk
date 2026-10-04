use crate::{
    constants::*,
    errors::CardPolicyError,
    hashes::{append_ledger, LedgerEvent},
    instructions::{common::*, permission::sync_card_permissions, CardPermissions},
    policy::{apply_policy_args, validate_policy_args, PolicyArgs},
};
use anchor_lang::prelude::*;

/// Owner-signed. Once the policy is set, a change to the credit terms (the
/// authorizer, the fee, a larger budget or a shorter period) also needs the
/// **current** authorizer's signature, passed as a signer in the first
/// remaining account: otherwise an owner could install a second wallet as
/// authorizer and then rewrite its own debt (review F1). Lowering the budget
/// stays owner-only, but never below what the period already spent or holds.
pub fn set_policy(ctx: Context<CardPermissions>, args: PolicyArgs) -> Result<()> {
    let now = now()?;
    let owner = ctx.accounts.owner.key();
    {
        let policy = &ctx.accounts.policy;
        require!(
            policy.member_count >= 2,
            CardPolicyError::PermissionNotInitialized
        );
        require!(
            policy.recovery_state == RECOVERY_NORMAL,
            CardPolicyError::RecoveryFrozen
        );
    }
    validate_policy_args(&args, &owner, now)?;
    {
        let policy = &ctx.accounts.policy;
        let period = &ctx.accounts.period;
        if policy.is_set() {
            if policy.authorizer != args.authorizer {
                require!(
                    policy.frozen,
                    CardPolicyError::AuthorizerChangeRequiresFreeze
                );
            }
            let credit_terms_change = args.authorizer != policy.authorizer
                || args.fee_bps != policy.fee_bps
                || args.budget_cents > policy.budget_cents
                || args.period_seconds < policy.period_seconds;
            if credit_terms_change {
                let current = policy.authorizer;
                require!(
                    ctx.remaining_accounts
                        .first()
                        .is_some_and(|a| a.is_signer && a.key() == current),
                    CardPolicyError::CoSignerRequired
                );
            }
            if args.budget_cents < policy.budget_cents {
                let committed = period
                    .captured_cents
                    .checked_add(period.reserved_cents)
                    .ok_or(error!(CardPolicyError::MathOverflow))?;
                require!(
                    args.budget_cents >= committed,
                    CardPolicyError::BudgetBelowCommitted
                );
            }
        }
    }

    let policy = &mut ctx.accounts.policy;
    let membership_changes = policy.members[1] != args.authorizer;
    if policy.is_set() && policy.authorizer != args.authorizer {
        require!(
            policy.frozen,
            CardPolicyError::AuthorizerChangeRequiresFreeze
        );
    }
    if membership_changes {
        // First policy with a different key than init_permission, or a rotation
        // on a frozen card: the permission member list follows the authorizer.
        require!(
            !policy.members[2..policy.member_count as usize].contains(&args.authorizer),
            CardPolicyError::InvalidPolicy
        );
        policy.members[1] = args.authorizer;
    }

    apply_policy_args(policy, &args);
    policy.policy_version = policy
        .policy_version
        .checked_add(1)
        .ok_or(error!(CardPolicyError::MathOverflow))?;

    let period = &mut ctx.accounts.period;
    if period.period_index == 0 {
        period.period_index = 1;
        period.period_start = now;
        period.period_end = now
            .checked_add(args.period_seconds as i64)
            .ok_or(error!(CardPolicyError::MathOverflow))?;
    }
    let period_index = period.period_index;

    if membership_changes {
        sync_card_permissions(ctx.accounts)?;
    }

    let policy = &mut ctx.accounts.policy;
    let mut event = LedgerEvent::new(EV_POLICY_SET);
    event.amount_cents = policy.budget_cents;
    event.state_after = policy.frozen as u8;
    append_ledger(policy, event, period_index, now)
}
