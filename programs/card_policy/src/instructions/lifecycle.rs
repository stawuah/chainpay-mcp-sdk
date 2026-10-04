//! Issuer lifecycle events after an authorization. These post issuer truth, so
//! they are never blocked by a freeze (only new spending is).

use crate::{
    constants::*,
    errors::CardPolicyError,
    hashes::{append_ledger, LedgerEvent},
    instructions::common::*,
    policy::{
        add, add_exposure, available, is_expired, reduce_exposure, require_billable,
        require_refundable, sub,
    },
    state::{reservation_state, CardPeriod, CardPolicy, Reservation},
};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct ReservationEvent<'info> {
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
    #[account(
        mut,
        seeds = [RESERVATION_SEED, policy.key().as_ref(), reservation.auth_id_hash.as_ref()],
        bump = reservation.bump,
        constraint = reservation.policy == policy.key() @ CardPolicyError::InvalidAccount,
    )]
    pub reservation: Box<Account<'info, Reservation>>,
}

#[derive(Accounts)]
pub struct CardEvent<'info> {
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
    #[account(
        mut,
        seeds = [RESERVATION_SEED, policy.key().as_ref(), reservation.auth_id_hash.as_ref()],
        bump = reservation.bump,
        constraint = reservation.policy == policy.key() @ CardPolicyError::InvalidAccount,
    )]
    pub reservation: Option<Box<Account<'info, Reservation>>>,
}

fn event(
    kind: u8,
    reservation: Option<&Reservation>,
    event_id_hash: [u8; 32],
    amount: u64,
    state_after: u8,
) -> LedgerEvent {
    let mut e = LedgerEvent::new(kind);
    if let Some(r) = reservation {
        e.auth_id_hash = r.auth_id_hash;
    }
    e.event_id_hash = event_id_hash;
    e.amount_cents = amount;
    e.state_after = state_after;
    e
}

/// Releases up to `amount` of the open hold; returns what was released.
fn release_hold(
    period: &mut CardPeriod,
    reservation: &mut Reservation,
    amount: u64,
) -> Result<u64> {
    let released = amount.min(reservation.amount_reserved_cents);
    reservation.amount_reserved_cents = sub(reservation.amount_reserved_cents, released)?;
    // Saturating: after an owner+authorizer restore the period total can sit
    // below the live holds; issuer events must still post, never brick.
    period.reserved_cents = period.reserved_cents.saturating_sub(released);
    Ok(released)
}

// ------------------------------------------------------- adjust_reservation

pub fn adjust_reservation(ctx: Context<ReservationEvent>, new_amount_cents: u64) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require_authorizer(&a.policy, &a.authorizer.key())?;
    require!(
        reservation_state::is_open(a.reservation.state),
        CardPolicyError::ReservationClosed
    );
    let hold = a.reservation.amount_reserved_cents;
    if new_amount_cents < hold {
        release_hold(&mut a.period, &mut a.reservation, hold - new_amount_cents)?;
    } else if new_amount_cents > hold {
        // An increase is new spending: it must fit, and never on a frozen card.
        // When it does not, the issuer hold stays and Axum records
        // `record_exception(over_hold)`.
        require!(!a.policy.frozen, CardPolicyError::CardFrozen);
        require!(
            a.policy.recovery_state == RECOVERY_NORMAL,
            CardPolicyError::RecoveryFrozen
        );
        require!(!is_expired(&a.policy, now), CardPolicyError::PolicyExpired);
        require!(
            add(new_amount_cents, a.reservation.captured_cents)? <= a.policy.max_purchase_cents,
            CardPolicyError::AmountExceedsMax
        );
        // Nor past the checkout intent the agent was approved for.
        require!(
            add(new_amount_cents, a.reservation.captured_cents)? <= a.reservation.max_amount_cents,
            CardPolicyError::AmountExceedsMax
        );
        let delta = new_amount_cents - hold;
        require!(
            delta <= available(&a.policy, &a.period)?,
            CardPolicyError::BudgetExceeded
        );
        a.period.reserved_cents = add(a.period.reserved_cents, delta)?;
        a.reservation.amount_reserved_cents = new_amount_cents;
    }
    if a.reservation.amount_reserved_cents == 0 {
        a.reservation.state = if a.reservation.captured_cents > 0 {
            reservation_state::CAPTURED
        } else {
            reservation_state::REVERSED
        };
    }
    let e = event(
        EV_ADJUST,
        Some(&a.reservation),
        [0u8; 32],
        new_amount_cents,
        a.reservation.state,
    );
    append_ledger(&mut a.policy, e, a.period.period_index, now)
}

// ------------------------------------------------------------------ capture

