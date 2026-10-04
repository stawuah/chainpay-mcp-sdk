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
    /// Every capture id of this hold: `capture` refuses one more than fits
    /// (`CaptureLimit`), so a retried capture can never land twice.
    pub capture_ids: [[u8; 32]; CAPTURE_RING],
    // ---- appended in review fixes (2026-10-04) ----
    /// The checkout intent's `max_amount_cents`: an `adjust_reservation`
    /// increase never takes the hold past what the agent was approved for.
    pub max_amount_cents: u64,
}

/// PER-only ephemeral account, private. Created on the card's first
/// `close_reservation` (sponsor = `CardPolicy`). Keeps replay protection after
/// a terminal Reservation is closed and its rent returned: `authorize` rejects
/// any `auth_id_hash` still in `recent`. `closed_head` chains every closed
/// reservation's final numbers, so the closed set stays auditable.
///
/// Zero-copy (`bytemuck`, `repr(C)`): at 8 KB it is twice the SBF stack frame,
/// so it is never Borsh-deserialized on-chain (see `guard_bytes`).
#[account(zero_copy)]
pub struct AuthGuard {
    pub policy: Pubkey,
    pub closed_count: u64,
    pub closed_head: [u8; 32],
    pub recent: [[u8; 32]; GUARD_RING],
    pub bump: u8,
    pub _padding: [u8; 7],
}

impl AuthGuard {
    pub fn contains(&self, auth_id_hash: &[u8; 32]) -> bool {
        self.recent.iter().any(|h| h == auth_id_hash)
    }
}

/// In-place access to an `AuthGuard`'s bytes. The account is 8 KB, twice the
/// SBF stack frame, so the program never deserializes it: it checks the
/// discriminator and owner fields and reads/writes slots where they lie.
/// Layout (Borsh, fixed): disc 8 | policy 32 | closed_count u64 | closed_head 32
/// | recent 32 x GUARD_RING | bump u8.
pub mod guard_bytes {
    use super::AuthGuard;
    use crate::constants::GUARD_RING;
    use anchor_lang::{prelude::Pubkey, Discriminator};

    const POLICY: usize = 8;
    const COUNT: usize = POLICY + 32;
    const HEAD: usize = COUNT + 8;
    const RECENT: usize = HEAD + 32;
    const BUMP: usize = RECENT + 32 * GUARD_RING;
    /// bump + 7 bytes of `repr(C)` padding.
    pub const LEN: usize = BUMP + 8;

    /// The guard's policy, when `data` is a well-formed AuthGuard.
    pub fn policy(data: &[u8]) -> Option<Pubkey> {
        if data.len() < LEN || !data.starts_with(AuthGuard::DISCRIMINATOR) {
            return None;
        }
        Some(Pubkey::new_from_array(data[POLICY..COUNT].try_into().ok()?))
    }

    pub fn bump(data: &[u8]) -> u8 {
        data[BUMP]
    }

    pub fn closed_count(data: &[u8]) -> u64 {
        u64::from_le_bytes(data[COUNT..HEAD].try_into().expect("8 bytes"))
    }

    pub fn closed_head(data: &[u8]) -> [u8; 32] {
        data[HEAD..RECENT].try_into().expect("32 bytes")
    }

    pub fn contains(data: &[u8], auth_id_hash: &[u8; 32]) -> bool {
        data[RECENT..BUMP]
            .chunks_exact(32)
            .any(|slot| slot == auth_id_hash)
    }

    /// Writes a fresh, empty guard into zeroed account data.
    pub fn init(data: &mut [u8], policy: &Pubkey, bump: u8) {
        data[..8].copy_from_slice(AuthGuard::DISCRIMINATOR);
        data[POLICY..COUNT].copy_from_slice(policy.as_ref());
        data[COUNT..LEN].fill(0);
        data[BUMP] = bump;
    }

    /// Records one closed reservation: ring slot, count, hash chain.
    pub fn push(data: &mut [u8], auth_id_hash: &[u8; 32], head: &[u8; 32], count: u64) {
        let slot = RECENT + 32 * (closed_count(data) % GUARD_RING as u64) as usize;
        data[slot..slot + 32].copy_from_slice(auth_id_hash);
        data[COUNT..HEAD].copy_from_slice(&count.to_le_bytes());
        data[HEAD..RECENT].copy_from_slice(head);
    }
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
