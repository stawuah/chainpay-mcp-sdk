use crate::constants::*;
use anchor_lang::prelude::*;

/// Base layer, never delegated, public. Owner <-> card link, no sensitive fields.
#[account]
#[derive(InitSpace)]
pub struct CardBinding {
    pub version: u8,
    pub owner: Pubkey,
    pub card_id: [u8; 32],
    pub issuer: u8,
    pub issuer_card_ref_hash: [u8; 32],
    pub policy: Pubkey,
    pub period: Pubkey,
    pub commitment: Pubkey,
    pub status: u8,
    pub created_at: i64,
    pub bump: u8,
}

/// Delegated to the TEE validator, private. Created zeroed on base apart from
/// `binding`, `owner` and `bump` (already public through `CardBinding`).
#[account]
#[derive(InitSpace)]
pub struct CardPolicy {
    pub binding: Pubkey,
    pub owner: Pubkey,
    pub authorizer: Pubkey,
    pub policy_version: u32,
    pub budget_cents: u64,
    pub max_purchase_cents: u64,
    pub max_purchases_per_period: u16,
    pub period_seconds: u32,
    pub currency: [u8; 3],
    pub merchant_count: u8,
    pub merchant_id_hashes: [[u8; 32]; MAX_MERCHANTS],
    pub mcc_count: u8,
    pub mccs: [u16; MAX_MCCS],
    pub expires_at: i64,
    pub recurring_allowed: bool,
    pub fee_bps: u16,
    pub frozen: bool,
    pub freeze_reason: u8,
    pub recovery_state: u8,
    pub statement_outstanding_cents: u64,
    pub exceptions_open: u16,
    pub member_count: u8,
    pub members: [Pubkey; MAX_MEMBERS],
    pub member_flags: [u8; MAX_MEMBERS],
    pub ledger_head: [u8; 32],
    pub ledger_seq: u64,
    pub commit_seq: u64,
    pub bump: u8,
    // ---- appended in Phase 1A (contracts.md changelog) ----
    /// Digest the owner signed in `restore`; `confirm_reconciled` must match it.
    pub recon_digest: [u8; 32],
    /// Last statement digests passed to `record_repayment` (replay guard).
    pub repayment_digests: [[u8; 32]; REPAYMENT_RING],
    pub repayment_count: u8,
    /// Last issuer event ids applied by reverse/refund/dispute/exception/resolve.
    /// Guards against a retried transaction landing twice.
    pub event_ids: [[u8; 32]; EVENT_RING],
    pub event_count: u8,
    /// Live ephemeral accounts (intents + reservations). `wipe_card` needs 0.
    pub ephemeral_count: u16,
}

impl CardPolicy {
    pub fn is_set(&self) -> bool {
        self.authorizer != Pubkey::default()
    }

    pub fn merchants(&self) -> &[[u8; 32]] {
        &self.merchant_id_hashes[..self.merchant_count as usize]
    }

    pub fn mcc_list(&self) -> &[u16] {
        &self.mccs[..self.mcc_count as usize]
    }

    pub fn member_list(&self) -> &[Pubkey] {
        &self.members[..self.member_count as usize]
    }
}

/// Delegated, private. Current-period counters.
#[account]
#[derive(InitSpace)]
pub struct CardPeriod {
    pub policy: Pubkey,
    pub period_index: u32,
    pub period_start: i64,
    pub period_end: i64,
    pub captured_cents: u64,
    pub reserved_cents: u64,
    pub refunded_cents: u64,
    pub purchases_count: u16,
    pub exception_cents: u64,
    pub bump: u8,
}

/// Reservation lifecycle (contracts.md §4.1). `pending`, `declined` and
/// `ambiguous` are off-chain states and never appear here.
pub mod reservation_state {
    pub const RESERVED: u8 = 1;
    pub const PARTIALLY_CAPTURED: u8 = 2;
    pub const CAPTURED: u8 = 3;
    pub const REVERSED: u8 = 4;
    pub const EXPIRED: u8 = 5;

    pub fn is_open(state: u8) -> bool {
        state == RESERVED || state == PARTIALLY_CAPTURED
    }
}

/// PER-only ephemeral account, private. PDA existence is the replay guard.
#[account]
#[derive(InitSpace)]
pub struct Reservation {
    pub policy: Pubkey,
    pub auth_id_hash: [u8; 32],
    pub intent: Pubkey,
    pub period_index: u32,
    /// Open hold still reserved against the budget.
    pub amount_reserved_cents: u64,
    pub captured_cents: u64,
    pub reversed_cents: u64,
    pub refunded_cents: u64,
    pub state: u8,
    pub dispute_state: u8,
    pub flags: u8,
    pub created_at: i64,
    pub hold_expires_at: i64,
    pub bump: u8,
    // ---- appended in Phase 1A (contracts.md changelog) ----
    pub capture_count: u8,
    pub capture_ids: [[u8; 32]; CAPTURE_RING],
}

/// PER-only ephemeral account, private. What the agent may buy, once.
#[account]
#[derive(InitSpace)]
pub struct CheckoutIntent {
    pub policy: Pubkey,
    pub intent_id: [u8; 16],
    pub agent: Pubkey,
    pub merchant_id_hash: [u8; 32],
    pub mcc: u16,
    pub max_amount_cents: u64,
    pub currency: [u8; 3],
    pub policy_version: u32,
    pub expires_at: i64,
    pub state: u8,
    pub reservation: Pubkey,
    pub bump: u8,
}

/// Base layer, never delegated, public. Written only by the checkpoint Magic Action.
#[account]
#[derive(InitSpace)]
pub struct CardCommitment {
    pub binding: Pubkey,
    pub seq: u64,
    pub root: [u8; 32],
    pub policy_version: u32,
    pub period_index: u32,
    pub written_slot: u64,
    pub bump: u8,
}
