use anchor_lang::prelude::*;

// Codes are part of contracts.md §1.4: Axum maps them to the ASA result and the
// UI copy. Anchor numbers them from 6000 in declaration order. Append only.
// Messages are fixed strings: they must never carry a policy value.
#[error_code]
pub enum CardPolicyError {
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized, // 6000
    #[msg("Validator is not on the TEE allowlist")]
    ValidatorNotAllowed, // 6001
    #[msg("Card policy has not been set")]
    PolicyNotSet, // 6002
    #[msg("Policy arguments are invalid")]
    InvalidPolicy, // 6003
    #[msg("Card is frozen")]
    CardFrozen, // 6004
    #[msg("Card is in recovery")]
    RecoveryFrozen, // 6005
    #[msg("Card policy has expired")]
    PolicyExpired, // 6006
    #[msg("Checkout intent is not usable")]
    IntentInvalid, // 6007
    #[msg("Checkout intent has expired")]
    IntentExpired, // 6008
    #[msg("Checkout intent was opened under an older policy")]
    IntentStale, // 6009
    #[msg("Merchant does not match the checkout intent")]
    MerchantMismatch, // 6010
    #[msg("Merchant is not allowed by the card policy")]
    MerchantNotAllowed, // 6011
    #[msg("Merchant category is not allowed")]
    MccNotAllowed, // 6012
    #[msg("Currency does not match")]
    CurrencyMismatch, // 6013
    #[msg("Amount exceeds the checkout intent")]
    AmountExceedsIntent, // 6014
    #[msg("Amount exceeds the per-purchase maximum")]
    AmountExceedsMax, // 6015
    #[msg("Amount exceeds the available budget")]
    BudgetExceeded, // 6016
    #[msg("Purchase count limit reached for this period")]
    VelocityExceeded, // 6017
    #[msg("Merchant-initiated purchases are not allowed")]
    RecurringNotAllowed, // 6018
    #[msg("Authorization was already recorded")]
    DuplicateAuthorization, // 6019
    #[msg("Capture was already recorded")]
    DuplicateCapture, // 6020
    #[msg("Reservation is closed")]
    ReservationClosed, // 6021
    #[msg("Period has not ended")]
    PeriodNotEnded, // 6022
    #[msg("Making card data public is blocked")]
    DisclosureBlocked, // 6023
    #[msg("Permission member limit reached")]
    MemberLimit, // 6024
    #[msg("Exceptions need owner review first")]
    ExceptionsOpen, // 6025
    #[msg("Card is not in recovery")]
    NotInRecovery, // 6026
    #[msg("Commitment sequence is stale")]
    StaleCommitment, // 6027
    #[msg("Card has open reservations")]
    OpenReservations, // 6028
    #[msg("Card has an outstanding statement balance")]
    OutstandingBalance, // 6029
    #[msg("Arithmetic overflow")]
    MathOverflow, // 6030
    #[msg("Changing the authorizer requires a frozen card")]
    AuthorizerChangeRequiresFreeze, // 6031
    #[msg("Repayment was already recorded")]
    DuplicateRepayment, // 6032
    // ---- appended in Phase 1A (contracts.md changelog) ----
    #[msg("Permission member not found")]
    MemberNotFound, // 6033
    #[msg("Permissions have not been initialized")]
    PermissionNotInitialized, // 6034
    #[msg("Amount must be greater than zero")]
    InvalidAmount, // 6035
    #[msg("No open exceptions")]
    NoOpenExceptions, // 6036
    #[msg("Reconciliation digest does not match")]
    ReconDigestMismatch, // 6037
    #[msg("Repayment exceeds the outstanding balance")]
    RepaymentExceedsOutstanding, // 6038
    #[msg("Account does not belong to this card")]
    InvalidAccount, // 6039
    #[msg("Prefund is below the minimum")]
    PrefundTooLow, // 6040
    #[msg("Card account is not zeroed")]
    NotWiped, // 6041
    #[msg("Event identifier must not be zero")]
    InvalidEventId, // 6042
    #[msg("Issuer event was already recorded")]
    DuplicateEvent, // 6043
    #[msg("Card still has ephemeral accounts")]
    EphemeralAccountsOpen, // 6044
    #[msg("Reservation is not final yet")]
    ReservationNotFinal, // 6045
    // ---- appended in review fixes (2026-10-04) ----
    #[msg(
        "Changing the authorizer, fee or credit terms needs the current authorizer's co-signature"
    )]
    CoSignerRequired, // 6046
    #[msg("Refund is more than this hold captured")]
    RefundExceedsCapture, // 6047
    #[msg("This hold has reached its capture limit")]
    CaptureLimit, // 6048
    #[msg("Budget can't go below what this period already spent or holds")]
    BudgetBelowCommitted, // 6049
}
