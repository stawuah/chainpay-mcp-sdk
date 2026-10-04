//! MagicBlock Private Ephemeral Rollup access for the authorizer keypair
//! (contracts.md §2, CD-4, CD-6).
//!
//! - Token: wallet challenge (`GET /auth/challenge`, Ed25519 signature,
//!   `POST /auth/login`). Refreshed within 24 h of expiry or after any 401.
//!   The token is a secret: never logged, never in an error, never returned.
//! - Reads: `null` from a permissioned read means **not visible**, never
//!   "missing" (`TeeRead::NotVisible`).
//! - Writes: send with `skipPreflight`, then poll signature status until a
//!   hard deadline. An unknown outcome is reported as such, never as failure.
//! - Attestation: "integrity-only" until MagicBlock publishes MRTD/RTMR
//!   values (gate G-MB). The quote's report data must equal our fresh
//!   challenge and its MRTD/RTMR0-2 are compared to `CARDS_TEE_MEASUREMENTS`
//!   in `report` (log only) or `enforce` mode. The Intel DCAP chain is
//!   verified by MagicBlock's SDK on clients, not in Axum (see Changelog).

use super::program::{self, error_name};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use ed25519_dalek::{Signer, SigningKey};
use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use solana_address::Address;
use solana_message::Instruction;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};

