use crate::{
    constants::*,
    errors::CardPolicyError,
    hashes::{append_ledger, LedgerEvent},
    instructions::common::*,
    state::{reservation_state, CardPeriod, CardPolicy, Reservation},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RollPeriod<'info> {
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
}

/// Remaining accounts: writable reservations whose holds may have expired.
/// Resets the purchase allowance only. Open holds (`reserved_cents`) and credit
/// exposure (`statement_outstanding_cents`) carry over.
pub fn roll_period<'info>(ctx: Context<'info, RollPeriod<'info>>) -> Result<()> {
    let now = now()?;
    let policy_key = ctx.accounts.policy.key();
    require_authorizer(&ctx.accounts.policy, &ctx.accounts.authorizer.key())?;
    require!(
        now >= ctx.accounts.period.period_end,
        CardPolicyError::PeriodNotEnded
    );

    for info in ctx.remaining_accounts.iter() {
        require!(info.is_writable, CardPolicyError::InvalidAccount);
        let mut reservation = Account::<Reservation>::try_from(info)?;
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
        require!(expected == *info.key, CardPolicyError::InvalidAccount);
        if reservation_state::is_open(reservation.state) && now >= reservation.hold_expires_at {
            let released = reservation.amount_reserved_cents;
            let period = &mut ctx.accounts.period;
            period.reserved_cents = period.reserved_cents.saturating_sub(released);
            reservation.amount_reserved_cents = 0;
            reservation.state = reservation_state::EXPIRED;
            let mut event = LedgerEvent::new(EV_REVERSE);
            event.auth_id_hash = reservation.auth_id_hash;
            event.amount_cents = released;
            event.state_after = reservation_state::EXPIRED;
            let period_index = period.period_index;
            append_ledger(&mut ctx.accounts.policy, event, period_index, now)?;
            reservation.exit(&crate::ID)?;
        }
    }

    let period_seconds = ctx.accounts.policy.period_seconds as i64;
    let period = &mut ctx.accounts.period;
    period.period_index = period
        .period_index
        .checked_add(1)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    period.period_start = now;
    period.period_end = now
        .checked_add(period_seconds)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    period.captured_cents = 0;
    period.refunded_cents = 0;
    period.purchases_count = 0;
    period.exception_cents = 0;
    let period_index = period.period_index;

    let mut event = LedgerEvent::new(EV_ROLL);
    event.amount_cents = ctx.accounts.period.reserved_cents;
    append_ledger(&mut ctx.accounts.policy, event, period_index, now)
}
