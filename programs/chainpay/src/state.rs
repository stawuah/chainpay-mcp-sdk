use anchor_lang::prelude::*;

/// Marks the reserved compatibility field when it stores a mandate nonce
/// rather than a legacy fixed recipient. The prefix lets the program keep
/// reading older accounts without changing their serialized size.
pub const MANDATE_NONCE_PREFIX: [u8; 8] = *b"CPNONCE!";

pub fn is_mandate_nonce(value: &Pubkey) -> bool {
    value.to_bytes()[..MANDATE_NONCE_PREFIX.len()] == MANDATE_NONCE_PREFIX
}

#[account]
pub struct ProtocolConfig {
    pub authority: Pubkey,
    pub supported_mints: [Pubkey; 3],
    pub bump: u8,
}

impl ProtocolConfig {
    pub const MAX_SUPPORTED_MINTS: usize = 3;
    pub const LEN: usize = 32 * 4 + 1;
}

#[account]
pub struct SupportedAsset {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub enabled: bool,
    pub bump: u8,
}

impl SupportedAsset {
    pub const LEN: usize = 32 * 3 + 2;
}

#[account]
pub struct PaymentMandate {
    pub owner: Pubkey,
    pub approved_agent: Pubkey,
    pub source_token_account: Pubkey,
    pub allowed_mint: Pubkey,
    /// Reserved for compatibility with mandates created before dynamic
    /// recipients. New mandates leave this as Pubkey::default().
    pub legacy_allowed_recipient: Pubkey,
    pub max_per_payment: u64,
    pub total_limit: u64,
    pub amount_spent: u64,
    pub payment_count: u64,
    pub expires_at_slot: u64,
    pub max_payment_count: u64,
    pub cooldown_slots: u64,
    pub last_payment_slot: u64,
    pub paused: bool,
    pub revoked: bool,
    pub bump: u8,
}

impl PaymentMandate {
    pub const LEN: usize = 32 * 5 + 8 * 8 + 3;
}

#[account]
pub struct PaymentReceipt {
    pub mandate: Pubkey,
    pub invoice_hash: [u8; 32],
    pub payment_id: [u8; 32],
    pub mint: Pubkey,
    pub source_token_account: Pubkey,
    pub recipient_token_account: Pubkey,
    pub amount: u64,
    pub agent: Pubkey,
    pub executed_at_slot: u64,
    pub signature_reference: [u8; 32],
    pub status: u8,
    pub bump: u8,
    // Snapshot of the mandate policy in force when this payment executed.
    // Appended after `bump` so every earlier byte offset is unchanged and
    // older 282-byte receipts still decode up to `bump`.
    pub snapshot_version: u8,
    pub policy_max_per_payment: u64,
    pub policy_total_limit: u64,
    /// Mandate `amount_spent` including this payment.
    pub policy_amount_spent_after: u64,
    /// Mandate `payment_count` including this payment.
    pub policy_payment_count_after: u64,
    pub policy_max_payment_count: u64,
    pub policy_expires_at_slot: u64,
    pub policy_cooldown_slots: u64,
    /// Zeroed. Reserved for a future delivery-attestation field.
    pub reserved: [u8; 32],
}

impl PaymentReceipt {
    // Five Pubkeys plus three 32-byte hashes/references, two u64 values, and
    // the status/bump bytes; then the snapshot version byte, seven u64 policy
    // values, and 32 reserved bytes.
    pub const LEN: usize = 32 * 8 + 8 * 2 + 2 + 1 + 8 * 7 + 32;
}
