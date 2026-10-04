//! Shared webhook inbox: **verify → claim → persist → act** (contracts.md
//! §3.2–3.3, §11; PayPal AD-8 reuses it with its own verifier).
//!
//! - `verify`: a provider-specific [`WebhookVerifier`]. Lithic signs with the
//!   Standard Webhooks construction ([`StandardWebhooks`]); PayPal plugs in a
//!   verifier that calls PayPal's verification API.
//! - `claim + persist`: [`Inbox::accept`] inserts one record per
//!   `(provider, event_id)` with first-write-wins semantics. A duplicate
//!   delivery finds the existing row and is acknowledged without re-acting.
//! - The caller answers 2xx **only after** `accept` returned, so a provider
//!   retry is never the only copy of an event.
//! - `act`: the caller processes the row (re-fetching provider truth, since
//!   delivery order is not state order) and marks it with
//!   [`Inbox::complete`]. Rows left `pending` are picked up by the cron job.
//!
//! The raw verified body is stored only as an encryption envelope.

use crate::storage::{CardIndex, CardKind, CardPut, StatusStore, StorageError, StoredCardRecord};
use axum::http::HeaderMap;
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2_010::Sha256;

pub const MAX_WEBHOOK_BYTES: usize = 64 * 1024;
pub const TOLERANCE_SECS: i64 = 300;
const INBOX_OWNER: &str = "__inbox__";

#[derive(Debug, Clone, PartialEq)]
pub struct VerifiedWebhook {
    pub event_id: String,
    pub timestamp: i64,
    pub body: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebhookRejection {
    /// No secret configured: refuse to act on anything (503).
    NotConfigured,
    MissingHeaders,
    Stale,
    BadSignature,
    Malformed,
    TooLarge,
}

pub trait WebhookVerifier: Send + Sync {
    fn verify(
        &self,
        headers: &HeaderMap,
        raw: &[u8],
        now_secs: i64,
    ) -> Result<VerifiedWebhook, WebhookRejection>;
}

/// Standard Webhooks / Lithic: `msg = id + "." + ts + "." + raw`,
/// `sig = b64(HMAC_SHA256(b64decode(secret without "whsec_"), msg))`; the
/// `webhook-signature` header holds space-separated `v1,<sig>` entries.
/// Several secrets may be configured during rotation.
#[derive(Clone, Default)]
pub struct StandardWebhooks {
    keys: Vec<Vec<u8>>,
}

impl std::fmt::Debug for StandardWebhooks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StandardWebhooks")
            .field("keys", &self.keys.len())
            .finish()
    }
}

impl StandardWebhooks {
    /// Accepts one secret or a comma-separated list (rotation). Invalid
    /// entries are refused so a typo never silently disables verification.
    pub fn new(secrets: &str) -> Result<Self, &'static str> {
        let mut keys = Vec::new();
        for secret in secrets.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let encoded = secret.strip_prefix("whsec_").unwrap_or(secret);
            let key = BASE64
                .decode(encoded)
                .map_err(|_| "webhook secret is not base64")?;
            if key.len() < 16 {
                return Err("webhook secret is too short");
            }
            keys.push(key);
        }
        Ok(Self { keys })
    }

    pub fn is_configured(&self) -> bool {
        !self.keys.is_empty()
    }

    pub fn sign(key: &[u8], id: &str, timestamp: i64, raw: &[u8]) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac key");
        mac.update(id.as_bytes());
        mac.update(b".");
        mac.update(timestamp.to_string().as_bytes());
        mac.update(b".");
        mac.update(raw);
        BASE64.encode(mac.finalize().into_bytes())
    }
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

impl WebhookVerifier for StandardWebhooks {
    fn verify(
        &self,
        headers: &HeaderMap,
        raw: &[u8],
        now_secs: i64,
    ) -> Result<VerifiedWebhook, WebhookRejection> {
        if !self.is_configured() {
            return Err(WebhookRejection::NotConfigured);
        }
        if raw.len() > MAX_WEBHOOK_BYTES {
            return Err(WebhookRejection::TooLarge);
        }
        let (Some(id), Some(ts), Some(signatures)) = (
            header(headers, "webhook-id"),
            header(headers, "webhook-timestamp"),
            header(headers, "webhook-signature"),
        ) else {
            return Err(WebhookRejection::MissingHeaders);
        };
        if id.is_empty() || id.len() > 200 {
            return Err(WebhookRejection::MissingHeaders);
        }
        let timestamp: i64 = ts
            .trim()
            .parse()
            .map_err(|_| WebhookRejection::MissingHeaders)?;
        if (now_secs - timestamp).abs() > TOLERANCE_SECS {
            return Err(WebhookRejection::Stale);
        }
        let mut matched = false;
        for entry in signatures.split(' ') {
            let Some(candidate) = entry.strip_prefix("v1,") else {
                continue;
            };
            let Ok(candidate) = BASE64.decode(candidate) else {
                continue;
            };
            for key in &self.keys {
                let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac key");
                mac.update(id.as_bytes());
                mac.update(b".");
                mac.update(ts.trim().as_bytes());
                mac.update(b".");
                mac.update(raw);
                // `verify_slice` compares in constant time.
                if mac.verify_slice(&candidate).is_ok() {
                    matched = true;
                }
            }
        }
        if !matched {
            return Err(WebhookRejection::BadSignature);
        }
        let body: Value = serde_json::from_slice(raw).map_err(|_| WebhookRejection::Malformed)?;
        if !body.is_object() {
            return Err(WebhookRejection::Malformed);
        }
        Ok(VerifiedWebhook {
            event_id: id.to_owned(),
            timestamp,
            body,
        })
    }
}

