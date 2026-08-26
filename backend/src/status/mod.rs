use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentStatus {
    Prepared,
    Submitted,
    Confirmed,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SigningMode {
    Human,
    Delegated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentRecord {
    pub payment_id: String,
    pub idempotency_key: String,
    pub mandate: String,
    pub invoice_hash: String,
    pub receipt_address: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub mint: Option<String>,
    #[serde(default)]
    pub recipient: Option<String>,
    #[serde(default)]
    pub amount: Option<u64>,
    #[serde(default)]
    pub token_program: Option<String>,
    pub signing_mode: SigningMode,
    pub signature: Option<String>,
    pub slot: Option<u64>,
    pub status: PaymentStatus,
    pub error: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedSignerStatus {
    Provisioning,
    Active,
    Suspended,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedSignerChallenge {
    pub challenge_id: String,
    pub owner_wallet: String,
    pub mandate_pda: String,
    pub message: String,
    pub expires_at_ms: u64,
    pub consumed_at_ms: Option<u64>,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManagedSignerRecord {
    pub signer_id: String,
    pub owner_wallet: String,
    pub public_key: String,
    pub provider: String,
    #[serde(skip_serializing)]
    pub provider_wallet_id: String,
    #[serde(skip_serializing)]
    pub provider_policy_id: String,
    pub mandate_pda: String,
    pub signing_mode: SigningMode,
    pub status: ManagedSignerStatus,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub revoked_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionRecord {
    pub transaction_id: String,
    pub idempotency_key: String,
    pub signature: Option<String>,
    pub slot: Option<u64>,
    pub status: PaymentStatus,
    pub error: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum X402PaymentStatus {
    Prepared,
    Submitted,
    Confirmed,
    Verified,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct X402PaymentRecord {
    pub x402_payment_id: String,
    pub idempotency_key: String,
    pub resource: String,
    pub payment_id: Option<String>,
    pub receipt_address: Option<String>,
    pub transaction_signature: Option<String>,
    pub status: X402PaymentStatus,
    pub challenge: serde_json::Value,
    pub proof: Option<serde_json::Value>,
    pub response_status: Option<u16>,
    pub error: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}
