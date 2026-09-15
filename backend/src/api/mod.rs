use serde::{Deserialize, Deserializer, Serialize};

fn deserialize_optional_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum U64Value {
        Number(u64),
        String(String),
    }

    match Option::<U64Value>::deserialize(deserializer)? {
        None => Ok(None),
        Some(U64Value::Number(value)) => Ok(Some(value)),
        Some(U64Value::String(value)) => value
            .parse::<u64>()
            .map(Some)
            .map_err(|_| serde::de::Error::custom("amount must be an unsigned 64-bit integer")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentRequest {
    pub mandate: String,
    pub invoice_hash: String,
    pub recipient: String,
    pub amount: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentResponse {
    pub payment_id: String,
    pub status: crate::PaymentStatus,
    pub receipt: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaymentSubmissionRequest {
    pub idempotency_key: String,
    pub mandate: String,
    pub invoice_hash: String,
    #[serde(default)]
    pub receipt_address: Option<String>,
    pub signed_transaction: String,
    pub agent: Option<String>,
    pub mint: Option<String>,
    pub recipient: String,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub amount: Option<u64>,
    pub token_program: Option<String>,
    #[serde(default)]
    pub x402: Option<X402PaymentMetadata>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedSignerChallengeRequest {
    pub owner_wallet: String,
    pub mandate_pda: String,
    pub mint: String,
    pub mandate_nonce: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedSignerChallengeResponse {
    pub challenge_id: String,
    pub message: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedSignerProvisionRequest {
    pub challenge_id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManagedPaymentSubmissionRequest {
    pub idempotency_key: String,
    pub mandate: String,
    pub invoice_hash: String,
    #[serde(default)]
    pub receipt_address: Option<String>,
    pub unsigned_transaction: String,
    pub agent: String,
    pub mint: String,
    pub recipient: String,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub amount: Option<u64>,
    pub token_program: String,
    #[serde(default)]
    pub x402: Option<X402PaymentMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct X402PaymentMetadata {
    pub resource: String,
    pub challenge: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct X402ProofRequest {
    pub mandate: String,
    pub idempotency_key: String,
    pub proof: serde_json::Value,
    pub response_status: u16,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListX402PaymentsQuery {
    #[serde(default)]
    pub mandate: Option<String>,
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct X402JobResponse {
    pub x402_payment_id: String,
    pub resource: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mandate: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
    pub status: String,
    pub protocol: String,
    pub payable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction_signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct X402JobListResponse {
    pub jobs: Vec<X402JobResponse>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PayshCatalogResponse {
    pub source: &'static str,
    pub estimate_only: bool,
    pub fetched_at_ms: u64,
    pub providers: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PaymentRequestPayload {
    pub version: u8,
    pub cluster: String,
    pub merchant: String,
    pub invoice: String,
    pub mint: String,
    #[serde(rename = "tokenProgram")]
    pub token_program: String,
    pub recipient: String,
    pub amount: String,
    pub decimals: u8,
    pub nonce: String,
    #[serde(rename = "expiresAtSlot", skip_serializing_if = "Option::is_none")]
    pub expires_at_slot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SignedPaymentRequest {
    pub payload: PaymentRequestPayload,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PaymentRequestVerificationResponse {
    pub valid: bool,
    pub payload: PaymentRequestPayload,
    pub invoice_hash: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransactionSubmissionRequest {
    pub idempotency_key: String,
    pub signed_transaction: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcProxyRequest {
    pub jsonrpc: String,
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackendConfigResponse {
    pub cluster: &'static str,
    pub program_id: String,
    pub rpc_proxy: &'static str,
    pub trusted_sellers: Vec<TrustedSellerPublicConfig>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrustedSellerPublicConfig {
    pub cluster: String,
    #[serde(rename = "programId")]
    pub program_id: String,
    pub sellers: Vec<String>,
    #[serde(rename = "recipientTokenAccount")]
    pub recipient_token_account: String,
}