/// Encrypts raw bodies at rest. Implemented by the card connector's record
/// crypto; PayPal passes its own.
pub trait Sealer: Send + Sync {
    fn seal(&self, kind: &str, key: &str, plaintext: &[u8]) -> Value;
    fn open(&self, kind: &str, key: &str, envelope: &Value) -> Option<Vec<u8>>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum Accepted {
    New(StoredCardRecord),
    Duplicate(StoredCardRecord),
}

impl Accepted {
    pub fn row(&self) -> &StoredCardRecord {
        match self {
            Self::New(row) | Self::Duplicate(row) => row,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum InboxOutcome {
    Applied,
    /// Retry later through the cron job.
    Retry(String),
    /// Will never apply (unknown card, unsupported event). Kept for audit.
    Ignored(String),
}

pub struct Inbox<'a> {
    pub store: &'a StatusStore,
    pub sealer: &'a dyn Sealer,
    pub kind: CardKind,
    pub provider: &'static str,
}

/// Provider event ids become record keys; anything outside the opaque key
/// alphabet is hashed rather than trusted.
pub fn inbox_key(provider: &str, event_id: &str) -> String {
    if event_id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
        && event_id.len() <= 120
    {
        format!("{provider}-event:{event_id}")
    } else {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(event_id.as_bytes());
        format!(
            "{provider}-event:h{}",
            crate::connectors::card_issuer::program::hex(&digest)
        )
    }
}

fn now_rfc3339(now_ms: u64) -> String {
    crate::connectors::card_issuer::rfc3339(now_ms)
}

impl Inbox<'_> {
    fn index(&self, state: &str) -> CardIndex {
        CardIndex {
            owner: Some(INBOX_OWNER.into()),
            connector: Some(self.provider.into()),
            reference: Some(state.into()),
            idempotency: None,
        }
    }

    /// Claim and persist a verified delivery. Never acts on it.
    pub async fn accept(
        &self,
        verified: &VerifiedWebhook,
        raw: &[u8],
        event_type: &str,
        now_ms: u64,
    ) -> Result<Accepted, StorageError> {
        let key = inbox_key(self.provider, &verified.event_id);
        let record = json!({
            "v": 1,
            "type": "inbox",
            "source": self.provider,
            "eventType": event_type.chars().filter(|c| c.is_ascii_alphanumeric() || "._-".contains(*c)).take(64).collect::<String>(),
            "state": "pending",
            "attempts": 0,
            "receivedAt": now_rfc3339(now_ms),
            "raw": self.sealer.seal(self.kind.as_str(), &key, raw),
        });
        match self
            .store
            .put_card_record(
                self.kind,
                &key,
                self.index("pending"),
                record,
                None,
                now_ms * 1000,
            )
            .await?
        {
            CardPut::Written(row) => Ok(Accepted::New(row)),
            CardPut::Conflict(Some(row)) => Ok(Accepted::Duplicate(row)),
            CardPut::Conflict(None) => Err(StorageError::Remote("inbox claim lost".into())),
        }
    }

    pub fn open_raw(&self, row: &StoredCardRecord) -> Option<Vec<u8>> {
        self.sealer
            .open(self.kind.as_str(), &row.key, &row.record["raw"])
    }

    /// Mark a processed row. Compare-and-swap: a concurrent processor that
    /// already completed it wins and this call is a no-op.
    pub async fn complete(
        &self,
        row: &StoredCardRecord,
        outcome: InboxOutcome,
        now_ms: u64,
    ) -> Result<(), StorageError> {
        let mut record = row.record.clone();
        let attempts = record["attempts"].as_u64().unwrap_or(0) + 1;
        record["attempts"] = json!(attempts);
        record["updatedAt"] = json!(now_rfc3339(now_ms));
        let reference = match &outcome {
            InboxOutcome::Applied => {
                record["state"] = json!("applied");
                "done"
            }
            InboxOutcome::Ignored(reason) => {
                record["state"] = json!("ignored");
                record["reason"] = json!(reason);
                "done"
            }
            InboxOutcome::Retry(reason) if attempts >= 12 => {
                record["state"] = json!("failed");
                record["reason"] = json!(reason);
                "failed"
            }
            InboxOutcome::Retry(reason) => {
                record["state"] = json!("pending");
                record["reason"] = json!(reason);
                "pending"
            }
        };
        self.store
            .put_card_record(
                self.kind,
                &row.key,
                self.index(reference),
                record,
                Some(row.rev()),
                // A retried row keeps its place in the queue, so rows that
                // keep retrying never bury older pending rows.
                if reference == "pending" {
                    row.updated.parse().unwrap_or(now_ms * 1000)
                } else {
                    now_ms * 1000
                },
            )
            .await?;
        Ok(())
    }

    /// Oldest-first is not available on the descending index; the cron job
    /// drains newest-first in bounded pages, which is safe because every
    /// processor re-fetches provider truth.
    pub async fn pending(&self, limit: u32) -> Result<Vec<StoredCardRecord>, StorageError> {
        self.pending_page(None, limit).await
    }

    /// One page of pending rows strictly older than `before` (the previous
    /// page's last `updated`), so the cron job can walk the whole queue.
    pub async fn pending_page(
        &self,
        before: Option<&str>,
        limit: u32,
    ) -> Result<Vec<StoredCardRecord>, StorageError> {
        self.store
            .list_card_records_for_owner(
                self.kind,
                INBOX_OWNER,
                self.provider,
                "pending",
                before,
                limit,
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    struct Plain;
    impl Sealer for Plain {
        fn seal(&self, _: &str, _: &str, plaintext: &[u8]) -> Value {
            json!({"v":1,"alg":"A256GCM","kid":"t","iv":"AAAAAAAAAAAAAAAA","ct":BASE64.encode(plaintext)})
        }
        fn open(&self, _: &str, _: &str, envelope: &Value) -> Option<Vec<u8>> {
            BASE64.decode(envelope["ct"].as_str()?).ok()
        }
    }

    fn signed(secret_key: &[u8], id: &str, ts: i64, raw: &[u8]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("webhook-id", HeaderValue::from_str(id).unwrap());
        headers.insert(
            "webhook-timestamp",
            HeaderValue::from_str(&ts.to_string()).unwrap(),
        );
        let sig = StandardWebhooks::sign(secret_key, id, ts, raw);
        headers.insert(
            "webhook-signature",
            HeaderValue::from_str(&format!("v1,bogus v1,{sig}")).unwrap(),
        );
        headers
    }

    #[test]
    fn standard_webhook_signatures_verify_and_reject_tampering() {
        let key = [42u8; 24];
        let secret = format!("whsec_{}", BASE64.encode(key));
        let verifier = StandardWebhooks::new(&secret).unwrap();
        let raw = br#"{"token":"t"}"#;
        let headers = signed(&key, "msg_1", 1_000, raw);
        let ok = verifier.verify(&headers, raw, 1_100).unwrap();
        assert_eq!(ok.event_id, "msg_1");
        assert_eq!(
            verifier.verify(&headers, br#"{"token":"u"}"#, 1_100),
            Err(WebhookRejection::BadSignature)
        );
        assert_eq!(
            verifier.verify(&headers, raw, 1_000 + TOLERANCE_SECS + 1),
            Err(WebhookRejection::Stale)
        );
        assert_eq!(
            verifier.verify(&HeaderMap::new(), raw, 1_000),
            Err(WebhookRejection::MissingHeaders)
        );
        let other = StandardWebhooks::new(&format!("whsec_{}", BASE64.encode([1u8; 24]))).unwrap();
        assert_eq!(
            other.verify(&headers, raw, 1_000),
            Err(WebhookRejection::BadSignature)
        );
        // Rotation: either secret verifies.
        let both =
            StandardWebhooks::new(&format!("whsec_{},{secret}", BASE64.encode([1u8; 24]))).unwrap();
        assert!(both.verify(&headers, raw, 1_000).is_ok());
        assert_eq!(
            StandardWebhooks::default().verify(&headers, raw, 1_000),
            Err(WebhookRejection::NotConfigured)
        );
        assert!(StandardWebhooks::new("whsec_!!").is_err());
        let big = vec![b' '; MAX_WEBHOOK_BYTES + 1];
        assert_eq!(
            verifier.verify(&headers, &big, 1_000),
            Err(WebhookRejection::TooLarge)
        );
    }

    #[tokio::test]
    async fn accept_is_first_write_wins_and_complete_moves_rows_out_of_pending() {
        let store = StatusStore::in_memory();
        let inbox = Inbox {
            store: &store,
            sealer: &Plain,
            kind: CardKind::CardEvents,
            provider: "lithic",
        };
        let verified = VerifiedWebhook {
            event_id: "msg_1".into(),
            timestamp: 1,
            body: json!({}),
        };
        let first = inbox
            .accept(&verified, b"{}", "card_transaction.updated", 1)
            .await
            .unwrap();
        assert!(matches!(first, Accepted::New(_)));
        let again = inbox
            .accept(&verified, b"{}", "card_transaction.updated", 2)
            .await
            .unwrap();
        assert!(matches!(again, Accepted::Duplicate(_)));
        assert_eq!(inbox.open_raw(again.row()).unwrap(), b"{}");
        assert_eq!(inbox.pending(10).await.unwrap().len(), 1);
        inbox
            .complete(first.row(), InboxOutcome::Applied, 3)
            .await
            .unwrap();
        assert!(inbox.pending(10).await.unwrap().is_empty());
        assert!(inbox_key("lithic", "a/b").starts_with("lithic-event:h"));
    }
}
