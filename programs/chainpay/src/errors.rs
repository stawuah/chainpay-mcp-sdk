use anchor_lang::prelude::*;

#[error_code]
pub enum ChainPayError {
    #[msg("The protocol configuration authority is invalid.")]
    InvalidConfigAuthority,
    #[msg("The mint is not enabled in the ChainPay protocol configuration.")]
    UnsupportedMint,
    #[msg("The supported mint list must contain unique, non-default mints.")]
    InvalidSupportedMintList,
    #[msg("The token accounts and mint must use the same token program.")]
    InvalidTokenProgram,
    #[msg("The approved agent must be a non-default public key.")]
    InvalidAgent,
    #[msg("The source token account must be the owner's token account.")]
    InvalidSourceTokenAccount,
    #[msg("The source token account does not use the mandate mint.")]
    InvalidSourceMint,
    #[msg("The recipient token account does not use the mandate mint.")]
    InvalidRecipientMint,
    #[msg("The allowed recipient must be a non-default public key.")]
    InvalidRecipient,
    #[msg("The allowed mint must be a non-default public key.")]
    InvalidMint,
    #[msg("The per-payment limit must be greater than zero.")]
    InvalidPerPaymentLimit,
    #[msg("The total limit must be at least the per-payment limit.")]
    InvalidTotalLimit,
    #[msg("The mandate expiry must be in the future.")]
    InvalidExpiry,
    #[msg("The mandate has been paused.")]
    MandatePaused,
    #[msg("The mandate has been revoked.")]
    MandateRevoked,
    #[msg("The mandate has expired.")]
    MandateExpired,
    #[msg("The payment amount must be greater than zero.")]
    InvalidPaymentAmount,
    #[msg("The payment amount exceeds the mandate's per-payment limit.")]
    AmountExceedsPerPayment,
    #[msg("The payment would exceed the mandate's total limit.")]
    TotalLimitExceeded,
    #[msg("The invoice hash must not be all zeroes.")]
    InvalidInvoiceHash,
    #[msg("The payment ID must not be all zeroes.")]
    InvalidPaymentId,
    #[msg("The signature reference must not be all zeroes.")]
    InvalidSignatureReference,
}
