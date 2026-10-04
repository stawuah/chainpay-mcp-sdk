//! Private agent cards: Lithic issuer connector (contracts.md §2–§8).
//!
//! Env-gated like `PrivySignerProvider`: with `CARDS_CONNECTOR_ENABLED`
//! unset or anything but `true`, [`CardsConnector::from_env`] returns `None`
//! and every card route answers 404. Axum stays the only backend; policy lives
//! in the `card_policy` program on MagicBlock PER; Convex holds encrypted
//! operational records only.

/// Connector log line. Never pass raw tokens, PANs, amounts or merchants:
/// only `log_id` values and fixed labels. Tests capture every line for the
/// plaintext scanner.
macro_rules! card_log {
    ($($arg:tt)*) => {{
        let line = format!($($arg)*);
        eprintln!("[chainpay cards] {line}");
        #[cfg(test)]
        $crate::connectors::card_issuer::captured_logs().lock().unwrap().push(line);
    }};
}
pub(crate) use card_log;

#[cfg(test)]
pub(crate) fn captured_logs() -> &'static std::sync::Mutex<Vec<String>> {
    static LOGS: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    LOGS.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

pub mod asa;
pub mod capacity;
pub mod checkout;
pub mod crypto;
pub mod events;
#[cfg(test)]
pub(crate) mod fake_per;
pub mod lithic;
pub mod metrics;
pub mod per;
pub mod private_repay;
pub mod program;
pub mod reconcile;
pub mod recovery;
pub mod routes;
#[cfg(test)]
pub(crate) mod sim;
pub mod statements;
pub mod tee;
#[cfg(test)]
mod tests;

use crate::connectors::inbox::{Sealer, StandardWebhooks};
use crate::storage::{CardIndex, CardKind, CardPut, StatusStore, StorageError, StoredCardRecord};
use crypto::RecordCrypto;
use lithic::LithicClient;
use per::Per;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tee::{AttestationMode, AttestationStatus, Measurements};
use tokio::sync::RwLock;

type AttestationFlight = tokio::sync::watch::Receiver<Option<AttestationStatus>>;

/// Empties `CardsConnector::attestation_flight` when dropped.
struct ClearFlight(Arc<CardsConnector>);

impl Drop for ClearFlight {
    fn drop(&mut self) {
        *self
            .0
            .attestation_flight
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

pub const CONNECTOR: &str = "lithic";
/// Reference value that groups an owner's card registry rows.
pub const CARD_LIST_REFERENCE: &str = "card";

#[derive(Debug, thiserror::Error)]
pub enum CardsConfigError {
    #[error("{0}")]
    Invalid(String),
}

fn invalid(message: impl Into<String>) -> CardsConfigError {
    CardsConfigError::Invalid(message.into())
}

#[derive(Clone)]
pub struct CardsConfig {
    pub issuer_writes: bool,
    pub checkout_enabled: bool,
    pub asa_verifier: StandardWebhooks,
    pub events_verifier: StandardWebhooks,
    pub attestation_mode: AttestationMode,
    pub measurements: Vec<Measurements>,
    pub tee_url: String,
    pub pccs_url: String,
    pub cron_secret: Option<String>,
    pub runner_secret: Option<String>,
    /// Total ASA decision budget from request receipt (contracts.md §3.1).
    pub asa_budget: Duration,
    pub embed_origin: Option<String>,
    pub issuer_code: u8,
    /// Statement repayment target (simulated partner account on Devnet).
    pub repayment: statements::RepaymentConfig,
}

impl std::fmt::Debug for CardsConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CardsConfig")
            .field("issuer_writes", &self.issuer_writes)
            .field("checkout_enabled", &self.checkout_enabled)
            .field("asa_secret", &self.asa_verifier.is_configured())
            .field("events_secret", &self.events_verifier.is_configured())
            .field("attestation_mode", &self.attestation_mode)
            .finish_non_exhaustive()
    }
}