pub const DEVNET_TEE_URL: &str = "https://devnet-tee.magicblock.app";
const REFRESH_WINDOW_MS: u64 = 86_400_000;
const BLOCKHASH_TTL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TeeRead {
    Visible {
        data: Vec<u8>,
        owner: String,
        slot: u64,
    },
    /// Permission denied **or** absent: the rollup does not distinguish them.
    NotVisible {
        slot: Option<u64>,
    },
    RpcError(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TxOutcome {
    Confirmed {
        signature: String,
    },
    /// The program rejected the transaction with a `CardPolicyError` code.
    ProgramError {
        signature: String,
        code: u32,
    },
    /// Rejected for a non-program reason (bad blockhash, account error...).
    Failed {
        signature: Option<String>,
        reason: String,
    },
    /// Sent (or possibly sent), outcome not known by the deadline.
    Unknown {
        signature: Option<String>,
    },
}

impl TxOutcome {
    pub fn error_name(&self) -> Option<&'static str> {
        match self {
            Self::ProgramError { code, .. } => error_name(*code),
            _ => None,
        }
    }
    pub fn signature(&self) -> Option<&str> {
        match self {
            Self::Confirmed { signature } | Self::ProgramError { signature, .. } => Some(signature),
            Self::Failed { signature, .. } | Self::Unknown { signature } => signature.as_deref(),
        }
    }
}

#[derive(Clone)]
struct Grant {
    token: String,
    expires_at_ms: u64,
}

pub struct TeeClient {
    http: Client,
    url: String,
    key: SigningKey,
    pub authorizer: Address,
    grant: RwLock<Option<Grant>>,
    refresh: Mutex<()>,
    blockhash: Mutex<Option<([u8; 32], Instant)>>,
}

impl std::fmt::Debug for TeeClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TeeClient")
            .field("url", &self.url)
            .field("authorizer", &self.authorizer.to_string())
            .field("token", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TeeError {
    #[error("private rollup unreachable")]
    Network,
    #[error("private rollup refused sign-in")]
    Auth,
    #[error("private rollup returned an invalid response")]
    Invalid,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse `CARDS_AUTHORIZER_KEY`: a 64-byte Solana secret key as base58 or a
/// JSON byte array (solana-keygen format). The public half must match.
pub fn parse_authorizer_key(value: &str) -> Result<SigningKey, &'static str> {
    let value = value.trim();
    let bytes: Vec<u8> = if value.starts_with('[') {
        serde_json::from_str(value).map_err(|_| "CARDS_AUTHORIZER_KEY is not a JSON byte array")?
    } else {
        bs58::decode(value)
            .into_vec()
            .map_err(|_| "CARDS_AUTHORIZER_KEY is not base58")?
    };
    let bytes: [u8; 64] = bytes
        .try_into()
        .map_err(|_| "CARDS_AUTHORIZER_KEY must be 64 bytes")?;
    let key = SigningKey::from_bytes(bytes[..32].try_into().expect("32"));
    if key.verifying_key().to_bytes() != bytes[32..] {
        return Err("CARDS_AUTHORIZER_KEY public half does not match its secret");
    }
    Ok(key)
}

impl TeeClient {
    pub fn new(url: &str, key: SigningKey) -> Result<Self, TeeError> {
        let http = Client::builder()
            .user_agent("chainpay-backend/0.1 cards-authorizer")
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| TeeError::Invalid)?;
        let authorizer = Address::from(key.verifying_key().to_bytes());
        Ok(Self {
            http,
            url: url.trim_end_matches('/').to_owned(),
            key,
            authorizer,
            grant: RwLock::new(None),
            refresh: Mutex::new(()),
            blockhash: Mutex::new(None),
        })
    }

    pub fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    async fn acquire(&self) -> Result<Grant, TeeError> {
        let pubkey = self.authorizer.to_string();
        let challenge: Value = self
            .http
            .get(format!("{}/auth/challenge", self.url))
            .query(&[("pubkey", pubkey.as_str())])
            .send()
            .await
            .map_err(|_| TeeError::Network)?
            .json()
            .await
            .map_err(|_| TeeError::Invalid)?;
        let challenge = challenge["challenge"]
            .as_str()
            .filter(|c| !c.is_empty())
            .ok_or(TeeError::Auth)?;
        let signature = self.key.sign(challenge.as_bytes());
        let response = self
            .http
            .post(format!("{}/auth/login", self.url))
            .json(&json!({"pubkey": pubkey, "challenge": challenge, "signature": bs58::encode(signature.to_bytes()).into_string()}))
            .send()
            .await
            .map_err(|_| TeeError::Network)?;
        if response.status() != StatusCode::OK {
            return Err(TeeError::Auth);
        }
        let body: Value = response.json().await.map_err(|_| TeeError::Invalid)?;
        let token = body["token"]
            .as_str()
            .filter(|t| !t.is_empty())
            .ok_or(TeeError::Auth)?;
        let expires_at_ms = body["expiresAt"]
            .as_u64()
            .unwrap_or_else(|| now_ms() + 30 * REFRESH_WINDOW_MS);
        Ok(Grant {
            token: token.to_owned(),
            expires_at_ms,
        })
    }

    /// Hot path: return any unexpired token at once; a missing or forced
    /// token is acquired within `timeout` (the caller's deadline), never the
    /// 10 s client timeout. Renewal inside the 24 h window happens in
    /// [`TeeClient::warm`], off the ASA path.
    async fn token(&self, force: bool, timeout: Duration) -> Result<String, TeeError> {
        if !force {
            if let Some(grant) = self.grant.read().await.as_ref() {
                if grant.expires_at_ms > now_ms() + 60_000 {
                    return Ok(grant.token.clone());
                }
            }
        }
        tokio::time::timeout(timeout, self.renew(force))
            .await
            .map_err(|_| TeeError::Network)?
    }

    async fn renew(&self, force: bool) -> Result<String, TeeError> {
        let _guard = self.refresh.lock().await;
        if !force {
            if let Some(grant) = self.grant.read().await.as_ref() {
                if grant.expires_at_ms.saturating_sub(now_ms()) > REFRESH_WINDOW_MS {
                    return Ok(grant.token.clone());
                }
            }
        }
        let grant = self.acquire().await?;
        let token = grant.token.clone();
        *self.grant.write().await = Some(grant);
        Ok(token)
    }

    /// Acquire or renew the session token in the background (cold start,
    /// < 24 h left). Called off the decision path.
    pub async fn warm(&self) -> Result<(), TeeError> {
        let fresh = self
            .grant
            .read()
            .await
            .as_ref()
            .is_some_and(|g| g.expires_at_ms.saturating_sub(now_ms()) > REFRESH_WINDOW_MS);
        if !fresh {
            tokio::time::timeout(Duration::from_secs(15), self.renew(false))
                .await
                .map_err(|_| TeeError::Network)??;
        }
        Ok(())
    }

    /// JSON-RPC over the authorizer's session. Retries once after a 401.
    /// Errors never carry the tokenized URL.
    pub async fn rpc(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, TeeError> {
        let mut forced = false;
        loop {
            let token = self.token(forced, timeout).await?;
            let response = self
                .http
                .post(&self.url)
                .query(&[("token", token.as_str())])
                .timeout(timeout)
                .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
                .send()
                .await
                .map_err(|_| TeeError::Network)?;
            if response.status() == StatusCode::UNAUTHORIZED && !forced {
                forced = true;
                continue;
            }
            if !response.status().is_success() {
                return Err(TeeError::Invalid);
            }
            return response.json().await.map_err(|_| TeeError::Invalid);
        }
    }

    pub async fn read_account(&self, address: &Address, timeout: Duration) -> TeeRead {
        let body = match self
            .rpc(
                "getAccountInfo",
                json!([address.to_string(), {"encoding":"base64","commitment":"confirmed"}]),
                timeout,
            )
            .await
        {
            Ok(body) => body,
            Err(error) => return TeeRead::RpcError(error.to_string()),
        };
        parse_account_read(&body)
    }

    async fn latest_blockhash(&self, timeout: Duration) -> Result<[u8; 32], TeeError> {
        let mut cached = self.blockhash.lock().await;
        if let Some((hash, at)) = *cached {
            if at.elapsed() < BLOCKHASH_TTL {
                return Ok(hash);
            }
        }
        let body = self
            .rpc(
                "getLatestBlockhash",
                json!([{"commitment":"confirmed"}]),
                timeout,
            )
            .await?;
        let hash = body["result"]["value"]["blockhash"]
            .as_str()
            .ok_or(TeeError::Invalid)?;
        let bytes: [u8; 32] = bs58::decode(hash)
            .into_vec()
            .map_err(|_| TeeError::Invalid)?
            .try_into()
            .map_err(|_| TeeError::Invalid)?;
        *cached = Some((bytes, Instant::now()));
        Ok(bytes)
    }

    /// Build, sign (authorizer as fee payer) and submit, then confirm before
    /// `deadline`. `Unknown` means the transaction may still land.
    pub async fn submit(&self, instructions: Vec<Instruction>, deadline: Instant) -> TxOutcome {
        let remaining = || deadline.saturating_duration_since(Instant::now());
        let blockhash = match self
            .latest_blockhash(remaining().max(Duration::from_millis(1)))
            .await
        {
            Ok(hash) => hash,
            Err(error) => {
                return TxOutcome::Failed {
                    signature: None,
                    reason: error.to_string(),
                };
            }
        };
        let mut all = vec![program::set_compute_unit_limit(400_000)];
        all.extend(instructions);
        let mut tx = program::unsigned_transaction(&self.authorizer, &all, blockhash);
        if program::sign_transaction(&mut tx, &[&self.key]).is_err() {
            return TxOutcome::Failed {
                signature: None,
                reason: "authorizer is not a signer".into(),
            };
        }
        let signature = bs58::encode(tx.signatures[0].as_ref()).into_string();
        let wire = BASE64.encode(program::serialize_transaction(&tx));
        if remaining().is_zero() {
            return TxOutcome::Failed {
                signature: None,
                reason: "deadline before send".into(),
            };
        }
        match self
            .rpc(
                "sendTransaction",
                json!([wire, {"encoding":"base64","skipPreflight":true,"preflightCommitment":"confirmed"}]),
                remaining().max(Duration::from_millis(1)),
            )
            .await
        {
            Ok(body) if body.get("error").is_some() => {
                // A JSON-RPC error on send means the node refused it outright.
                return TxOutcome::Failed {
                    signature: Some(signature),
                    reason: "send rejected".into(),
                };
            }
            Ok(_) => {}
            // The request may have reached the node: outcome unknown.
            Err(_) => {
                return self.confirm(signature, deadline).await;
            }
        }
        self.confirm(signature, deadline).await
    }

    pub async fn confirm(&self, signature: String, deadline: Instant) -> TxOutcome {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return TxOutcome::Unknown {
                    signature: Some(signature),
                };
            }
            if let Ok(body) = self
                .rpc(
                    "getSignatureStatuses",
                    json!([[signature], {"searchTransactionHistory": false}]),
                    remaining,
                )
                .await
            {
                if let Some(outcome) = parse_signature_status(&body, &signature) {
                    return outcome;
                }
            }
            let pause =
                Duration::from_millis(60).min(deadline.saturating_duration_since(Instant::now()));
            if pause.is_zero() {
                return TxOutcome::Unknown {
                    signature: Some(signature),
                };
            }
            tokio::time::sleep(pause).await;
        }
    }

    /// Look up a past signature without a deadline-sensitive loop (cron).
    pub async fn signature_status(&self, signature: &str) -> Option<TxOutcome> {
        let body = self
            .rpc(
                "getSignatureStatuses",
                json!([[signature], {"searchTransactionHistory": true}]),
                Duration::from_secs(5),
            )
            .await
            .ok()?;
        parse_signature_status(&body, signature)
    }
}

