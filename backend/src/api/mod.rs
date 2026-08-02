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
    pub recipient: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_u64")]
    pub amount: Option<u64>,
    pub token_program: Option<String>,
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
}
