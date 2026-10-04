//! ChainPay private agent cards: card policy on a MagicBlock Private Ephemeral
//! Rollup (contracts.md §1). Policy and spend state live in accounts delegated
//! to the TEE validator for the card's whole life and are never committed.
//!
//! Privacy rule for this crate: never `msg!` a policy value, amount, merchant or
//! period counter. Permission members can read program logs (CD-5).

#![allow(ambiguous_glob_reexports)]
#![allow(clippy::too_many_arguments)]

use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::anchor::ephemeral;

pub mod constants;
pub mod er;
pub mod errors;
pub mod hashes;
pub mod instructions;
pub mod policy;
pub mod state;

use instructions::*;
use policy::{AuthorizeArgs, IntentArgs, PolicyArgs};

declare_id!("Cz9vYKFZFwx8Bqag95xZtw8dqUjS4k9AoyMh1pFo82F");

#[ephemeral]
#[program]
pub mod card_policy {
    use super::*;

    // 1 · base
    pub fn init_card(
        ctx: Context<InitCard>,
        card_id: [u8; 32],
        issuer: u8,
        issuer_card_ref_hash: [u8; 32],
        prefund_lamports: u64,
    ) -> Result<()> {
        instructions::card::init_card(ctx, card_id, issuer, issuer_card_ref_hash, prefund_lamports)
    }

    // 2 · base
    pub fn delegate_card(ctx: Context<DelegateCard>, validator: Pubkey) -> Result<()> {
        instructions::card::delegate_card(ctx, validator)
    }

    // 3 · PER
    pub fn init_permission(ctx: Context<CardPermissions>, authorizer: Pubkey) -> Result<()> {
        instructions::permission::init_permission(ctx, authorizer)
    }

    // 4 · PER
    pub fn update_permission<'info>(
        ctx: Context<'info, CardPermissions<'info>>,
        op: PermissionOp,
    ) -> Result<()> {
        instructions::permission::update_permission(ctx, op)
    }

    // 5 · PER
    pub fn sync_permission(ctx: Context<SyncPermission>) -> Result<()> {
        instructions::permission::sync_permission(ctx)
    }

    // 6 · PER
    pub fn set_policy(ctx: Context<CardPermissions>, args: PolicyArgs) -> Result<()> {
        instructions::set_policy::set_policy(ctx, args)
    }

    // 7 · PER
    pub fn open_checkout_intent(ctx: Context<OpenCheckoutIntent>, args: IntentArgs) -> Result<()> {
        instructions::intent::open_checkout_intent(ctx, args)
    }

    // 8 · PER
    pub fn cancel_checkout_intent(ctx: Context<CancelCheckoutIntent>) -> Result<()> {
        instructions::intent::cancel_checkout_intent(ctx)
    }

    // 9 · PER
    pub fn authorize(ctx: Context<Authorize>, args: AuthorizeArgs) -> Result<()> {
        instructions::authorize::authorize(ctx, args)
    }

    // 10 · PER
    pub fn adjust_reservation(ctx: Context<ReservationEvent>, new_amount_cents: u64) -> Result<()> {
        instructions::lifecycle::adjust_reservation(ctx, new_amount_cents)
    }

    // 11 · PER
    pub fn capture(
        ctx: Context<ReservationEvent>,
        amount_cents: u64,
        capture_id_hash: [u8; 32],
    ) -> Result<()> {
        instructions::lifecycle::capture(ctx, amount_cents, capture_id_hash)
    }

    // 12 · PER
    pub fn reverse(
        ctx: Context<ReservationEvent>,
        amount_cents: u64,
        reason: u8,
        event_id_hash: [u8; 32],
    ) -> Result<()> {
        instructions::lifecycle::reverse(ctx, amount_cents, reason, event_id_hash)
    }

    // 13 · PER
    pub fn refund(
        ctx: Context<CardEvent>,
        amount_cents: u64,
        event_id_hash: [u8; 32],
    ) -> Result<()> {
        instructions::lifecycle::refund(ctx, amount_cents, event_id_hash)
    }

    // 14 · PER
    pub fn record_dispute(
        ctx: Context<ReservationEvent>,
        state: u8,
        event_id_hash: [u8; 32],
    ) -> Result<()> {
        instructions::lifecycle::record_dispute(ctx, state, event_id_hash)
    }

    // 15 · PER
    pub fn record_exception(
        ctx: Context<CardEvent>,
        kind: u8,
        amount_cents: u64,
        event_id_hash: [u8; 32],
    ) -> Result<()> {
        instructions::lifecycle::record_exception(ctx, kind, amount_cents, event_id_hash)
    }

    // 16 · PER
    pub fn resolve_exception(
        ctx: Context<OwnerCardEvent>,
        event_id_hash: [u8; 32],
        resolution: u8,
    ) -> Result<()> {
        instructions::lifecycle::resolve_exception(ctx, event_id_hash, resolution)
    }

    // 17 · PER
    pub fn roll_period<'info>(ctx: Context<'info, RollPeriod<'info>>) -> Result<()> {
        instructions::period::roll_period(ctx)
    }

    // 18 · PER
    pub fn freeze(ctx: Context<FreezeCard>, reason: u8) -> Result<()> {
        instructions::freeze::freeze(ctx, reason)
    }

    // 19 · PER
    pub fn unfreeze(ctx: Context<OwnerCardEvent>) -> Result<()> {
        instructions::freeze::unfreeze(ctx)
    }

    // 20 · PER
    pub fn recovery_freeze(ctx: Context<FreezeCard>, reason: u8) -> Result<()> {
        instructions::freeze::recovery_freeze(ctx, reason)
    }

    // 21 · PER
    pub fn restore(ctx: Context<RestoreCard>, args: RestoreArgs) -> Result<()> {
        instructions::freeze::restore(ctx, args)
    }

    // 22 · PER
    pub fn confirm_reconciled(ctx: Context<OwnerCardEvent>, recon_digest: [u8; 32]) -> Result<()> {
        instructions::freeze::confirm_reconciled(ctx, recon_digest)
    }

    // 23 · PER
    pub fn checkpoint(ctx: Context<Checkpoint>, master_salt: [u8; 32], seq: u64) -> Result<()> {
        instructions::commitment::checkpoint(ctx, master_salt, seq)
    }

    // 24 · base (Magic Action)
    pub fn write_commitment(
        ctx: Context<WriteCommitment>,
        root: [u8; 32],
        seq: u64,
        policy_version: u32,
        period_index: u32,
    ) -> Result<()> {
        instructions::commitment::write_commitment(ctx, root, seq, policy_version, period_index)
    }

    // 25 · PER
    pub fn wipe_card<'info>(ctx: Context<'info, WipeCard<'info>>) -> Result<()> {
        instructions::card::wipe_card(ctx)
    }

    // 26 · base
    pub fn close_card(ctx: Context<CloseCard>) -> Result<()> {
        instructions::card::close_card(ctx)
    }

    // 28 · PER (appended in 1A)
    pub fn close_checkout_intent(ctx: Context<CloseCheckoutIntent>) -> Result<()> {
        instructions::intent::close_checkout_intent(ctx)
    }

    // 29 · PER (appended in final fixes)
    pub fn close_reservation(ctx: Context<CloseReservation>) -> Result<()> {
        instructions::close_reservation::close_reservation(ctx)
    }

    // 27 · PER
    pub fn record_repayment(
        ctx: Context<FreezeCard>,
        statement_digest: [u8; 32],
        amount_cents: u64,
    ) -> Result<()> {
        instructions::repayment::record_repayment(ctx, statement_digest, amount_cents)
    }
}
