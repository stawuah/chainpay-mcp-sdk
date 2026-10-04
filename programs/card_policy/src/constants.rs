use anchor_lang::prelude::*;

pub const CARD_BINDING_SEED: &[u8] = b"card_binding";
pub const CARD_POLICY_SEED: &[u8] = b"card_policy";
pub const CARD_PERIOD_SEED: &[u8] = b"card_period";
pub const RESERVATION_SEED: &[u8] = b"res";
pub const INTENT_SEED: &[u8] = b"intent";
pub const CARD_COMMITMENT_SEED: &[u8] = b"card_commit";
/// Per-card replay guard for closed reservations (ephemeral, PER only).
pub const AUTH_GUARD_SEED: &[u8] = b"auth_guard";

/// Delegation-program escrow index used for the checkpoint Magic Action.
pub const ACTION_ESCROW_INDEX: u8 = 255;

/// MagicBlock Devnet TEE validator. `delegate_card` rejects every other
/// validator; the list is upgradeable with the program.
pub const TEE_VALIDATOR_ALLOWLIST: [Pubkey; 1] =
    [pubkey!("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo")];

pub const MAX_MERCHANTS: usize = 8;
pub const MAX_MCCS: usize = 16;
/// owner + authorizer + 4 finance readers
pub const MAX_MEMBERS: usize = 6;
pub const CAPTURE_RING: usize = 8;
pub const REPAYMENT_RING: usize = 8;
/// Recent issuer event ids (reverse, refund, dispute, exception, resolve).
pub const EVENT_RING: usize = 16;
/// `auth_id_hash`es of the most recently closed reservations. A duplicate
/// issuer authorization is rejected on-chain while its Reservation exists and
/// for the next `GUARD_RING` reservation closes on the same card after that
/// (contracts.md, Changelog final fixes: replay window).
pub const GUARD_RING: usize = 256;

/// $10,000.00 sandbox cap.
pub const MAX_BUDGET_CENTS: u64 = 1_000_000;
pub const MIN_PERIOD_SECONDS: u32 = 86_400;
pub const MAX_FEE_BPS: u16 = 1_000;
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_INTENT_TTL_SECONDS: i64 = 600;
/// Sandbox hold lifetime [VERIFY-1C].
pub const HOLD_TTL_SECONDS: i64 = 7 * 86_400;
pub const USD: [u8; 3] = *b"USD";

pub const ISSUER_LITHIC_SANDBOX: u8 = 1;
pub const ISSUER_CARD_SIM: u8 = 2;

// Domain separators (contracts.md §1.6).
pub const LEDGER_DOMAIN: &[u8] = b"chainpay-card-ledger:v1\n";
pub const LEAF_DOMAIN: &[u8] = b"chainpay-card-leaf:v1\n";
/// Hash chain over every closed reservation's final numbers (`AuthGuard.closed_head`).
pub const CLOSED_DOMAIN: &[u8] = b"chainpay-card-closed:v1\n";

// Freeze reasons.
pub const FREEZE_NONE: u8 = 0;
pub const FREEZE_OWNER: u8 = 1;
pub const FREEZE_AUTHORIZER_SAFETY: u8 = 2;
pub const FREEZE_RECOVERY: u8 = 3;
pub const FREEZE_EXPIRY: u8 = 4;

// Recovery states.
pub const RECOVERY_NORMAL: u8 = 0;
pub const RECOVERY_FROZEN: u8 = 1;
pub const RECOVERY_RESTORED_PENDING: u8 = 2;

// Binding status.
pub const BINDING_ACTIVE: u8 = 0;
pub const BINDING_CLOSED: u8 = 2;

// Reservation flags.
pub const FLAG_LATE_CAPTURE: u8 = 1 << 0;
pub const FLAG_OVER_CAPTURE: u8 = 1 << 1;
pub const FLAG_SINGLE_MESSAGE: u8 = 1 << 2;
pub const FLAG_RECURRING: u8 = 1 << 3;

// Intent states.
pub const INTENT_OPEN: u8 = 0;
pub const INTENT_CONSUMED: u8 = 1;
pub const INTENT_CANCELLED: u8 = 3;

// Exception kinds (record_exception).
pub const EXC_FORCED_CAPTURE: u8 = 1;
pub const EXC_OVER_CAPTURE: u8 = 2;
pub const EXC_OVER_HOLD: u8 = 3;
pub const EXC_CORRECTION_DEBIT: u8 = 4;
pub const EXC_CORRECTION_CREDIT: u8 = 5;
pub const EXC_RETURN_REVERSAL: u8 = 6;
pub const EXC_UNPAIRED_CAPTURE: u8 = 7;
/// Appended in final fixes: a clearing after the hold was reversed or expired
/// and its Reservation closed. Same accounting as `capture`'s late path
/// (spend + exposure, no hold, no owner review); needs no Reservation.
pub const EXC_LATE_CAPTURE: u8 = 8;

// Ledger event kinds (contracts.md §1.6; 16 and 17 appended in Phase 1A).
pub const EV_AUTHORIZE: u8 = 1;
pub const EV_CAPTURE: u8 = 2;
pub const EV_REVERSE: u8 = 3;
pub const EV_REFUND: u8 = 4;
pub const EV_DISPUTE: u8 = 5;
pub const EV_EXCEPTION: u8 = 6;
pub const EV_ROLL: u8 = 7;
pub const EV_FREEZE: u8 = 8;
pub const EV_UNFREEZE: u8 = 9;
pub const EV_POLICY_SET: u8 = 10;
pub const EV_PERMISSION_CHANGE: u8 = 11;
pub const EV_RECOVERY_FREEZE: u8 = 12;
pub const EV_RESTORE: u8 = 13;
pub const EV_ADJUST: u8 = 14;
pub const EV_REPAYMENT: u8 = 15;
pub const EV_RESOLVE_EXCEPTION: u8 = 16;
pub const EV_CONFIRM_RECONCILED: u8 = 17;
/// Appended in final fixes: a terminal reservation was closed (rent returned).
pub const EV_CLOSE_RESERVATION: u8 = 18;

// Dispute states (Reservation.dispute_state).
pub const DISPUTE_OPEN: u8 = 1;
