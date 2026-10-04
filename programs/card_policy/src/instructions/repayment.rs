use crate::{
    constants::*,
    errors::CardPolicyError,
    hashes::{append_ledger, LedgerEvent},
    instructions::{common::*, FreezeCard},
    policy::sub,
};
use anchor_lang::prelude::*;

/// Authorizer only, after the statement is `partner_confirmed` off-chain
/// (contracts.md §4.2). The digest can be used once.
pub fn record_repayment(
    ctx: Context<FreezeCard>,
    statement_digest: [u8; 32],
    amount_cents: u64,
) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require_authorizer(&a.policy, &a.signer.key())?;
    require!(amount_cents > 0, CardPolicyError::InvalidAmount);
    require_event_id(&statement_digest)?;
    require!(
        !a.policy.repayment_digests.contains(&statement_digest),
        CardPolicyError::DuplicateRepayment
    );
    require!(
        amount_cents <= a.policy.statement_outstanding_cents,
        CardPolicyError::RepaymentExceedsOutstanding
    );
    a.policy.statement_outstanding_cents = sub(a.policy.statement_outstanding_cents, amount_cents)?;
    let slot = (a.policy.repayment_count as usize) % REPAYMENT_RING;
    a.policy.repayment_digests[slot] = statement_digest;
    a.policy.repayment_count = a.policy.repayment_count.wrapping_add(1);

    let mut event = LedgerEvent::new(EV_REPAYMENT);
    event.event_id_hash = statement_digest;
    event.amount_cents = amount_cents;
    append_ledger(&mut a.policy, event, a.period.period_index, now)
}
