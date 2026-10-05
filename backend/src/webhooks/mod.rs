//! Owner webhooks: signed `payment.receipt_ready` notifications to an
//! owner's HTTPS endpoint (docs/guides/owner-webhooks.md).
//!
//! They notify; they never authorize. An event exists only after the relay
//! verified a finalized, matching receipt, and nothing a receiver answers can
//! change, fail or repeat a payment. Delivery is at-least-once: receivers
//! dedupe by `webhook-id` (the stable event id).
//!
//! Off unless `OWNER_WEBHOOKS_ENABLED=true`; then every route answers 404 and
//! no event is written.

pub mod dispatch;
pub mod ssrf;

use crate::connectors::card_issuer::crypto::RecordCrypto;
use crate::storage::WebhookEvent;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde_json::{Value, json};
use sha2_010::{Digest, Sha256};
use std::{future::Future, net::SocketAddr, pin::Pin, sync::Arc, time::Duration};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub const RECEIPT_READY: &str = "payment.receipt_ready";
pub const RECEIPT_READY_VERSION: u32 = 1;
/// Active endpoints one owner can have.
pub const MAX_ACTIVE_SUBSCRIPTIONS: usize = 5;
/// After a rotation the previous secret still signs for this long.
pub const ROTATION_OVERLAP_MS: u64 = 24 * 60 * 60 * 1000;
const SECRET_KIND: &str = "owner_webhook_secret";

#[derive(Debug, thiserror::Error)]
pub enum WebhookConfigError {
    #[error("{0}")]
    Invalid(String),
}

fn invalid(message: impl Into<String>) -> WebhookConfigError {
    WebhookConfigError::Invalid(message.into())
}

/// Everything the owner webhook routes and dispatcher need.
pub struct OwnerWebhooks {
    crypto: RecordCrypto,
    pub cron_secret: Option<String>,
    /// Public web origin for `receipt_url` (`<origin>/verify/<pda>`).
    pub app_url: String,
    pub resolver: Arc<dyn ssrf::Resolver>,
    pub transport: Arc<dyn Transport>,
}

impl std::fmt::Debug for OwnerWebhooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OwnerWebhooks")
            .field("app_url", &self.app_url)
            .finish_non_exhaustive()
    }
}

impl OwnerWebhooks {
    pub fn new(
        crypto: RecordCrypto,
        cron_secret: Option<String>,
        app_url: String,
        resolver: Arc<dyn ssrf::Resolver>,
        transport: Arc<dyn Transport>,
    ) -> Self {
        Self {
            crypto,
            cron_secret,
            app_url: app_url.trim_end_matches('/').to_owned(),
            resolver,
            transport,
        }
    }

    /// `OWNER_WEBHOOKS_ENABLED=true` requires `OWNER_WEBHOOKS_SECRET_KID`, a
    /// matching `OWNER_WEBHOOKS_SECRET_KEY_<KID>` (32 random bytes, base64),
    /// `CRON_SECRET` (16+ characters) and `CHAINPAY_APP_URL`.
    pub fn from_env() -> Result<Option<Self>, WebhookConfigError> {
        Self::from_vars(std::env::vars())
    }