pub fn parse_account_read(body: &Value) -> TeeRead {
    if body.get("error").is_some() {
        return TeeRead::RpcError(format!(
            "rpc_{}",
            body["error"]["code"].as_i64().unwrap_or(0)
        ));
    }
    let Some(result) = body.get("result").filter(|r| r.is_object()) else {
        return TeeRead::RpcError("malformed_response".into());
    };
    let slot = result["context"]["slot"].as_u64();
    let Some(value) = result.get("value") else {
        return TeeRead::RpcError("malformed_response".into());
    };
    if value.is_null() {
        return TeeRead::NotVisible { slot };
    }
    let (Some(owner), Some(data)) = (value["owner"].as_str(), value["data"][0].as_str()) else {
        return TeeRead::RpcError("malformed_account".into());
    };
    match BASE64.decode(data) {
        Ok(data) => TeeRead::Visible {
            data,
            owner: owner.to_owned(),
            slot: slot.unwrap_or(0),
        },
        Err(_) => TeeRead::RpcError("malformed_account".into()),
    }
}

pub fn parse_signature_status(body: &Value, signature: &str) -> Option<TxOutcome> {
    let status = body["result"]["value"].get(0)?;
    if status.is_null() {
        return None;
    }
    if let Some(err) = status.get("err").filter(|e| !e.is_null()) {
        if let Some(code) = err["InstructionError"][1]["Custom"].as_u64() {
            return Some(TxOutcome::ProgramError {
                signature: signature.to_owned(),
                code: code as u32,
            });
        }
        return Some(TxOutcome::Failed {
            signature: Some(signature.to_owned()),
            reason: "transaction failed".into(),
        });
    }
    match status["confirmationStatus"].as_str() {
        Some("confirmed" | "finalized") => Some(TxOutcome::Confirmed {
            signature: signature.to_owned(),
        }),
        _ => None,
    }
}

