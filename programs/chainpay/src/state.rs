use anchor_lang::prelude::*;

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
pub struct PaymentMandate {
    pub owner: Pubkey,
    pub approved_agent: Pubkey,
    pub source_token_account: Pubkey,
    pub allowed_mint: Pubkey,
    pub allowed_recipient: Pubkey,
    pub max_per_payment: u64,
    pub total_limit: u64,
    pub amount_spent: u64,
    pub payment_count: u64,
    pub expires_at_slot: u64,
    pub paused: bool,
    pub revoked: bool,
    pub bump: u8,
}

impl PaymentMandate {
    pub const LEN: usize = 32 * 5 + 8 * 5 + 3;
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
}

impl PaymentReceipt {
    // Five Pubkeys plus three 32-byte hashes/references, two u64 values, and
    // the status/bump bytes.
    pub const LEN: usize = 32 * 8 + 8 * 2 + 2;
}