    pub fn from_vars(
        vars: impl Iterator<Item = (String, String)>,
    ) -> Result<Option<Self>, WebhookConfigError> {
        let vars: Vec<(String, String)> = vars.collect();
        let get = |name: &str| {
            vars.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        match get("OWNER_WEBHOOKS_ENABLED").as_deref() {
            None | Some("false") => return Ok(None),
            Some("true") => {}
            Some(_) => return Err(invalid("OWNER_WEBHOOKS_ENABLED must be true or false")),
        }
        // Reuse the card connector's AES-GCM envelope code under separate
        // variable names and keys; the envelope's AAD binds the subscription.
        let mapped = vars.iter().filter_map(|(name, value)| {
            if name == "OWNER_WEBHOOKS_SECRET_KID" {
                Some(("CARDS_RECORD_KID".to_owned(), value.clone()))
            } else {
                name.strip_prefix("OWNER_WEBHOOKS_SECRET_KEY_")
                    .map(|kid| (format!("CARDS_RECORD_KEY_{kid}"), value.clone()))
            }
        });
        let crypto = RecordCrypto::from_vars(mapped).map_err(|_| {
            invalid("OWNER_WEBHOOKS_SECRET_KID and a matching OWNER_WEBHOOKS_SECRET_KEY_<KID> (32 bytes, base64) are required")
        })?;
        let cron_secret = get("CRON_SECRET")
            .filter(|secret| secret.len() >= 16)
            .ok_or_else(|| {
                invalid("CRON_SECRET (16+ characters) is required for owner webhooks")
            })?;
        let app_url = get("CHAINPAY_APP_URL")
            .ok_or_else(|| invalid("CHAINPAY_APP_URL is required for owner webhooks"))?;
        let parsed =
            reqwest::Url::parse(&app_url).map_err(|_| invalid("CHAINPAY_APP_URL must be a URL"))?;
        let local = matches!(parsed.host_str(), Some("localhost" | "127.0.0.1"));
        if !(parsed.scheme() == "https" || (local && parsed.scheme() == "http"))
            || parsed.path() != "/"
            || parsed.query().is_some()
            || !parsed.username().is_empty()
        {
            return Err(invalid("CHAINPAY_APP_URL must be an https:// origin"));
        }
        Ok(Some(Self::new(
            crypto,
            Some(cron_secret),
            app_url,
            Arc::new(ssrf::SystemResolver),
            Arc::new(ReqwestTransport::default()),
        )))
    }

    /// A new signing secret: `whsec_` + 32 random bytes, base64. Returned to
    /// the owner once; only its sealed form is stored.
    pub fn generate_secret() -> String {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).expect("operating system randomness");
        format!("whsec_{}", BASE64.encode(bytes))
    }

    fn seal(&self, subscription_id: &str, secret: &str) -> Value {
        self.crypto
            .seal(SECRET_KIND, subscription_id, secret.as_bytes())
    }

    /// Sealed secret set for a new endpoint.
    pub fn initial_secrets(&self, subscription_id: &str, secret: &str, now: u64) -> Value {
        json!([{ "envelope": self.seal(subscription_id, secret), "created_at_ms": now, "expires_at_ms": null }])
    }

    /// New current secret first; the previous current one keeps signing until
    /// `now + ROTATION_OVERLAP_MS`. Expired entries are dropped; at most two remain.
    pub fn rotated_secrets(
        &self,
        subscription_id: &str,
        existing: &Value,
        secret: &str,
        now: u64,
    ) -> (Value, Option<u64>) {
        let mut next = vec![
            json!({ "envelope": self.seal(subscription_id, secret), "created_at_ms": now, "expires_at_ms": null }),
        ];
        let expires = now + ROTATION_OVERLAP_MS;
        let previous = existing
            .as_array()
            .into_iter()
            .flatten()
            .find(|entry| entry["expires_at_ms"].is_null());
        if let Some(previous) = previous {
            let mut previous = previous.clone();
            previous["expires_at_ms"] = json!(expires);
            next.push(previous);
        }
        let overlap = (next.len() > 1).then_some(expires);
        (Value::Array(next), overlap)
    }

    /// Raw HMAC keys still allowed to sign, current first.
    pub fn signing_keys(
        &self,
        subscription_id: &str,
        secrets: &Value,
        now: u64,
    ) -> Result<Vec<Vec<u8>>, &'static str> {
        let mut keys = Vec::new();
        for entry in secrets.as_array().ok_or("malformed secret set")? {
            if entry["expires_at_ms"].as_u64().is_some_and(|at| at <= now) {
                continue;
            }
            let plaintext = self
                .crypto
                .open(SECRET_KIND, subscription_id, &entry["envelope"])
                .map_err(|_| "secret could not be opened")?;
            let text = std::str::from_utf8(&plaintext).map_err(|_| "malformed secret")?;
            keys.push(decode_secret(text).ok_or("malformed secret")?);
        }
        if keys.is_empty() {
            return Err("no active secret");
        }
        Ok(keys)
    }

    /// When the previous secret stops signing, if a rotation is in overlap.
    pub fn previous_secret_expiry(secrets: &Value, now: u64) -> Option<u64> {
        secrets
            .as_array()?
            .iter()
            .filter_map(|entry| entry["expires_at_ms"].as_u64())
            .find(|at| *at > now)
    }

    pub fn receipt_url(&self, receipt: &str) -> String {
        format!("{}/verify/{receipt}", self.app_url)
    }
}