pub struct CardsConnector {
    pub config: CardsConfig,
    pub lithic: LithicClient,
    pub per: Per,
    pub crypto: RecordCrypto,
    pub store: StatusStore,
    pub metrics: metrics::CardMetrics,
    base: std::sync::OnceLock<statements::BaseChain>,
    attestation: RwLock<AttestationStatus>,
    /// Single flight: the one attestation check in progress, if any. Every
    /// concurrent caller (cold-start ASAs, the background refresh, cron, the
    /// owner route) waits on the same check instead of starting its own.
    attestation_flight: std::sync::Mutex<Option<AttestationFlight>>,
    #[cfg(test)]
    attestation_checks: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    pub(crate) attestation_panics: std::sync::atomic::AtomicBool,
    card_cache: RwLock<HashMap<String, (StoredCardRecord, Instant)>>,
    http: reqwest::Client,
}

impl std::fmt::Debug for CardsConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CardsConnector")
            .field("config", &self.config)
            .finish_non_exhaustive()
    }
}

impl Sealer for RecordCrypto {
    fn seal(&self, kind: &str, key: &str, plaintext: &[u8]) -> Value {
        RecordCrypto::seal(self, kind, key, plaintext)
    }
    fn open(&self, kind: &str, key: &str, envelope: &Value) -> Option<Vec<u8>> {
        RecordCrypto::open(self, kind, key, envelope).ok()
    }
}

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// A service secret that is set but too short refuses startup instead of
/// silently disabling its route.
fn min_secret(name: &str, min: usize) -> Result<Option<String>, CardsConfigError> {
    match env(name) {
        Some(value) if value.len() < min => {
            Err(invalid(format!("{name} must be at least {min} characters")))
        }
        other => Ok(other),
    }
}

/// `CARDS_REPAYMENT_MINT` (default Devnet USDC) and the simulated partner's
/// token account `CARDS_PARTNER_TOKEN_ACCOUNT` (Devnet only).
fn repayment_config() -> Result<statements::RepaymentConfig, CardsConfigError> {
    let mint = env("CARDS_REPAYMENT_MINT").unwrap_or_else(|| statements::DEVNET_USDC_MINT.into());
    if !statements::is_address(&mint) {
        return Err(invalid("CARDS_REPAYMENT_MINT must be a Solana address"));
    }
    let partner = env("CARDS_PARTNER_TOKEN_ACCOUNT");
    if partner
        .as_deref()
        .is_some_and(|p| !statements::is_address(p))
    {
        return Err(invalid(
            "CARDS_PARTNER_TOKEN_ACCOUNT must be a Solana address",
        ));
    }
    Ok(statements::RepaymentConfig {
        mint,
        partner_token_account: partner,
    })
}

fn flag(name: &str) -> bool {
    env(name).as_deref() == Some("true")
}