pub fn capture(
    ctx: Context<ReservationEvent>,
    amount_cents: u64,
    capture_id_hash: [u8; 32],
) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require_authorizer(&a.policy, &a.authorizer.key())?;
    require!(amount_cents > 0, CardPolicyError::InvalidAmount);
    require_event_id(&capture_id_hash)?;
    require!(
        !a.reservation.capture_ids.contains(&capture_id_hash),
        CardPolicyError::DuplicateCapture
    );
    // Every capture id of the hold stays in the ring, so the duplicate check
    // above is exact. A capture past the ring's size is refused, never
    // allowed to overwrite an id a retry could still carry (Axum books it for
    // review instead).
    require!(
        (a.reservation.capture_count as usize) < CAPTURE_RING,
        CardPolicyError::CaptureLimit
    );

    let state = a.reservation.state;
    if reservation_state::is_open(state) || state == reservation_state::CAPTURED {
        let from_hold = release_hold(&mut a.period, &mut a.reservation, amount_cents)?;
        let excess = amount_cents - from_hold;
        a.reservation.state = if a.reservation.amount_reserved_cents == 0 {
            reservation_state::CAPTURED
        } else {
            reservation_state::PARTIALLY_CAPTURED
        };
        if excess > 0 {
            // Captured above the approved hold: counted, flagged, never approved silently.
            a.reservation.flags |= FLAG_OVER_CAPTURE;
            a.period.exception_cents = add(a.period.exception_cents, excess)?;
            a.policy.exceptions_open = a
                .policy
                .exceptions_open
                .checked_add(1)
                .ok_or(error!(CardPolicyError::MathOverflow))?;
        }
    } else {
        // Clearing after the hold was reversed or expired: a late capture. It
        // counts as spend but never re-reserves.
        a.reservation.flags |= FLAG_LATE_CAPTURE;
    }
    // After the hold release: a capture inside its hold always fits; any
    // excess or late capture must fit the budget or is refused for review.
    require_billable(&a.policy, &a.period, amount_cents)?;
    a.period.captured_cents = add(a.period.captured_cents, amount_cents)?;
    a.reservation.captured_cents = add(a.reservation.captured_cents, amount_cents)?;
    add_exposure(&mut a.policy, amount_cents)?;

    let slot = a.reservation.capture_count as usize;
    a.reservation.capture_ids[slot] = capture_id_hash;
    a.reservation.capture_count += 1;

    let e = event(
        EV_CAPTURE,
        Some(&a.reservation),
        capture_id_hash,
        amount_cents,
        a.reservation.state,
    );
    append_ledger(&mut a.policy, e, a.period.period_index, now)
}

// ------------------------------------------------------------------ reverse

pub const REVERSE_VOID: u8 = 0;
pub const REVERSE_EXPIRY: u8 = 1;

pub fn reverse(
    ctx: Context<ReservationEvent>,
    amount_cents: u64,
    reason: u8,
    event_id_hash: [u8; 32],
) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require_authorizer(&a.policy, &a.authorizer.key())?;
    require!(amount_cents > 0, CardPolicyError::InvalidAmount);
    require!(
        reason == REVERSE_VOID || reason == REVERSE_EXPIRY,
        CardPolicyError::InvalidPolicy
    );
    record_event_id(&mut a.policy, &event_id_hash)?;
    require!(
        reservation_state::is_open(a.reservation.state),
        CardPolicyError::ReservationClosed
    );
    let released = release_hold(&mut a.period, &mut a.reservation, amount_cents)?;
    a.reservation.reversed_cents = add(a.reservation.reversed_cents, released)?;
    if a.reservation.amount_reserved_cents == 0 {
        // A hold that already captured money ends CAPTURED (as in
        // `adjust_reservation`): only the remainder was released.
        a.reservation.state = if a.reservation.captured_cents > 0 {
            reservation_state::CAPTURED
        } else if reason == REVERSE_EXPIRY {
            reservation_state::EXPIRED
        } else {
            reservation_state::REVERSED
        };
    }
    let e = event(
        EV_REVERSE,
        Some(&a.reservation),
        event_id_hash,
        released,
        a.reservation.state,
    );
    append_ledger(&mut a.policy, e, a.period.period_index, now)
}

// ------------------------------------------------------------------- refund

pub fn refund(ctx: Context<CardEvent>, amount_cents: u64, event_id_hash: [u8; 32]) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require_authorizer(&a.policy, &a.authorizer.key())?;
    require!(amount_cents > 0, CardPolicyError::InvalidAmount);
    record_event_id(&mut a.policy, &event_id_hash)?;
    // A refund is a credit against the statement. It does not restore budget:
    // the budget is a purchase allowance and `captured` stays unchanged.
    a.period.refunded_cents = add(a.period.refunded_cents, amount_cents)?;
    let mut state_after = 0;
    if let Some(reservation) = a.reservation.as_mut() {
        // Never more back than the hold captured. Without a Reservation (a
        // closed hold) Axum applies the same cap from its row before sending.
        require_refundable(
            reservation.captured_cents,
            reservation.refunded_cents,
            amount_cents,
        )?;
        reservation.refunded_cents = add(reservation.refunded_cents, amount_cents)?;
        state_after = reservation.state;
    }
    reduce_exposure(&mut a.policy, amount_cents)?;
    let e = event(
        EV_REFUND,
        a.reservation.as_deref().map(|r| &**r),
        event_id_hash,
        amount_cents,
        state_after,
    );
    append_ledger(&mut a.policy, e, a.period.period_index, now)
}