// ---------------------------------------------------------------- attestation

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttestationMode {
    Report,
    Enforce,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Measurements {
    pub mrtd: String,
    pub rtmr0: String,
    pub rtmr1: String,
    pub rtmr2: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttestationStatus {
    /// `challenge_bound` (fresh quote for our challenge), `failed`, `unchecked`.
    pub hardware: &'static str,
    /// `match`, `mismatch`, `pending` (no allowlist yet: gate G-MB).
    pub measurements: &'static str,
    pub mode: &'static str,
    pub checked_at_ms: u64,
    pub observed: Option<Measurements>,
    pub detail: Option<String>,
}

impl AttestationStatus {
    pub fn unchecked(mode: AttestationMode) -> Self {
        Self {
            hardware: "unchecked",
            measurements: "pending",
            mode: mode_name(mode),
            checked_at_ms: 0,
            observed: None,
            detail: None,
        }
    }

    /// May the authorizer approve? `report` mode never blocks on attestation
    /// (integrity-only until G-MB); `enforce` requires a fresh hardware pass
    /// and an allowlist match.
    pub fn permits_approval(&self, mode: AttestationMode, now_ms: u64) -> bool {
        match mode {
            AttestationMode::Report => true,
            AttestationMode::Enforce => {
                self.hardware == "challenge_bound"
                    && self.measurements == "match"
                    && now_ms.saturating_sub(self.checked_at_ms) < 20 * 60 * 1000
            }
        }
    }
}

pub fn mode_name(mode: AttestationMode) -> &'static str {
    match mode {
        AttestationMode::Report => "report",
        AttestationMode::Enforce => "enforce",
    }
}

/// TDX quote v4 body (TD 1.0 report) offsets after the 48-byte header.
pub fn quote_measurements(raw: &[u8]) -> Option<(Measurements, [u8; 64])> {
    const HEADER: usize = 48;
    let body = raw.get(HEADER..HEADER + 584)?;
    let hex = |range: std::ops::Range<usize>| program::hex(&body[range]);
    // TEE_TCB_SVN 16, MRSEAM 48, MRSIGNERSEAM 48, SEAMATTRIBUTES 8,
    // TDATTRIBUTES 8, XFAM 8, MRTD 48, MRCONFIGID 48, MROWNER 48,
    // MROWNERCONFIG 48, RTMR0..3 48 each, REPORTDATA 64.
    let mrtd = 16 + 48 + 48 + 8 + 8 + 8;
    let rtmr0 = mrtd + 48 * 4;
    let report_data = rtmr0 + 48 * 4;
    Some((
        Measurements {
            mrtd: hex(mrtd..mrtd + 48),
            rtmr0: hex(rtmr0..rtmr0 + 48),
            rtmr1: hex(rtmr0 + 48..rtmr0 + 96),
            rtmr2: hex(rtmr0 + 96..rtmr0 + 144),
        },
        body[report_data..report_data + 64].try_into().ok()?,
    ))
}

pub fn compare_measurements(observed: &Measurements, allowlist: &[Measurements]) -> &'static str {
    if allowlist.is_empty() {
        "pending"
    } else if allowlist.iter().any(|m| m == observed) {
        "match"
    } else {
        "mismatch"
    }
}