impl CardsConnector {
    /// `Ok(None)` unless `CARDS_CONNECTOR_ENABLED=true`. When enabled, every
    /// required secret must be present; a half-configured connector refuses
    /// to start rather than approving without verification.
    pub fn from_env(store: StatusStore) -> Result<Option<Arc<Self>>, CardsConfigError> {
        if !flag("CARDS_CONNECTOR_ENABLED") {
            return Ok(None);
        }
        let api_key = env("LITHIC_API_KEY")
            .or_else(|| env("LITHIC_SANDBOX_API_KEY"))
            .ok_or_else(|| invalid("LITHIC_SANDBOX_API_KEY (or LITHIC_API_KEY) is required when CARDS_CONNECTOR_ENABLED=true"))?;
        let issuer_writes = flag("CARDS_ISSUER_WRITES_ENABLED");
        let lithic = LithicClient::new(
            &env("LITHIC_API_URL").unwrap_or_else(|| lithic::SANDBOX_URL.into()),
            api_key,
            issuer_writes,
        )
        .map_err(invalid)?;
        let key = tee::parse_authorizer_key(&env("CARDS_AUTHORIZER_KEY").ok_or_else(|| {
            invalid("CARDS_AUTHORIZER_KEY is required when CARDS_CONNECTOR_ENABLED=true")
        })?)
        .map_err(invalid)?;
        let tee_url = env("CARDS_TEE_URL").unwrap_or_else(|| tee::DEVNET_TEE_URL.into());
        let tee = tee::TeeClient::new(&tee_url, key).map_err(|e| invalid(e.to_string()))?;
        let crypto =
            RecordCrypto::from_vars(std::env::vars()).map_err(|e| invalid(e.to_string()))?;
        let verifier = |name: &str| {
            StandardWebhooks::new(&env(name).unwrap_or_default())
                .map_err(|e| invalid(format!("{name}: {e}")))
        };
        let attestation_mode = match env("CARDS_TEE_ATTESTATION_MODE").as_deref() {
            None | Some("report") => AttestationMode::Report,
            Some("enforce") => AttestationMode::Enforce,
            Some(_) => {
                return Err(invalid(
                    "CARDS_TEE_ATTESTATION_MODE must be report or enforce",
                ));
            }
        };
        let config = CardsConfig {
            issuer_writes,
            checkout_enabled: flag("CARDS_CHECKOUT_ENABLED"),
            asa_verifier: verifier("LITHIC_ASA_SECRET")?,
            events_verifier: verifier("LITHIC_EVENTS_SECRET")?,
            attestation_mode,
            measurements: tee::measurements_for(env("CARDS_TEE_MEASUREMENTS").as_deref(), &tee_url)
                .map_err(invalid)?,
            tee_url,
            pccs_url: env("CARDS_TEE_PCCS_URL")
                .unwrap_or_else(|| "https://pccs.phala.network".into()),
            cron_secret: min_secret("CRON_SECRET", 16)?,
            runner_secret: min_secret("CARDS_CHECKOUT_RUNNER_SECRET", 32)?,
            asa_budget: Duration::from_millis(
                env("CARDS_ASA_BUDGET_MS")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(2_000u64)
                    .clamp(500, 2_500),
            ),
            embed_origin: env("CARDS_EMBED_TARGET_ORIGIN"),
            issuer_code: program::ISSUER_LITHIC_SANDBOX,
            repayment: repayment_config()?,
        };
        Ok(Some(Arc::new(Self::new(
            config,
            lithic,
            Per::Live(Arc::new(tee)),
            crypto,
            store,
        ))))
    }

    pub fn new(
        config: CardsConfig,
        lithic: LithicClient,
        per: Per,
        crypto: RecordCrypto,
        store: StatusStore,
    ) -> Self {
        let mode = config.attestation_mode;
        Self {
            config,
            lithic,
            per,
            crypto,
            store,
            metrics: metrics::CardMetrics::default(),
            base: std::sync::OnceLock::new(),
            attestation: RwLock::new(AttestationStatus::unchecked(mode)),
            attestation_flight: std::sync::Mutex::new(None),
            #[cfg(test)]
            attestation_checks: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            attestation_panics: std::sync::atomic::AtomicBool::new(false),
            card_cache: RwLock::new(HashMap::new()),
            http: reqwest::Client::new(),
        }
    }

    pub fn authorizer(&self) -> solana_address::Address {
        self.per.authorizer()
    }

    /// Base-layer RPC for repayment receipts. Attached once by the server.
    pub fn attach_base(
        &self,
        rpc: crate::rpc::RpcClient,
        chainpay_program: String,
        cluster: &'static str,
    ) {
        let _ = self.base.set(statements::BaseChain {
            rpc,
            chainpay_program,
            cluster,
        });
    }

    pub fn base(&self) -> Option<statements::BaseChain> {
        self.base.get().cloned()
    }

    pub async fn attestation(&self) -> AttestationStatus {
        self.attestation.read().await.clone()
    }

