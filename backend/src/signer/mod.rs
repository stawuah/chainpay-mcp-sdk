//! Provider-held Solana signer integration.
//!
//! ChainPay never creates, imports, exports, or stores a wallet private key.
//! Privy holds the Solana key and returns only a public address, opaque wallet
//! identifier, and a transaction containing the provider-produced signature.

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

const DEFAULT_PRIVY_API_URL: &str = "https://api.privy.io";

#[derive(Clone)]
pub struct PrivySignerProvider {
    http: Client,
    api_url: String,
    app_id: String,
    app_secret: String,
    policy_id: String,
}

impl std::fmt::Debug for PrivySignerProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PrivySignerProvider")
            .field("api_url", &self.api_url)
            .field("app_id", &self.app_id)
            .field("app_secret", &"[redacted]")
            .field("policy_id", &self.policy_id)
            .finish()
    }
}

#[derive(Debug, Error)]
pub enum SignerConfigError {
    #[error(
        "managed signing requires PRIVY_APP_ID, PRIVY_APP_SECRET, and PRIVY_POLICY_ID together"
    )]
    Incomplete,
    #[error("could not initialize the managed signer HTTP client: {0}")]
    Http(#[from] reqwest::Error),
}

#[derive(Debug, Error)]
pub enum SignerProviderError {
    #[error("managed signer provider request failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("managed signer provider returned HTTP {status}: {message}")]
    Remote { status: StatusCode, message: String },
    #[error("managed signer provider returned invalid data: {0}")]
    InvalidResponse(String),
}

#[derive(Debug, Clone)]
pub struct ProvisionedSigner {
    pub public_key: String,
    pub provider_wallet_id: String,
    pub provider_policy_id: String,
}

#[derive(Debug, Serialize)]
struct CreateWalletRequest<'a> {
    chain_type: &'static str,
    display_name: &'static str,
    external_id: &'a str,
    policy_ids: [&'a str; 1],
}

#[derive(Debug, Deserialize)]
struct CreateWalletResponse {
    id: String,
    address: String,
    chain_type: String,
    #[serde(default)]
    policy_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
struct SignTransactionRequest<'a> {
    method: &'static str,
    params: SignTransactionParams<'a>,
}

#[derive(Debug, Serialize)]
struct SignTransactionParams<'a> {
    transaction: &'a str,
    encoding: &'static str,
}

#[derive(Debug, Deserialize)]
struct SignTransactionResponse {
    method: String,
    data: SignedTransactionData,
}

#[derive(Debug, Deserialize)]
struct SignedTransactionData {
    signed_transaction: String,
    encoding: String,
}

impl PrivySignerProvider {
    pub fn from_env() -> Result<Option<Self>, SignerConfigError> {
        let app_id = non_empty_env("PRIVY_APP_ID");
        let app_secret = non_empty_env("PRIVY_APP_SECRET");
        let policy_id = non_empty_env("PRIVY_POLICY_ID");
        if app_id.is_none() && app_secret.is_none() && policy_id.is_none() {
            return Ok(None);
        }
        let (Some(app_id), Some(app_secret), Some(policy_id)) = (app_id, app_secret, policy_id)
        else {
            return Err(SignerConfigError::Incomplete);
        };
        let http = Client::builder()
            .user_agent("chainpay-backend/0.1 managed-signer")
            .build()?;
        Ok(Some(Self {
            http,
            api_url: non_empty_env("PRIVY_API_URL")
                .unwrap_or_else(|| DEFAULT_PRIVY_API_URL.to_owned())
                .trim_end_matches('/')
                .to_owned(),
            app_id,
            app_secret,
            policy_id,
        }))
    }

    pub async fn provision(
        &self,
        owner_wallet: &str,
        mandate_pda: &str,
    ) -> Result<ProvisionedSigner, SignerProviderError> {
        validate_policy_id(&self.policy_id)?;
        let external_id = external_id(owner_wallet, mandate_pda);
        let response = self
            .http
            .post(format!("{}/v1/wallets", self.api_url))
            .basic_auth(&self.app_id, Some(&self.app_secret))
            .header("privy-app-id", &self.app_id)
            .json(&CreateWalletRequest {
                chain_type: "solana",
                display_name: "ChainPay autonomous signer",
                external_id: &external_id,
                policy_ids: [&self.policy_id],
            })
            .send()
            .await?;
        let response: CreateWalletResponse = decode_response(response).await?;
        if response.chain_type != "solana" {
            return Err(SignerProviderError::InvalidResponse(
                "created wallet is not a Solana wallet".to_owned(),
            ));
        }
        validate_provider_id(&response.id)?;
        validate_solana_address(&response.address)?;
        if !response
            .policy_ids
            .iter()
            .any(|policy| policy == &self.policy_id)
        {
            return Err(SignerProviderError::InvalidResponse(
                "created wallet is missing the required Privy policy".to_owned(),
            ));
        }
        Ok(ProvisionedSigner {
            public_key: response.address,
            provider_wallet_id: response.id,
            provider_policy_id: self.policy_id.clone(),
        })
    }

