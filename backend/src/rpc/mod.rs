//! Solana JSON-RPC submission and confirmation boundary.

use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

use reqwest::Client;
use serde::{Deserialize, de::DeserializeOwned};
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
    #[error("RPC capacity is busy; retry the existing operation later")]
    Busy,
    #[error("Solana RPC request failed: {0}")]
    Http(reqwest::Error),
    #[error("Solana RPC returned an invalid response: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("Solana RPC rejected {method}: {message}")]
    Remote {
        method: String,
        message: String,
        code: i64,
    },
    #[error("transaction {signature} failed: {message}")]
    TransactionFailed { signature: String, message: String },
    #[error("timed out waiting for transaction {signature} to finalize")]
    ConfirmationTimeout { signature: String },
    #[error("unsupported RPC proxy method: {0}")]
    UnsupportedProxyMethod(String),
    #[error("Solana RPC response did not contain {0}")]
    MissingField(&'static str),
    #[error("Solana RPC returned invalid account data: {0}")]
    InvalidAccountData(String),
}

impl From<reqwest::Error> for RpcError {
    fn from(error: reqwest::Error) -> Self {
        Self::Http(error.without_url())
    }
}

#[derive(Debug, Clone)]
pub struct LatestBlockhash {
    pub blockhash: String,
    pub last_valid_block_height: u64,
}

#[derive(Debug, Clone)]
pub struct SignatureStatus {
    pub slot: Option<u64>,
    pub confirmation_status: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RpcAccount {
    pub owner: String,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct RpcClient {
    in_flight: Arc<Semaphore>,
    http: Client,
    config: RpcConfig,
}

#[derive(Debug, Deserialize)]
struct RpcEnvelope {
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

#[derive(Debug, Deserialize)]
struct AccountInfoResponse {
    value: Option<RawAccountInfo>,
}

#[derive(Debug, Deserialize)]
struct RawAccountInfo {
    owner: String,
    data: Value,
}

impl RpcClient {
    pub fn new(config: RpcConfig) -> Result<Self, RpcError> {
        let http = Client::builder()
            .user_agent("chainpay-backend/0.1")
            .timeout(Duration::from_secs(20))
            .build()?;
        Ok(Self {
            http,
            config,
            in_flight: Arc::new(Semaphore::new(32)),
        })
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

    pub async fn account_info(&self, address: &str) -> Result<Option<RpcAccount>, RpcError> {
        self.account_info_committed(address, &self.config.commitment)
            .await
    }

    pub async fn account_info_committed(
        &self,
        address: &str,
        commitment: &str,
    ) -> Result<Option<RpcAccount>, RpcError> {
        let response: AccountInfoResponse = self
            .call(
                "getAccountInfo",
                json!([address, { "commitment": commitment, "encoding": "base64" }]),
            )
            .await?;
        response
            .value
            .map(|account| {
                let encoded = account
                    .data
                    .as_array()
                    .and_then(|parts| parts.first())
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        RpcError::InvalidAccountData("expected base64 tuple".to_owned())
                    })?;
                let data =
                    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
                        .map_err(|error| RpcError::InvalidAccountData(error.to_string()))?;
                Ok(RpcAccount {
                    owner: account.owner,
                    data,
                })
            })
            .transpose()
    }

    pub async fn send_transaction(&self, encoded_transaction: &str) -> Result<String, RpcError> {
        self.call(
            "sendTransaction",
            json!([
                encoded_transaction,
                {
                    "encoding": "base64",
                    "skipPreflight": false,
                    "maxRetries": 3,
                    "preflightCommitment": self.config.commitment
                }
            ]),
        )
        .await
    }

    pub async fn blockhash_valid(&self, blockhash: &str) -> Result<bool, RpcError> {
        #[derive(Deserialize)]
        struct Valid {
            value: bool,
        }
        Ok(self
            .call::<Valid>(
                "isBlockhashValid",
                json!([blockhash,{"commitment":"finalized"}]),
            )
            .await?
            .value)
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
        let deadline = tokio::time::Instant::now()
            .checked_add(self.config.confirmation_timeout)
            .unwrap_or(tokio::time::Instant::now());
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
            "getGenesisHash",
            "getProgramAccounts",
            "getLatestBlockhash",
            "getMultipleAccounts",
            "getSignaturesForAddress",
            "getSignatureStatuses",
            "getSlot",
            "getTokenAccountBalance",
            "getTokenSupply",
            "getTransaction",
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
        let _permit = self.in_flight.try_acquire().map_err(|_| RpcError::Busy)?;
        const MAX_ATTEMPTS: usize = 4;

        let mut response = {
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
                if method == "sendTransaction"
                    || status.is_success()
                    || !retryable
                    || attempt + 1 >= MAX_ATTEMPTS
                {
                    break response.error_for_status()?;
                }

                let delay = retry_delay(&response, attempt);
                attempt += 1;
                tokio::time::sleep(delay).await;
            }
        };
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            if bytes.len().saturating_add(chunk.len()) > 2_097_152 {
                return Err(RpcError::InvalidAccountData(
                    "RPC response exceeds 2 MiB".into(),
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        let raw: Value = serde_json::from_slice(&bytes)?;
        let envelope: RpcEnvelope = serde_json::from_value(raw.clone())?;
        if let Some(error) = envelope.error {
            let data = error
                .data
                .map(|value| format!(" ({value})"))
                .unwrap_or_default();
            return Err(RpcError::Remote {
                method: method.to_owned(),
                code: error.code,
                message: format!("{} [{}]{}", error.message, error.code, data),
            });
        }
        let result = raw.get("result").ok_or(RpcError::MissingField("result"))?;
        Ok(serde_json::from_value(result.clone())?)
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

    #[tokio::test]
    async fn transport_error_removes_rpc_url_credentials() {
        let error = reqwest::Client::new()
            .get("http://fixture-user:fixture-secret@127.0.0.1:1/?api-key=fixture-key")
            .send()
            .await
            .unwrap_err();
        let safe = RpcError::from(error).to_string();
        assert!(!safe.contains("fixture-secret") && !safe.contains("fixture-key"));
    }

    #[tokio::test]
    async fn shared_in_flight_capacity_rejects_without_queueing() {
        let rpc = RpcClient::new(RpcConfig::default()).unwrap();
        let permits = rpc.in_flight.acquire_many(32).await.unwrap();
        assert!(matches!(
            rpc.clone().latest_blockhash().await,
            Err(RpcError::Busy)
        ));
        drop(permits);
        assert_eq!(rpc.in_flight.available_permits(), 32);
    }

    #[test]
    fn defaults_to_devnet_and_confirmed_commitment() {
        let config = RpcConfig::default();
        assert_eq!(config.url, "https://api.devnet.solana.com");
        assert_eq!(config.commitment, "confirmed");
    }
}