    /// Re-check attestation if it is older than 10 minutes. Runs in the
    /// background so it never spends the ASA budget.
    pub fn refresh_attestation_if_stale(self: &Arc<Self>) {
        let this = self.clone();
        tokio::spawn(async move {
            this.per.warm().await;
            let stale = now_ms().saturating_sub(this.attestation.read().await.checked_at_ms)
                > 10 * 60 * 1000;
            if stale {
                this.refresh_attestation().await;
            }
        });
    }

    /// Run (or join) the attestation check. Concurrent callers share one
    /// check: the first starts it in its own task, the rest wait for the same
    /// result. The check is detached from its callers, so an ASA that gives up
    /// after its budget slice never cancels the check the others are waiting on.
    pub async fn refresh_attestation(self: &Arc<Self>) -> AttestationStatus {
        let mut receiver = {
            let mut flight = self
                .attestation_flight
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            match flight.as_ref() {
                Some(receiver) => receiver.clone(),
                None => {
                    let (sender, receiver) = tokio::sync::watch::channel(None);
                    *flight = Some(receiver.clone());
                    let this = self.clone();
                    tokio::spawn(async move {
                        // Clears the slot however the task ends (a panic in
                        // the verifier included), so the next caller starts a
                        // fresh check instead of joining a dead flight.
                        let _clear = ClearFlight(this.clone());
                        let status = this.check_attestation_now().await;
                        *this.attestation.write().await = status.clone();
                        // Clear the flight before publishing, so a caller that
                        // arrives after the result starts a fresh check.
                        drop(_clear);
                        let _ = sender.send(Some(status));
                    });
                    receiver
                }
            }
        };
        let landed = receiver
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|status| status.clone());
        match landed {
            Some(status) => status,
            // The check task died (panic): report the last known status.
            None => self.attestation.read().await.clone(),
        }
    }

    async fn check_attestation_now(&self) -> AttestationStatus {
        #[cfg(test)]
        {
            self.attestation_checks
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if self
                .attestation_panics
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                panic!("verifier blew up (test)");
            }
        }
        let status = if matches!(self.per, Per::Live(_)) {
            tee::check_attestation(
                &self.http,
                &self.config.tee_url,
                self.config.attestation_mode,
                &self.config.measurements,
                &self.config.pccs_url,
            )
            .await
        } else {
            #[cfg(test)]
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            self.attestation.read().await.clone()
        };
        if status.measurements == "mismatch" || status.hardware == "failed" {
            card_log!(
                "attestation {} / {} ({})",
                status.hardware,
                status.measurements,
                status.detail.as_deref().unwrap_or("-")
            );
        }
        status
    }

    #[cfg(test)]
    pub fn attestation_checks(&self) -> usize {
        self.attestation_checks
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    #[cfg(test)]
    pub async fn set_attestation(&self, status: AttestationStatus) {
        *self.attestation.write().await = status;
    }

    // ---------------------------------------------------------- card registry

    pub async fn card_by_token(
        &self,
        card_token: &str,
    ) -> Result<Option<StoredCardRecord>, StorageError> {
        let reference = program::card_reference(card_token);
        if let Some((row, at)) = self.card_cache.read().await.get(&reference) {
            if at.elapsed() < Duration::from_secs(30) {
                return Ok(Some(row.clone()));
            }
        }
        let row = self.store.find_card_by_reference(&reference).await?;
        if let Some(row) = &row {
            self.card_cache
                .write()
                .await
                .insert(reference, (row.clone(), Instant::now()));
        }
        Ok(row)
    }

    pub async fn card(&self, card_id: &str) -> Result<Option<StoredCardRecord>, StorageError> {
        if !is_card_id(card_id) {
            return Ok(None);
        }
        self.store
            .get_card_record(CardKind::Cards, &card_key(card_id))
            .await
    }

    pub fn card_issuer(&self, row: &StoredCardRecord) -> Option<CardIssuerSecret> {
        self.crypto
            .open_json(CardKind::Cards.as_str(), &row.key, &row.record["issuer"])
            .ok()
    }

    pub fn card_label(&self, row: &StoredCardRecord) -> String {
        self.crypto
            .open_json::<String>(CardKind::Cards.as_str(), &row.key, &row.record["label"])
            .unwrap_or_default()
    }

    /// Read-modify-write a card registry row with compare-and-swap retries.
    pub async fn update_card<F>(
        &self,
        card_id: &str,
        mut f: F,
    ) -> Result<Option<StoredCardRecord>, StorageError>
    where
        F: FnMut(&mut Value),
    {
        let key = card_key(card_id);
        for _ in 0..5 {
            let Some(row) = self.store.get_card_record(CardKind::Cards, &key).await? else {
                return Ok(None);
            };
            let mut record = row.record.clone();
            f(&mut record);
            match self
                .store
                .put_card_record(
                    CardKind::Cards,
                    &key,
                    row.index.clone(),
                    record,
                    Some(row.rev()),
                    updated_now(),
                )
                .await?
            {
                CardPut::Written(row) => {
                    self.card_cache
                        .write()
                        .await
                        .retain(|_, (cached, _)| cached.key != key);
                    return Ok(Some(row));
                }
                CardPut::Conflict(_) => continue,
            }
        }
        Err(StorageError::Remote(
            "card record update conflicted repeatedly".into(),
        ))
    }

    // ------------------------------------------------- transaction lifecycle

    pub fn txn_key(token: &str) -> String {
        format!("asa:{token}")
    }

    pub fn txn_index(owner: &str, card_id: &str) -> CardIndex {
        CardIndex {
            owner: Some(owner.to_owned()),
            connector: Some(CONNECTOR.into()),
            reference: Some(card_id.to_owned()),
            idempotency: None,
        }
    }

    pub async fn txn(&self, token: &str) -> Result<Option<StoredCardRecord>, StorageError> {
        self.store
            .get_card_record(CardKind::CardEvents, &Self::txn_key(token))
            .await
    }

    /// Compare-and-swap update with retries. `f` returns `false` to skip the
    /// write (nothing changed).
    pub async fn update_txn<F>(
        &self,
        token: &str,
        mut f: F,
    ) -> Result<Option<StoredCardRecord>, StorageError>
    where
        F: FnMut(&mut Value) -> bool,
    {
        let key = Self::txn_key(token);
        for _ in 0..6 {
            let Some(row) = self
                .store
                .get_card_record(CardKind::CardEvents, &key)
                .await?
            else {
                return Ok(None);
            };
            let mut record = row.record.clone();
            if !f(&mut record) {
                return Ok(Some(row));
            }
            record["updatedAt"] = json!(rfc3339(now_ms()));
            match self
                .store
                .put_card_record(
                    CardKind::CardEvents,
                    &key,
                    row.index.clone(),
                    record,
                    Some(row.rev()),
                    updated_now(),
                )
                .await?
            {
                CardPut::Written(row) => return Ok(Some(row)),
                CardPut::Conflict(_) => continue,
            }
        }
        Err(StorageError::Remote(
            "transaction record update conflicted repeatedly".into(),
        ))
    }

    pub fn open_provider(&self, row: &StoredCardRecord) -> Value {
        self.crypto
            .open_json::<Value>(
                CardKind::CardEvents.as_str(),
                &row.key,
                &row.record["provider"],
            )
            .unwrap_or(Value::Null)
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardIssuerSecret {
    pub card_token: String,
    pub last_four: String,
    /// Hex 32 bytes, salt of `CardBinding.issuer_card_ref_hash`.
    pub ref_salt: String,
}

// ------------------------------------------------------------------ helpers

pub fn card_key(card_id: &str) -> String {
    format!("card:{card_id}")
}

pub fn is_card_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static UPDATED_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Sortable `updated` column: milliseconds × 1000 + a process-local counter,
/// so rows written in the same millisecond keep a stable order.
pub fn updated_now() -> u64 {
    now_ms() * 1000 + UPDATED_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) % 1000
}

/// RFC 3339 UTC with millisecond precision. Times are stored as strings so a
/// 13-digit millisecond count never looks like a card number in plaintext.
pub fn rfc3339(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

/// Short opaque id for logs: never a raw token, PAN, amount or merchant.
pub fn log_id(value: &str) -> String {
    use sha2::Digest;
    program::hex(&sha2::Sha256::digest(format!("chainpay-log:v1\n{value}").as_bytes())[..6])
}

pub fn cents(value: u64) -> String {
    value.to_string()
}

pub fn parse_cents(value: &str) -> Option<u64> {
    if value.is_empty()
        || value.len() > 16
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

// ---------------------------------------------------------------- merchants

/// Display name for a transaction row: fixture name, else the issuer descriptor.
pub fn merchant_display(cards: &CardsConnector, row: &StoredCardRecord) -> String {
    let provider = cards.open_provider(row);
    let acceptor = provider["merchant"]["acceptorId"].as_str().unwrap_or("");
    merchant_by_acceptor(acceptor)
        .map(|m| m.display_name.to_owned())
        .unwrap_or_else(|| {
            provider["merchant"]["descriptor"]
                .as_str()
                .unwrap_or("Merchant")
                .to_owned()
        })
}

/// Registered fixture merchants (contracts.md §3.4 `merchantRef`). The demo
/// extends `demo-merchant/`: one shop is on the card's allowlist, one is not.
/// Acceptor ids stay within Lithic's 15-character `merchant_acceptor_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merchant {
    pub reference: &'static str,
    pub display_name: &'static str,
    pub acceptor_id: &'static str,
    pub descriptor: &'static str,
    pub mcc: u16,
}

pub const MERCHANTS: [Merchant; 2] = [
    Merchant {
        reference: "demo-approved",
        display_name: "Data API credits",
        acceptor_id: "DEMO-DATAAPI",
        descriptor: "DATA API CREDITS",
        mcc: 5734,
    },
    Merchant {
        reference: "demo-unapproved",
        display_name: "Unapproved shop",
        acceptor_id: "DEMO-OTHERSHOP",
        descriptor: "UNAPPROVED SHOP",
        mcc: 5999,
    },
];

pub fn merchant_by_ref(reference: &str) -> Option<&'static Merchant> {
    MERCHANTS.iter().find(|m| m.reference == reference)
}

pub fn merchant_by_hash(hash: &[u8; 32]) -> Option<&'static Merchant> {
    MERCHANTS
        .iter()
        .find(|m| program::merchant_id_hash(m.acceptor_id) == *hash)
}

pub fn merchant_by_acceptor(acceptor_id: &str) -> Option<&'static Merchant> {
    MERCHANTS
        .iter()
        .find(|m| m.acceptor_id.eq_ignore_ascii_case(acceptor_id.trim()))
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn rfc3339_formats_utc_milliseconds() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(1_759_536_000_123), "2025-10-04T00:00:00.123Z");
        assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn cent_strings_are_exact_integers() {
        assert_eq!(parse_cents("0"), Some(0));
        assert_eq!(parse_cents("2000"), Some(2000));
        assert_eq!(parse_cents("020"), None);
        assert_eq!(parse_cents("20.00"), None);
        assert_eq!(parse_cents("-1"), None);
        assert_eq!(parse_cents("12345678901234567"), None);
    }

    #[test]
    fn log_ids_are_short_and_not_reversible() {
        let id = log_id("7ef7d65c-9023-4da3-b113-3b8583fd7951");
        assert_eq!(id.len(), 12);
        assert!(!id.contains("7ef7"));
    }
}