    pub async fn sign_transaction(
        &self,
        provider_wallet_id: &str,
        unsigned_transaction: &str,
    ) -> Result<String, SignerProviderError> {
        validate_provider_id(provider_wallet_id)?;
        let response = self
            .http
            .post(format!(
                "{}/v1/wallets/{provider_wallet_id}/rpc",
                self.api_url
            ))
            .basic_auth(&self.app_id, Some(&self.app_secret))
            .header("privy-app-id", &self.app_id)
            .json(&SignTransactionRequest {
                method: "signTransaction",
                params: SignTransactionParams {
                    transaction: unsigned_transaction,
                    encoding: "base64",
                },
            })
            .send()
            .await?;
        let response: SignTransactionResponse = decode_response(response).await?;
        if response.method != "signTransaction" || response.data.encoding != "base64" {
            return Err(SignerProviderError::InvalidResponse(
                "unexpected Solana signing response".to_owned(),
            ));
        }
        if response.data.signed_transaction.trim().is_empty() {
            return Err(SignerProviderError::InvalidResponse(
                "signed transaction is empty".to_owned(),
            ));
        }
        Ok(response.data.signed_transaction)
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn external_id(owner_wallet: &str, mandate_pda: &str) -> String {
    let digest = Sha256::digest(format!("{owner_wallet}:{mandate_pda}").as_bytes());
    format!("chainpay_{}", hex(&digest[..24]))
}

async fn decode_response<T: for<'de> Deserialize<'de>>(
    response: reqwest::Response,
) -> Result<T, SignerProviderError> {
    let status = response.status();
    if !status.is_success() {
        let message = response
            .text()
            .await
            .unwrap_or_else(|_| "provider error".to_owned());
        return Err(SignerProviderError::Remote {
            status,
            message: truncate(&message, 1_024),
        });
    }
    response
        .json::<T>()
        .await
        .map_err(|error| SignerProviderError::InvalidResponse(error.to_string()))
}

fn validate_provider_id(value: &str) -> Result<(), SignerProviderError> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(SignerProviderError::InvalidResponse(
            "provider wallet ID contains invalid characters".to_owned(),
        ));
    }
    Ok(())
}

fn validate_policy_id(value: &str) -> Result<(), SignerProviderError> {
    let valid = value.len() == 24
        && value.bytes().enumerate().all(|(index, byte)| {
            if index == 0 {
                byte.is_ascii_lowercase()
            } else {
                byte.is_ascii_lowercase() || byte.is_ascii_digit()
            }
        });
    if !valid {
        return Err(SignerProviderError::InvalidResponse(
            "automatic payments are unavailable because PRIVY_POLICY_ID is not a valid 24-character Privy policy ID. In Privy, copy the policy ID (not its name, an app ID, a secret, or a rule ID) into the backend environment.".to_owned(),
        ));
    }
    Ok(())
}

fn validate_solana_address(value: &str) -> Result<(), SignerProviderError> {
    let bytes = bs58::decode(value)
        .into_vec()
        .map_err(|error| SignerProviderError::InvalidResponse(error.to_string()))?;
    if bytes.len() != 32 {
        return Err(SignerProviderError::InvalidResponse(
            "provider returned a non-Solana public key".to_owned(),
        ));
    }
    Ok(())
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn hex(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(result, "{byte:02x}");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_ids_are_stable_and_provider_safe() {
        let first = external_id("owner", "mandate");
        assert_eq!(first, external_id("owner", "mandate"));
        assert!(first.len() <= 64);
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        );
    }

    #[test]
    fn policy_id_requires_a_24_character_cuid2() {
        assert!(validate_policy_id("tb54eps4z44ed0jepousxi4n").is_ok());
        assert!(validate_policy_id("policy-name").is_err());
        assert!(validate_policy_id("TB54EPS4Z44ED0JEPOUSXI4N").is_err());
    }
}