/// `whsec_<base64>` (or bare base64) to raw key bytes, as receivers decode it.
pub fn decode_secret(secret: &str) -> Option<Vec<u8>> {
    let encoded = secret.strip_prefix("whsec_").unwrap_or(secret);
    BASE64.decode(encoded).ok().filter(|key| key.len() >= 16)
}

/// Standard Webhooks `webhook-signature` value: one `v1,<sig>` per key.
pub fn signature_header(keys: &[Vec<u8>], id: &str, timestamp: i64, body: &[u8]) -> String {
    keys.iter()
        .map(|key| {
            format!(
                "v1,{}",
                crate::connectors::inbox::StandardWebhooks::sign(key, id, timestamp, body)
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Stable per receipt, type and version, so a retry, a crash repair and a
/// manual redelivery all carry the same id.
pub fn event_id(event_type: &str, version: u32, receipt_address: &str) -> String {
    let digest = Sha256::digest(format!("{event_type}:{version}:{receipt_address}").as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("evt_{hex}")
}

pub fn subscription_id() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("operating system randomness");
    format!(
        "whk_{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

/// What a receipt-ready event says. Deliberately no invoice, recipient,
/// agent or customer data: the receiver can read those from the public
/// receipt (`receipt_url`) if it needs them.
#[derive(Debug, Clone, PartialEq)]
pub struct ReceiptReady {
    pub operation_id: String,
    /// `payment` (single) or `transaction` (batch; one event per receipt).
    pub operation_kind: &'static str,
    pub cluster: String,
    pub receipt_address: String,
    pub mint: Option<String>,
    pub amount: Option<u64>,
    pub decimals: Option<u8>,
}

impl OwnerWebhooks {
    pub fn receipt_ready_event(
        &self,
        owner_wallet: &str,
        data: &ReceiptReady,
        occurred_at_ms: u64,
    ) -> WebhookEvent {
        let id = event_id(RECEIPT_READY, RECEIPT_READY_VERSION, &data.receipt_address);
        let body = json!({
            "id": id,
            "type": RECEIPT_READY,
            "version": RECEIPT_READY_VERSION,
            "created_at": iso8601(occurred_at_ms),
            "data": {
                "operation_id": data.operation_id,
                "operation_kind": data.operation_kind,
                "cluster": data.cluster,
                "receipt_pda": data.receipt_address,
                "receipt_url": self.receipt_url(&data.receipt_address),
                "mint": data.mint,
                // Base units as a string: never rounded by a JSON number.
                "amount": data.amount.map(|amount| amount.to_string()),
                "decimals": data.decimals,
            }
        });
        WebhookEvent {
            event_id: id,
            owner_wallet: owner_wallet.into(),
            event_type: RECEIPT_READY.into(),
            version: RECEIPT_READY_VERSION,
            receipt_address: data.receipt_address.clone(),
            body: serde_json::to_string(&body).expect("serializable"),
            occurred_at_ms,
            created_at_ms: occurred_at_ms,
        }
    }
}

/// Decimals for mints the relay already knows, so most events need no extra
/// chain read. Others are read from the mint account (byte 44 of an SPL mint).
pub fn known_decimals(mint: &str) -> Option<u8> {
    match mint {
        // Devnet USDC and Devnet PYUSD.
        "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        | "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM" => Some(6),
        _ => None,
    }
}

pub fn mint_decimals_from_account(owner: &str, data: &[u8]) -> Option<u8> {
    const SPL_TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const TOKEN_2022: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    // Mint layout: 36 bytes authority option, 8 supply, then decimals, then
    // is_initialized. Token-2022 extends it after byte 82.
    ((owner == SPL_TOKEN || owner == TOKEN_2022) && data.len() >= 82 && data[45] == 1)
        .then(|| data[44])
}

/// RFC 3339 UTC with milliseconds, without a date crate.
pub fn iso8601(ms: u64) -> String {
    let secs = ms / 1000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60,
        ms % 1000
    )
}

/// One signed POST. Implemented by [`ReqwestTransport`]; tests substitute a
/// local receiver.
pub trait Transport: Send + Sync {
    fn send<'a>(
        &'a self,
        request: OutboundRequest,
    ) -> BoxFuture<'a, Result<OutboundResponse, SendError>>;
}

#[derive(Debug, Clone)]
pub struct OutboundRequest {
    pub url: reqwest::Url,
    /// The address `ssrf::resolve_public` checked. The client connects here
    /// and never resolves the host name again.
    pub pinned: SocketAddr,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundResponse {
    pub status: u16,
    pub retry_after_secs: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SendError {
    Timeout,
    Connect,
    Other,
}

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Response bytes read (then discarded) so the connection can close cleanly.
pub const MAX_RESPONSE_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct ReqwestTransport {
    pub connect_timeout: Duration,
    pub timeout: Duration,
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self {
            connect_timeout: CONNECT_TIMEOUT,
            timeout: REQUEST_TIMEOUT,
        }
    }
}

impl Transport for ReqwestTransport {
    fn send<'a>(
        &'a self,
        request: OutboundRequest,
    ) -> BoxFuture<'a, Result<OutboundResponse, SendError>> {
        Box::pin(async move {
            let mut builder = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .connect_timeout(self.connect_timeout)
                .timeout(self.timeout)
                .user_agent("ChainPay-Webhooks/1");
            if let Some(url::Host::Domain(host)) = request.url.host() {
                builder = builder.resolve(host, request.pinned);
            }
            let client = builder.build().map_err(|_| SendError::Other)?;
            let mut call = client.post(request.url.clone()).body(request.body);
            for (name, value) in &request.headers {
                call = call.header(*name, value);
            }
            let mut response = call.send().await.map_err(classify)?;
            let status = response.status().as_u16();
            let retry_after_secs = response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.trim().parse::<u64>().ok());
            let mut read = 0usize;
            while read < MAX_RESPONSE_BYTES {
                match response.chunk().await {
                    Ok(Some(chunk)) => read += chunk.len(),
                    _ => break,
                }
            }
            Ok(OutboundResponse {
                status,
                retry_after_secs,
            })
        })
    }
}

fn classify(error: reqwest::Error) -> SendError {
    if error.is_timeout() {
        SendError::Timeout
    } else if error.is_connect() {
        SendError::Connect
    } else {
        SendError::Other
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use std::collections::HashMap;

    pub fn crypto() -> RecordCrypto {
        RecordCrypto::new("w1", HashMap::from([("w1".to_owned(), [9u8; 32])])).unwrap()
    }

    /// Every host resolves to the current answer; tests flip it to model
    /// a DNS change between registration and dispatch.
    pub struct FixedResolver(pub std::sync::Mutex<Vec<std::net::IpAddr>>);
    impl ssrf::Resolver for FixedResolver {
        fn resolve<'a>(
            &'a self,
            _: &'a str,
            _: u16,
        ) -> BoxFuture<'a, std::io::Result<Vec<std::net::IpAddr>>> {
            let answer = self.0.lock().unwrap().clone();
            Box::pin(async move { Ok(answer) })
        }
    }

    /// Forwards to a local plain-HTTP receiver, recording the pinned address,
    /// so receiver behaviour (status, delay, headers, raw body) is real HTTP.
    pub struct LocalTransport {
        pub target: SocketAddr,
        pub pinned: std::sync::Mutex<Vec<SocketAddr>>,
    }
    impl Transport for LocalTransport {
        fn send<'a>(
            &'a self,
            request: OutboundRequest,
        ) -> BoxFuture<'a, Result<OutboundResponse, SendError>> {
            self.pinned.lock().unwrap().push(request.pinned);
            let mut url = request.url.clone();
            url.set_scheme("http").unwrap();
            url.set_host(Some(&self.target.ip().to_string())).unwrap();
            url.set_port(Some(self.target.port())).unwrap();
            Box::pin(async move {
                ReqwestTransport {
                    connect_timeout: Duration::from_secs(1),
                    timeout: Duration::from_millis(800),
                }
                .send(OutboundRequest { url, ..request })
                .await
            })
        }
    }

    pub const CRON: &str = "cron-secret-for-tests-only";

    pub fn webhooks(target: SocketAddr) -> (OwnerWebhooks, Arc<LocalTransport>) {
        let (hooks, transport, _) = webhooks_with_resolver(target);
        (hooks, transport)
    }

    pub fn webhooks_with_resolver(
        target: SocketAddr,
    ) -> (OwnerWebhooks, Arc<LocalTransport>, Arc<FixedResolver>) {
        let transport = Arc::new(LocalTransport {
            target,
            pinned: Default::default(),
        });
        let resolver = Arc::new(FixedResolver(std::sync::Mutex::new(vec![
            "93.184.216.34".parse().unwrap(),
        ])));
        (
            OwnerWebhooks::new(
                crypto(),
                Some(CRON.into()),
                "https://app.chainpay.test".into(),
                resolver.clone(),
                transport.clone(),
            ),
            transport,
            resolver,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::inbox::{StandardWebhooks, WebhookRejection, WebhookVerifier};
    use axum::http::{HeaderMap, HeaderValue};

    #[test]
    fn iso_dates_match_known_instants() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_759_651_200_123), "2025-10-05T08:00:00.123Z");
        assert_eq!(iso8601(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn event_ids_are_stable_per_receipt_type_and_version() {
        let a = event_id(RECEIPT_READY, 1, "R1");
        assert_eq!(a, event_id(RECEIPT_READY, 1, "R1"));
        assert_ne!(a, event_id(RECEIPT_READY, 2, "R1"));
        assert_ne!(a, event_id(RECEIPT_READY, 1, "R2"));
        assert!(a.starts_with("evt_") && a.len() == 36);
    }

    #[test]
    fn payload_is_minimal_and_exact() {
        let (hooks, _) = test_support::webhooks("127.0.0.1:1".parse().unwrap());
        let event = hooks.receipt_ready_event(
            "owner",
            &ReceiptReady {
                operation_id: "payment_abc".into(),
                operation_kind: "payment",
                cluster: "devnet".into(),
                receipt_address: "R1".into(),
                mint: Some("M".into()),
                amount: Some(u64::MAX),
                decimals: Some(6),
            },
            1_000,
        );
        let body: Value = serde_json::from_str(&event.body).unwrap();
        assert_eq!(body["id"], event.event_id);
        assert_eq!(body["type"], "payment.receipt_ready");
        assert_eq!(body["version"], 1);
        assert_eq!(body["data"]["amount"], "18446744073709551615");
        assert_eq!(
            body["data"]["receipt_url"],
            "https://app.chainpay.test/verify/R1"
        );
        let keys: Vec<_> = body["data"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(
            keys,
            [
                "amount",
                "cluster",
                "decimals",
                "mint",
                "operation_id",
                "operation_kind",
                "receipt_pda",
                "receipt_url"
            ]
        );
    }

    #[test]
    fn rotation_keeps_old_and_new_signing_during_overlap() {
        let (hooks, _) = test_support::webhooks("127.0.0.1:1".parse().unwrap());
        let first = OwnerWebhooks::generate_secret();
        let sealed = hooks.initial_secrets("whk_1", &first, 0);
        assert!(
            !sealed.to_string().contains(&first[6..]),
            "plaintext never stored"
        );
        let second = OwnerWebhooks::generate_secret();
        let (rotated, overlap) = hooks.rotated_secrets("whk_1", &sealed, &second, 10);
        assert_eq!(overlap, Some(10 + ROTATION_OVERLAP_MS));
        let keys = hooks.signing_keys("whk_1", &rotated, 11).unwrap();
        assert_eq!(
            keys,
            vec![
                decode_secret(&second).unwrap(),
                decode_secret(&first).unwrap()
            ]
        );
        // After the overlap only the new secret signs.
        let keys = hooks
            .signing_keys("whk_1", &rotated, 10 + ROTATION_OVERLAP_MS)
            .unwrap();
        assert_eq!(keys, vec![decode_secret(&second).unwrap()]);
        // A sealed set cannot be moved to another subscription.
        assert!(hooks.signing_keys("whk_2", &sealed, 0).is_err());
        // A second rotation keeps at most two entries.
        let third = OwnerWebhooks::generate_secret();
        let (again, _) = hooks.rotated_secrets("whk_1", &rotated, &third, 20);
        assert_eq!(again.as_array().unwrap().len(), 2);

        // The documented receiver verifies with either secret during overlap.
        let header = signature_header(
            &hooks.signing_keys("whk_1", &rotated, 11).unwrap(),
            "evt_1",
            1_000,
            b"{}",
        );
        for secret in [&first, &second] {
            let verifier = StandardWebhooks::new(secret).unwrap();
            let mut headers = HeaderMap::new();
            headers.insert("webhook-id", HeaderValue::from_static("evt_1"));
            headers.insert("webhook-timestamp", HeaderValue::from_static("1000"));
            headers.insert("webhook-signature", HeaderValue::from_str(&header).unwrap());
            assert!(verifier.verify(&headers, b"{}", 1_000).is_ok());
            // Replay outside the tolerance is refused, as is a changed body.
            assert_eq!(
                verifier.verify(&headers, b"{}", 1_000 + 301).err(),
                Some(WebhookRejection::Stale)
            );
            assert_eq!(
                verifier.verify(&headers, b"{ }", 1_000).err(),
                Some(WebhookRejection::BadSignature)
            );
        }
        let stranger = StandardWebhooks::new(&OwnerWebhooks::generate_secret()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("webhook-id", HeaderValue::from_static("evt_1"));
        headers.insert("webhook-timestamp", HeaderValue::from_static("1000"));
        headers.insert("webhook-signature", HeaderValue::from_str(&header).unwrap());
        assert_eq!(
            stranger.verify(&headers, b"{}", 1_000).err(),
            Some(WebhookRejection::BadSignature)
        );
    }

    #[test]
    fn configuration_is_explicit() {
        let vars = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect::<Vec<_>>()
                .into_iter()
        };
        assert!(OwnerWebhooks::from_vars(vars(&[])).unwrap().is_none());
        assert!(OwnerWebhooks::from_vars(vars(&[("OWNER_WEBHOOKS_ENABLED", "yes")])).is_err());
        assert!(OwnerWebhooks::from_vars(vars(&[("OWNER_WEBHOOKS_ENABLED", "true")])).is_err());
        let key = BASE64.encode([3u8; 32]);
        let base = [
            ("OWNER_WEBHOOKS_ENABLED", "true"),
            ("OWNER_WEBHOOKS_SECRET_KID", "k1"),
            ("OWNER_WEBHOOKS_SECRET_KEY_k1", key.as_str()),
            ("CRON_SECRET", "0123456789abcdef"),
            ("CHAINPAY_APP_URL", "https://app.example.com"),
        ];
        assert!(OwnerWebhooks::from_vars(vars(&base)).unwrap().is_some());
        // Card keys never stand in for webhook keys.
        let card_only = [
            ("OWNER_WEBHOOKS_ENABLED", "true"),
            ("CARDS_RECORD_KID", "k1"),
            ("CARDS_RECORD_KEY_k1", key.as_str()),
            ("CRON_SECRET", "0123456789abcdef"),
            ("CHAINPAY_APP_URL", "https://app.example.com"),
        ];
        assert!(OwnerWebhooks::from_vars(vars(&card_only)).is_err());
        let mut short = base;
        short[3] = ("CRON_SECRET", "short");
        assert!(OwnerWebhooks::from_vars(vars(&short)).is_err());
        let mut http = base;
        http[4] = ("CHAINPAY_APP_URL", "http://app.example.com");
        assert!(OwnerWebhooks::from_vars(vars(&http)).is_err());
    }

    #[test]
    fn mint_decimals_come_from_known_mints_or_the_mint_account() {
        assert_eq!(
            known_decimals("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
            Some(6)
        );
        let mut data = vec![0u8; 82];
        data[44] = 9;
        data[45] = 1;
        assert_eq!(
            mint_decimals_from_account("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", &data),
            Some(9)
        );
        assert_eq!(mint_decimals_from_account("SomeOtherProgram", &data), None);
        assert_eq!(
            mint_decimals_from_account("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", &data[..40]),
            None
        );
    }

    /// The production transport against local servers: the pinned address is
    /// used instead of DNS, redirects are not followed, a slow receiver times
    /// out and an endless response body is not read to the end.
    #[tokio::test]
    async fn real_transport_pins_does_not_follow_redirects_and_bounds_reads() {
        use axum::{Router, body::Body, http::StatusCode, response::IntoResponse, routing::any};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let hits = Arc::new(AtomicUsize::new(0));
        let elsewhere_hits = hits.clone();
        let elsewhere = Router::new().fallback(any(move || {
            elsewhere_hits.fetch_add(1, Ordering::SeqCst);
            async { StatusCode::OK }
        }));
        let elsewhere_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let elsewhere_addr = elsewhere_listener.local_addr().unwrap();
        let elsewhere_task =
            tokio::spawn(async move { axum::serve(elsewhere_listener, elsewhere).await.unwrap() });
        let location = format!("http://{elsewhere_addr}/stolen");
        let app = Router::new()
            .route(
                "/redirect",
                any(move || {
                    let location = location.clone();
                    async move {
                        (
                            StatusCode::FOUND,
                            [(axum::http::header::LOCATION, location)],
                        )
                            .into_response()
                    }
                }),
            )
            .route(
                "/slow",
                any(|| async {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    StatusCode::OK
                }),
            )
            .route(
                "/endless",
                any(|| async {
                    let stream = futures_stream();
                    Body::from_stream(stream).into_response()
                }),
            )
            .route(
                "/ok",
                any(|| async {
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [(axum::http::header::RETRY_AFTER, "30")],
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let transport = ReqwestTransport {
            connect_timeout: Duration::from_secs(1),
            timeout: Duration::from_secs(1),
        };
        let request = |path: &str| OutboundRequest {
            // `.invalid` never resolves: reaching the server proves the pin.
            url: reqwest::Url::parse(&format!("http://receiver.invalid:{}{path}", addr.port()))
                .unwrap(),
            pinned: addr,
            headers: vec![("webhook-id", "evt_x".into())],
            body: b"{}".to_vec(),
        };
        assert_eq!(
            transport.send(request("/ok")).await.unwrap(),
            OutboundResponse {
                status: 429,
                retry_after_secs: Some(30)
            }
        );
        assert_eq!(
            transport.send(request("/redirect")).await.unwrap().status,
            302
        );
        assert_eq!(
            hits.load(Ordering::SeqCst),
            0,
            "redirect target never contacted"
        );
        assert_eq!(
            transport.send(request("/slow")).await,
            Err(SendError::Timeout)
        );
        let started = std::time::Instant::now();
        assert_eq!(
            transport.send(request("/endless")).await.unwrap().status,
            200
        );
        assert!(
            started.elapsed() < Duration::from_millis(900),
            "stopped reading after the cap"
        );
        task.abort();
        elsewhere_task.abort();
    }

    /// An HTTP body that never ends.
    fn futures_stream()
    -> impl futures_core::Stream<Item = Result<axum::body::Bytes, std::io::Error>> {
        struct Endless;
        impl futures_core::Stream for Endless {
            type Item = Result<axum::body::Bytes, std::io::Error>;
            fn poll_next(
                self: std::pin::Pin<&mut Self>,
                _: &mut std::task::Context<'_>,
            ) -> std::task::Poll<Option<Self::Item>> {
                std::task::Poll::Ready(Some(Ok(axum::body::Bytes::from_static(&[b'x'; 1024]))))
            }
        }
        Endless
    }
}