/// Fetch a fresh quote bound to our challenge, verify it with DCAP, extract
/// measurements and compare. Never panics; failures become status values.
pub async fn check_attestation(
    http: &Client,
    tee_url: &str,
    mode: AttestationMode,
    allowlist: &[Measurements],
    pccs_url: &str,
) -> AttestationStatus {
    let mut status = AttestationStatus::unchecked(mode);
    status.checked_at_ms = now_ms();
    let mut challenge = [0u8; 64];
    getrandom::fill(&mut challenge).expect("randomness");
    let url = format!("{}/quote", tee_url.trim_end_matches('/'));
    let response = http
        .get(url)
        .query(&[("challenge", BASE64.encode(challenge))])
        .timeout(Duration::from_secs(15))
        .send()
        .await;
    let body: Value = match response {
        Ok(response) => response.json().await.unwrap_or(Value::Null),
        Err(_) => {
            status.hardware = "failed";
            status.detail = Some("quote endpoint unreachable".into());
            return status;
        }
    };
    let Some(raw) = body["quote"].as_str().and_then(|q| BASE64.decode(q).ok()) else {
        status.hardware = "failed";
        status.detail = Some("no quote returned".into());
        return status;
    };
    let Some((observed, report_data)) = quote_measurements(&raw) else {
        status.hardware = "failed";
        status.detail = Some("unparseable quote".into());
        return status;
    };
    status.measurements = compare_measurements(&observed, allowlist);
    status.observed = Some(observed);
    if report_data != challenge {
        status.hardware = "failed";
        status.detail = Some("quote report data does not match our challenge".into());
        return status;
    }
    // Full DCAP chain verification (Intel PCK chain + TCB) is not done in
    // Axum: the Rust verifier (`dcap-qvl`) forces `serde_json/preserve_order`
    // on the whole backend. The quote is bound to our fresh challenge and its
    // measurements are checked; MagicBlock's SDK verifier covers the chain on
    // the client side (contracts.md Changelog, Lane 1 / C).
    let _ = pccs_url;
    status.hardware = "challenge_bound";
    status.detail =
        Some("quote bound to a fresh challenge; DCAP chain not verified in Axum".into());
    status
}

