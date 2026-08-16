//! Solana JSON-RPC submission and confirmation boundary.

use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use thiserror::Error;

use crate::api::JsonRpcProxyRequest;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cluster {
    Devnet,
}

impl Cluster {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Devnet => "devnet",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RpcConfig {
    pub url: String,
    pub commitment: String,
    pub confirmation_timeout: Duration,
    pub poll_interval: Duration,
}

impl Default for RpcConfig {
    fn default() -> Self {
        Self {
            url: "https://api.devnet.solana.com".to_owned(),
            commitment: "confirmed".to_owned(),
            confirmation_timeout: Duration::from_secs(30),
            poll_interval: Duration::from_millis(500),
        }
    }
}

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("Solana RPC request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("Solana RPC returned an invalid response: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("Solana RPC rejected {method}: {message}")]
    Remote { method: String, message: String },
    #[error("transaction {signature} failed: {message}")]
    TransactionFailed { signature: String, message: String },
    #[error("timed out waiting for transaction {signature} to finalize")]
    ConfirmationTimeout { signature: String },
    #[error("unsupported RPC proxy method: {0}")]
    UnsupportedProxyMethod(String),
    #[error("Solana RPC response did not contain {0}")]
    MissingField(&'static str),
}

#[derive(Debug, Clone)]
pub struct LatestBlockhash {
    pub blockhash: String,
    pub last_valid_block_height: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SimulationResult {
    pub ok: bool,
    pub logs: Vec<String>,
    pub units_consumed: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SignatureStatus {
    pub slot: Option<u64>,
    pub confirmation_status: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RpcClient {
    http: Client,
    config: RpcConfig,
}

#[derive(Debug, Deserialize)]
struct RpcEnvelope<T> {
    result: Option<T>,
    error: Option<RpcEnvelopeError>,
}

#[derive(Debug, Deserialize)]
struct RpcEnvelopeError {
    code: i64,
    message: String,
    #[serde(default)]
    data: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct BlockhashValue {
    blockhash: String,
    #[serde(rename = "lastValidBlockHeight")]
    last_valid_block_height: u64,
}

#[derive(Debug, Deserialize)]
struct BlockhashResponse {
    value: BlockhashValue,
}

#[derive(Debug, Deserialize)]
struct SimulationValue {
    err: Option<Value>,
    #[serde(default)]
    logs: Option<Vec<String>>,
    #[serde(rename = "unitsConsumed")]
    units_consumed: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct SimulationResponse {
    value: SimulationValue,
}

#[derive(Debug, Deserialize)]
struct SignatureStatusResponse {
    value: Vec<Option<RawSignatureStatus>>,
}

#[derive(Debug, Deserialize)]
struct RawSignatureStatus {
    slot: Option<u64>,
    err: Option<Value>,
    #[serde(rename = "confirmationStatus")]
    confirmation_status: Option<String>,
}

impl RpcClient {
    pub fn new(config: RpcConfig) -> Result<Self, RpcError> {
        let http = Client::builder()
            .user_agent("chainpay-backend/0.1")
            .build()?;
        Ok(Self { http, config })
    }

    pub fn config(&self) -> &RpcConfig {
        &self.config
    }

    pub async fn latest_blockhash(&self) -> Result<LatestBlockhash, RpcError> {
        let response: BlockhashResponse = self
            .call(
                "getLatestBlockhash",
                json!([{ "commitment": self.config.commitment }]),
            )
            .await?;
        Ok(LatestBlockhash {
            blockhash: response.value.blockhash,
            last_valid_block_height: response.value.last_valid_block_height,
        })
    }

    pub async fn current_slot(&self) -> Result<u64, RpcError> {
        self.call("getSlot", json!([{ "commitment": self.config.commitment }]))
            .await
    }

    pub async fn simulate_signed_transaction(
        &self,
        encoded_transaction: &str,
    ) -> Result<SimulationResult, RpcError> {
        let response: SimulationResponse = self
            .call(
                "simulateTransaction",
                json!([
                    encoded_transaction,
                    {
                        "encoding": "base64",
                        "sigVerify": true,
                        "replaceRecentBlockhash": false,
                        "commitment": self.config.commitment
                    }
                ]),
            )
            .await?;
        let error = response.value.err.map(|value| value.to_string());
        Ok(SimulationResult {
            ok: error.is_none(),
            logs: response.value.logs.unwrap_or_default(),
            units_consumed: response.value.units_consumed,
            error,
        })
    }

    pub async fn send_transaction(&self, encoded_transaction: &str) -> Result<String, RpcError> {
        self.call(
            "sendTransaction",
            json!([
                encoded_transaction,
                {
                    "encoding": "base64",
                    "skipPreflight": true,
                    "maxRetries": 3,
                    "preflightCommitment": self.config.commitment
                }
            ]),
        )
        .await
    }

    pub async fn signature_status(
        &self,
        signature: &str,
    ) -> Result<Option<SignatureStatus>, RpcError> {
        let response: SignatureStatusResponse = self
            .call(
                "getSignatureStatuses",
                json!([[signature], { "searchTransactionHistory": true }]),
            )
            .await?;
        Ok(response
            .value
            .into_iter()
            .next()
            .flatten()
            .map(|status| SignatureStatus {
                slot: status.slot,
                confirmation_status: status.confirmation_status,
                error: status.err.map(|value| value.to_string()),
            }))
    }

    pub async fn wait_for_finalized(&self, signature: &str) -> Result<SignatureStatus, RpcError> {
        let deadline = tokio::time::Instant::now() + self.config.confirmation_timeout;
        loop {
            if let Some(status) = self.signature_status(signature).await? {
                if let Some(message) = status.error.clone() {
                    return Err(RpcError::TransactionFailed {
                        signature: signature.to_owned(),
                        message,
                    });
                }
                if status.confirmation_status.as_deref() == Some("finalized") {
                    return Ok(status);
                }
            }

            if tokio::time::Instant::now() >= deadline {
                return Err(RpcError::ConfirmationTimeout {
                    signature: signature.to_owned(),
                });
            }
            tokio::time::sleep(self.config.poll_interval).await;
        }
    }

    pub async fn forward_proxy(&self, request: JsonRpcProxyRequest) -> Result<Value, RpcError> {
        const ALLOWED_METHODS: &[&str] = &[
            "getAccountInfo",
            "getBalance",
            "getEpochInfo",
            "getProgramAccounts",
            "getLatestBlockhash",
            "getMultipleAccounts",
            "getSignaturesForAddress",
            "getSignatureStatuses",
            "getSlot",
            "getTokenAccountBalance",
            "getTokenSupply",
            "getTransaction",
            "simulateTransaction",
        ];
        if !ALLOWED_METHODS.contains(&request.method.as_str()) {
            return Err(RpcError::UnsupportedProxyMethod(request.method));
        }

        let params = request.params.unwrap_or_else(|| json!([]));
        let result: Value = self.call(&request.method, params).await?;
        Ok(json!({
            "jsonrpc": "2.0",
            "id": request.id,
            "result": result,
        }))
    }

    async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T, RpcError> {
        const MAX_ATTEMPTS: usize = 4;

        let response = {
            let mut attempt = 0;
            loop {
                let response = self
                    .http
                    .post(&self.config.url)
                    .json(&json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": method,
                        "params": params,
                    }))
                    .send()
                    .await?;

                let status = response.status();
                let retryable =
                    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error();
                if status.is_success() || !retryable || attempt + 1 >= MAX_ATTEMPTS {
                    break response.error_for_status()?;
                }

                let delay = retry_delay(&response, attempt);
                attempt += 1;
                tokio::time::sleep(delay).await;
            }
        };
        let envelope: RpcEnvelope<T> = response.json().await?;
        if let Some(error) = envelope.error {
            let data = error
                .data
                .map(|value| format!(" ({value})"))
                .unwrap_or_default();
            return Err(RpcError::Remote {
                method: method.to_owned(),
                message: format!("{} [{}]{}", error.message, error.code, data),
            });
        }
        envelope.result.ok_or(RpcError::MissingField("result"))
    }
}

fn retry_delay(response: &reqwest::Response, attempt: usize) -> Duration {
    if let Some(seconds) = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
    {
        return Duration::from_secs(seconds.min(15));
    }

    let multiplier = 1u64 << attempt.min(4);
    Duration::from_millis(500 * multiplier)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_devnet_and_confirmed_commitment() {
        let config = RpcConfig::default();
        assert_eq!(config.url, "https://api.devnet.solana.com");
        assert_eq!(config.commitment, "confirmed");
    }
}
