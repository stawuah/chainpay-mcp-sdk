use serde::{Deserialize, Serialize};

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