/// MagicBlock Devnet TEE workload measurements pinned in the repo
/// (`shared/cards/tee-measurements.json`, kept equal to the SDK's
/// `MAGICBLOCK_DEVNET_TEE_MEASUREMENTS` by `sdk/test/cards-attestation.test.mjs`).
/// Provenance: confirmed by MagicBlock to ChainPay, 2026-10-04 (direct, unsigned).
pub const PINNED_DEVNET_MEASUREMENTS: &str =
    include_str!("../../../../shared/cards/tee-measurements.json");

/// `CARDS_TEE_MEASUREMENTS` when set (a JSON list, or the whole pinned file
/// with its `allowlist`); otherwise the repo-pinned Devnet allowlist when the
/// authorizer talks to MagicBlock's Devnet TEE. Any other TEE URL without an
/// explicit allowlist stays empty ("pending"), never borrowed from Devnet.
pub fn measurements_for(
    env_value: Option<&str>,
    tee_url: &str,
) -> Result<Vec<Measurements>, &'static str> {
    match env_value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(value) => parse_measurements(value),
        None if tee_url.trim_end_matches('/') == DEVNET_TEE_URL.trim_end_matches('/') => {
            parse_measurements(PINNED_DEVNET_MEASUREMENTS)
        }
        None => Ok(Vec::new()),
    }
}