// ----------------------------------------------------------- record_dispute

pub const DISPUTE_WITHDRAWN: u8 = 4;

pub fn record_dispute(
    ctx: Context<ReservationEvent>,
    state: u8,
    event_id_hash: [u8; 32],
) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require_authorizer(&a.policy, &a.authorizer.key())?;
    require!(state <= DISPUTE_WITHDRAWN, CardPolicyError::InvalidPolicy);
    record_event_id(&mut a.policy, &event_id_hash)?;
    // Overlay only: money movement from a dispute arrives as a refund.
    a.reservation.dispute_state = state;
    let e = event(EV_DISPUTE, Some(&a.reservation), event_id_hash, 0, state);
    append_ledger(&mut a.policy, e, a.period.period_index, now)
}

// --------------------------------------------------------- record_exception

pub fn record_exception(
    ctx: Context<CardEvent>,
    kind: u8,
    amount_cents: u64,
    event_id_hash: [u8; 32],
) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require_authorizer(&a.policy, &a.authorizer.key())?;
    require!(
        (EXC_FORCED_CAPTURE..=EXC_LATE_CAPTURE).contains(&kind),
        CardPolicyError::InvalidPolicy
    );
    require!(amount_cents > 0, CardPolicyError::InvalidAmount);
    record_event_id(&mut a.policy, &event_id_hash)?;

    match kind {
        EXC_LATE_CAPTURE => {
            // Only for a closed hold: an open Reservation takes `capture`.
            require!(a.reservation.is_none(), CardPolicyError::InvalidAccount);
            require_billable(&a.policy, &a.period, amount_cents)?;
            a.period.captured_cents = add(a.period.captured_cents, amount_cents)?;
            add_exposure(&mut a.policy, amount_cents)?;
            let e = event(EV_EXCEPTION, None, event_id_hash, amount_cents, kind);
            return append_ledger(&mut a.policy, e, a.period.period_index, now);
        }
        EXC_OVER_HOLD => {
            // The issuer holds more than the policy allowed: track the real hold
            // so `available` stays honest, and flag it.
            let reservation = a
                .reservation
                .as_mut()
                .ok_or(error!(CardPolicyError::InvalidAccount))?;
            require!(
                reservation_state::is_open(reservation.state),
                CardPolicyError::ReservationClosed
            );
            reservation.amount_reserved_cents =
                add(reservation.amount_reserved_cents, amount_cents)?;
            a.period.reserved_cents = add(a.period.reserved_cents, amount_cents)?;
            a.period.exception_cents = add(a.period.exception_cents, amount_cents)?;
        }
        EXC_CORRECTION_CREDIT => {
            a.period.refunded_cents = add(a.period.refunded_cents, amount_cents)?;
            if let Some(reservation) = a.reservation.as_mut() {
                reservation.refunded_cents = add(reservation.refunded_cents, amount_cents)?;
            }
            reduce_exposure(&mut a.policy, amount_cents)?;
        }
        _ => {
            // Debits (forced capture, over-capture, correction debit, return
            // reversal, unpaired capture) count as spend and as exposure, and
            // only while they fit the budget (review X1).
            require_billable(&a.policy, &a.period, amount_cents)?;
            a.period.captured_cents = add(a.period.captured_cents, amount_cents)?;
            a.period.exception_cents = add(a.period.exception_cents, amount_cents)?;
            if let Some(reservation) = a.reservation.as_mut() {
                reservation.captured_cents = add(reservation.captured_cents, amount_cents)?;
                if kind == EXC_OVER_CAPTURE {
                    reservation.flags |= FLAG_OVER_CAPTURE;
                }
            }
            add_exposure(&mut a.policy, amount_cents)?;
        }
    }
    a.policy.exceptions_open = a
        .policy
        .exceptions_open
        .checked_add(1)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    let e = event(
        EV_EXCEPTION,
        a.reservation.as_deref().map(|r| &**r),
        event_id_hash,
        amount_cents,
        kind,
    );
    append_ledger(&mut a.policy, e, a.period.period_index, now)
}

// -------------------------------------------------------- resolve_exception

#[derive(Accounts)]
pub struct OwnerCardEvent<'info> {
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
}

pub fn resolve_exception(
    ctx: Context<OwnerCardEvent>,
    event_id_hash: [u8; 32],
    resolution: u8,
) -> Result<()> {
    let now = now()?;
    let a = ctx.accounts;
    require_event_id(&event_id_hash)?;
    // The exception's own id is already in the ring; dedupe the resolution
    // under a separate domain so a retried resolve cannot close two.
    let resolve_key =
        solana_sha256_hasher::hashv(&[b"chainpay-card-resolve:v1\n", &event_id_hash]).to_bytes();
    record_event_id(&mut a.policy, &resolve_key)?;
    require!(
        a.policy.exceptions_open > 0,
        CardPolicyError::NoOpenExceptions
    );
    a.policy.exceptions_open -= 1;
    let e = event(EV_RESOLVE_EXCEPTION, None, event_id_hash, 0, resolution);
    append_ledger(&mut a.policy, e, a.period.period_index, now)
}