pub fn parse_measurements(value: &str) -> Result<Vec<Measurements>, &'static str> {
    if value.trim().is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Value =
        serde_json::from_str(value).map_err(|_| "CARDS_TEE_MEASUREMENTS must be a JSON list")?;
    // Accept the pinned file as-is (`{"allowlist": [...]}`) as well as the bare list.
    let items: Vec<Value> = match parsed {
        Value::Array(items) => items,
        Value::Object(mut file) => match file.remove("allowlist") {
            Some(Value::Array(items)) => items,
            _ => return Err("CARDS_TEE_MEASUREMENTS must be a JSON list"),
        },
        _ => return Err("CARDS_TEE_MEASUREMENTS must be a JSON list"),
    };
    items
        .into_iter()
        .map(|item| {
            let field = |name: &str| {
                item[name]
                    .as_str()
                    .filter(|v| v.len() == 96 && v.bytes().all(|b| b.is_ascii_hexdigit()))
                    .map(str::to_ascii_lowercase)
                    .ok_or("each measurement needs 48-byte hex mrtd, rtmr0, rtmr1, rtmr2")
            };
            Ok(Measurements {
                mrtd: field("mrtd")?,
                rtmr0: field("rtmr0")?,
                rtmr1: field("rtmr1")?,
                rtmr2: field("rtmr2")?,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Json, Router,
        routing::{get, post},
    };
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn null_reads_are_not_visible_and_errors_stay_errors() {
        assert_eq!(
            parse_account_read(&json!({"result":{"context":{"slot":5},"value":null}})),
            TeeRead::NotVisible { slot: Some(5) }
        );
        assert_eq!(
            parse_account_read(
                &json!({"result":{"context":{"slot":5},"value":{"owner":"o","data":["AQI=","base64"]}}})
            ),
            TeeRead::Visible {
                data: vec![1, 2],
                owner: "o".into(),
                slot: 5
            }
        );
        assert!(matches!(
            parse_account_read(&json!({"error":{"code":-32000}})),
            TeeRead::RpcError(_)
        ));
        assert!(matches!(
            parse_account_read(&json!({"result":{}})),
            TeeRead::RpcError(_)
        ));
    }

    #[test]
    fn signature_statuses_map_program_errors_and_pending() {
        assert_eq!(
            parse_signature_status(&json!({"result":{"value":[null]}}), "s"),
            None
        );
        assert_eq!(
            parse_signature_status(
                &json!({"result":{"value":[{"err":{"InstructionError":[1,{"Custom":6016}]}}]}}),
                "s"
            ),
            Some(TxOutcome::ProgramError {
                signature: "s".into(),
                code: 6016
            })
        );
        assert_eq!(
            parse_signature_status(
                &json!({"result":{"value":[{"err":null,"confirmationStatus":"confirmed"}]}}),
                "s"
            ),
            Some(TxOutcome::Confirmed {
                signature: "s".into()
            })
        );
        assert_eq!(
            parse_signature_status(
                &json!({"result":{"value":[{"err":null,"confirmationStatus":"processed"}]}}),
                "s"
            ),
            None
        );
    }

    #[test]
    fn authorizer_keys_parse_from_both_formats_and_check_the_public_half() {
        let key = SigningKey::from_bytes(&[3; 32]);
        let mut full = key.to_bytes().to_vec();
        full.extend_from_slice(&key.verifying_key().to_bytes());
        let json = serde_json::to_string(&full).unwrap();
        assert_eq!(
            parse_authorizer_key(&json).unwrap().to_bytes(),
            key.to_bytes()
        );
        assert_eq!(
            parse_authorizer_key(&bs58::encode(&full).into_string())
                .unwrap()
                .to_bytes(),
            key.to_bytes()
        );
        full[40] ^= 1;
        assert!(parse_authorizer_key(&serde_json::to_string(&full).unwrap()).is_err());
        assert!(parse_authorizer_key("[1,2]").is_err());
    }

    #[test]
    fn measurements_compare_in_pending_match_and_mismatch_modes() {
        let m = Measurements {
            mrtd: "a".repeat(96),
            rtmr0: "b".repeat(96),
            rtmr1: "c".repeat(96),
            rtmr2: "d".repeat(96),
        };
        assert_eq!(compare_measurements(&m, &[]), "pending");
        assert_eq!(compare_measurements(&m, std::slice::from_ref(&m)), "match");
        let other = Measurements {
            mrtd: "e".repeat(96),
            ..m.clone()
        };
        assert_eq!(compare_measurements(&m, &[other]), "mismatch");
        let parsed = parse_measurements(&format!(
            r#"[{{"mrtd":"{}","rtmr0":"{}","rtmr1":"{}","rtmr2":"{}"}}]"#,
            "A".repeat(96),
            "b".repeat(96),
            "c".repeat(96),
            "d".repeat(96)
        ))
        .unwrap();
        assert_eq!(parsed[0].mrtd, "a".repeat(96));
        assert!(parse_measurements("[{}]").is_err());
        let status = AttestationStatus {
            hardware: "challenge_bound",
            measurements: "pending",
            mode: "enforce",
            checked_at_ms: 10,
            observed: None,
            detail: None,
        };
        assert!(status.permits_approval(AttestationMode::Report, 10));
        assert!(!status.permits_approval(AttestationMode::Enforce, 10));
        let ok = AttestationStatus {
            measurements: "match",
            ..status
        };
        assert!(ok.permits_approval(AttestationMode::Enforce, 11));
        assert!(!ok.permits_approval(AttestationMode::Enforce, 10 + 21 * 60 * 1000));
    }

    #[test]
    fn pinned_devnet_measurements_match_the_recorded_devnet_quote() {
        let pinned = measurements_for(None, DEVNET_TEE_URL).unwrap();
        assert_eq!(pinned.len(), 1);
        // Same list through the env var, as the bare list or the whole file.
        assert_eq!(
            measurements_for(Some(PINNED_DEVNET_MEASUREMENTS), "https://other.example").unwrap(),
            pinned
        );
        // Another TEE never borrows the Devnet allowlist.
        assert!(
            measurements_for(None, "https://mainnet-tee.example")
                .unwrap()
                .is_empty()
        );
        assert!(
            measurements_for(Some("  "), "https://mainnet-tee.example")
                .unwrap()
                .is_empty()
        );
        // The public quote recorded from devnet-tee on 2026-10-04 matches.
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../sdk/test/fixtures/devnet-tee-quote.json"
        ))
        .unwrap();
        use base64::Engine;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(fixture["quote"].as_str().unwrap())
            .unwrap();
        let (observed, _) = quote_measurements(&raw).unwrap();
        assert_eq!(compare_measurements(&observed, &pinned), "match");
    }

    #[test]
    fn quote_parser_reads_td10_offsets() {
        let mut raw = vec![0u8; 48 + 584];
        let mrtd = 48 + 136;
        raw[mrtd] = 0xab;
        let report = 48 + 136 + 48 * 8;
        raw[report] = 7;
        let (m, data) = quote_measurements(&raw).unwrap();
        assert!(m.mrtd.starts_with("ab"));
        assert_eq!(data[0], 7);
        assert!(quote_measurements(&raw[..100]).is_none());
    }

    #[tokio::test]
    async fn token_is_acquired_once_refreshed_on_401_and_never_leaks() {
        let logins = Arc::new(AtomicUsize::new(0));
        let rpc_calls = Arc::new(AtomicUsize::new(0));
        let (l, c) = (logins.clone(), rpc_calls.clone());
        let app = Router::new()
            .route("/auth/challenge", get(|| async { Json(json!({"challenge":"sign me"})) }))
            .route(
                "/auth/login",
                post(move |Json(body): Json<Value>| {
                    let l = l.clone();
                    async move {
                        let n = l.fetch_add(1, Ordering::SeqCst);
                        assert!(body["signature"].as_str().unwrap().len() > 40);
                        Json(json!({"token": format!("secret-token-{n}"), "expiresAt": now_ms() + 30 * REFRESH_WINDOW_MS}))
                    }
                }),
            )
            .route(
                "/",
                post(move |axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>| {
                    let c = c.clone();
                    async move {
                        let n = c.fetch_add(1, Ordering::SeqCst);
                        if n == 0 {
                            assert_eq!(q["token"], "secret-token-0");
                            return (StatusCode::UNAUTHORIZED, Json(json!({}))).into_response();
                        }
                        assert_eq!(q["token"], "secret-token-1");
                        Json(json!({"result":{"context":{"slot":9},"value":null}})).into_response()
                    }
                }),
            );
        use axum::response::IntoResponse;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = TeeClient::new(&url, SigningKey::from_bytes(&[5; 32])).unwrap();
        let read = client
            .read_account(&Address::from([1; 32]), Duration::from_secs(2))
            .await;
        assert_eq!(read, TeeRead::NotVisible { slot: Some(9) });
        assert_eq!(logins.load(Ordering::SeqCst), 2);
        assert!(!format!("{client:?}").contains("secret-token"));
        task.abort();
    }
}
