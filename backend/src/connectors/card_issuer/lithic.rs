//! Lithic sandbox HTTP client (research-lithic.md). Sandbox only: the
//! connector refuses the production API host.
//!
//! The PAN is fetched in exactly one place, [`LithicClient::with_pan`], which
//! hands it to a closure inside a buffer that is zeroed on drop. It is never
//! logged, stored, returned or put in an error. Error values carry only the
//! HTTP status and Lithic's short error code.

use reqwest::{Client, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;

pub const SANDBOX_URL: &str = "https://sandbox.lithic.com";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LithicError {
    #[error("issuer unreachable")]
    Network,
    #[error("issuer returned HTTP {status}")]
    Remote { status: u16, code: Option<String> },
    #[error("issuer returned an invalid response")]
    Invalid,
    #[error("issuer writes are disabled (CARDS_ISSUER_WRITES_ENABLED)")]
    WritesDisabled,
}

#[derive(Clone)]
pub struct LithicClient {
    http: Client,
    base: String,
    api_key: String,
    writes_enabled: bool,
}

impl std::fmt::Debug for LithicClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LithicClient")
            .field("base", &self.base)
            .field("api_key", &"[redacted]")
            .field("writes_enabled", &self.writes_enabled)
            .finish()
    }
}

/// Card number held only for one sandbox simulate call. Zeroed on drop.
pub struct Pan(Vec<u8>);

impl Pan {
    fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).unwrap_or("")
    }
}

impl Drop for Pan {
    fn drop(&mut self) {
        self.0.fill(0);
        // Keep the zeroing observable so it is not optimized away.
        std::hint::black_box(&self.0);
    }
}

impl std::fmt::Debug for Pan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pan([redacted])")
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransactionPage {
    pub transactions: Vec<Value>,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssuedCard {
    pub token: String,
    pub last_four: String,
    pub state: String,
}

impl LithicClient {
    pub fn new(base: &str, api_key: String, writes_enabled: bool) -> Result<Self, &'static str> {
        let base = base.trim_end_matches('/').to_owned();
        let parsed = reqwest::Url::parse(&base).map_err(|_| "LITHIC_API_URL is not a URL")?;
        // Allow-list on the normalized host (the URL parser lowercases it and
        // splits off the port; a trailing FQDN dot is dropped here), so
        // `https://API.lithic.com.:443` is the production host it is.
        let host = parsed
            .host_str()
            .ok_or("LITHIC_API_URL has no host")?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .trim_end_matches('.')
            .to_ascii_lowercase();
        let local = matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1");
        if host != "sandbox.lithic.com" && !local {
            return Err(
                "the card connector is sandbox-only; LITHIC_API_URL must be sandbox.lithic.com (or loopback for card-sim)",
            );
        }
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err("LITHIC_API_URL must not carry credentials");
        }
        if parsed.scheme() != "https" && !local {
            return Err("LITHIC_API_URL must be https");
        }
        if api_key.trim().len() < 8 {
            return Err("a Lithic sandbox API key is required");
        }
        Ok(Self {
            http: Client::builder()
                .user_agent("chainpay-backend/0.1 cards")
                .timeout(Duration::from_secs(15))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| "issuer HTTP client")?,
            base,
            api_key: api_key.trim().to_owned(),
            writes_enabled,
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        write: bool,
    ) -> Result<Value, LithicError> {
        if write && !self.writes_enabled {
            return Err(LithicError::WritesDisabled);
        }
        // The sandbox allows about one write per second: back off on 429.
        let mut attempt = 0u64;
        loop {
            attempt += 1;
            let mut request = self
                .http
                .request(method.clone(), format!("{}{}", self.base, path))
                .header("Authorization", &self.api_key);
            if let Some(body) = &body {
                request = request.json(body);
            }
            let response = request.send().await.map_err(|_| LithicError::Network)?;
            let status = response.status();
            if status == StatusCode::TOO_MANY_REQUESTS && attempt < 5 {
                tokio::time::sleep(Duration::from_millis(1_100 * attempt)).await;
                continue;
            }
            let body: Value = response.json().await.unwrap_or(Value::Null);
            if !status.is_success() {
                return Err(LithicError::Remote {
                    status: status.as_u16(),
                    code: body["code"]
                        .as_str()
                        .or(body["type"].as_str())
                        .map(|c| c.chars().take(64).collect()),
                });
            }
            return Ok(body);
        }
    }

    async fn get(&self, path: &str) -> Result<Value, LithicError> {
        self.send(reqwest::Method::GET, path, None, false).await
    }
    async fn post(&self, path: &str, body: Value) -> Result<Value, LithicError> {
        self.send(reqwest::Method::POST, path, Some(body), true)
            .await
    }
    async fn patch(&self, path: &str, body: Value) -> Result<Value, LithicError> {
        self.send(reqwest::Method::PATCH, path, Some(body), true)
            .await
    }

    fn issued(body: &Value) -> Result<IssuedCard, LithicError> {
        Ok(IssuedCard {
            token: body["token"]
                .as_str()
                .ok_or(LithicError::Invalid)?
                .to_owned(),
            last_four: body["last_four"]
                .as_str()
                .unwrap_or("")
                .chars()
                .filter(char::is_ascii_digit)
                .take(4)
                .collect(),
            state: body["state"].as_str().unwrap_or("").to_owned(),
        })
    }

    /// New virtual card, always created `PAUSED` (contracts.md §3.4 prepare).
    pub async fn create_card(&self, memo: &str) -> Result<IssuedCard, LithicError> {
        let body = self
            .post(
                "/v1/cards",
                json!({"type":"VIRTUAL","state":"PAUSED","memo":memo}),
            )
            .await?;
        Self::issued(&body)
    }

    pub async fn get_card(&self, token: &str) -> Result<IssuedCard, LithicError> {
        Self::issued(
            &self
                .get(&format!("/v1/cards/{}", path_token(token)?))
                .await?,
        )
    }

    /// `state` ∈ OPEN | PAUSED. Never CLOSED from a freeze path; never a zero
    /// spend limit (0 means unlimited at Lithic).
    pub async fn set_state(&self, token: &str, state: &str) -> Result<IssuedCard, LithicError> {
        if !matches!(state, "OPEN" | "PAUSED") {
            return Err(LithicError::Invalid);
        }
        let body = self
            .patch(
                &format!("/v1/cards/{}", path_token(token)?),
                json!({"state":state}),
            )
            .await?;
        Self::issued(&body)
    }

    pub async fn set_spend_limit(&self, token: &str, cents: u64) -> Result<Value, LithicError> {
        if cents == 0 {
            // 0 = no limit at Lithic: the caller must PAUSE instead.
            return Err(LithicError::Invalid);
        }
        self.patch(
            &format!("/v1/cards/{}", path_token(token)?),
            json!({"spend_limit":cents,"spend_limit_duration":"TRANSACTION"}),
        )
        .await
    }

    /// Create a card-level Auth Rule (v2) and promote it to active.
    pub async fn create_card_rule(
        &self,
        card_token: &str,
        name: &str,
        rule_type: &str,
        parameters: Value,
    ) -> Result<String, LithicError> {
        let created = self
            .post(
                "/v2/auth_rules",
                json!({"card_tokens":[card_token],"type":rule_type,"name":name,"parameters":parameters}),
            )
            .await?;
        let token = created["token"]
            .as_str()
            .ok_or(LithicError::Invalid)?
            .to_owned();
        let state = created["current_version"].is_null();
        if state {
            self.post(
                &format!("/v2/auth_rules/{}/promote", path_token(&token)?),
                json!({}),
            )
            .await?;
        }
        Ok(token)
    }

    pub async fn embed_session(
        &self,
        card_token: &str,
        target_origin: Option<&str>,
    ) -> Result<String, LithicError> {
        let mut body = json!({"type":"CARD_EMBED"});
        if let Some(origin) = target_origin {
            body["target_origin"] = json!(origin);
        }
        let response = self
            .send(
                reqwest::Method::POST,
                &format!("/v1/cards/{}/embed", path_token(card_token)?),
                Some(body),
                false,
            )
            .await?;
        response["session"]
            .as_str()
            .map(str::to_owned)
            .ok_or(LithicError::Invalid)
    }

    pub async fn get_transaction(&self, token: &str) -> Result<Value, LithicError> {
        self.get(&format!("/v1/transactions/{}", path_token(token)?))
            .await
    }

    /// All transactions for a card since `begin`, following `starting_after`
    /// pagination for up to 10 pages. `complete` is false when more remain.
    pub async fn list_transactions(
        &self,
        card_token: &str,
        begin_rfc3339: Option<&str>,
    ) -> Result<TransactionPage, LithicError> {
        let mut base = format!(
            "/v1/transactions?card_token={}&page_size=100",
            path_token(card_token)?
        );
        if let Some(begin) = begin_rfc3339 {
            base.push_str(&format!(
                "&begin={}",
                begin.replace(':', "%3A").replace('+', "%2B")
            ));
        }
        let mut transactions = Vec::new();
        let mut after: Option<String> = None;
        for _ in 0..10 {
            let path = match &after {
                Some(token) => format!("{base}&starting_after={}", path_token(token)?),
                None => base.clone(),
            };
            let page = self.get(&path).await?;
            let data = page["data"].as_array().cloned().unwrap_or_default();
            after = data
                .last()
                .and_then(|t| t["token"].as_str())
                .map(str::to_owned);
            transactions.extend(data);
            if page["has_more"].as_bool() != Some(true) || after.is_none() {
                return Ok(TransactionPage {
                    transactions,
                    complete: true,
                });
            }
        }
        Ok(TransactionPage {
            transactions,
            complete: false,
        })
    }

    /// Sandbox only: fetch the PAN for exactly one call. The buffer is zeroed
    /// when `f` returns, whatever it returns.
    pub async fn with_pan<T, F, Fut>(&self, card_token: &str, f: F) -> Result<T, LithicError>
    where
        F: FnOnce(PanRef) -> Fut,
        Fut: std::future::Future<Output = Result<T, LithicError>>,
    {
        let mut body = self
            .get(&format!("/v1/cards/{}", path_token(card_token)?))
            .await?;
        let pan = body
            .get_mut("pan")
            .and_then(|value| value.as_str().map(|s| s.as_bytes().to_vec()))
            .map(Pan)
            .ok_or(LithicError::Invalid);
        // Scrub the response copy as well.
        if let Some(value) = body.get_mut("pan") {
            *value = Value::Null;
        }
        if let Some(value) = body.get_mut("cvv") {
            *value = Value::Null;
        }
        drop(body);
        let pan = pan?;
        if pan.0.len() < 12 || !pan.0.iter().all(u8::is_ascii_digit) {
            return Err(LithicError::Invalid);
        }
        f(PanRef(std::sync::Arc::new(pan))).await
    }

    /// `POST /v1/simulate/authorize`. Triggers our ASA endpoint.
    pub async fn simulate_authorize(
        &self,
        pan: &PanRef,
        amount: u64,
        descriptor: &str,
        mcc: &str,
        acceptor_id: &str,
    ) -> Result<String, LithicError> {
        let body = self
            .post(
                "/v1/simulate/authorize",
                json!({
                    "pan": pan.0.as_str(), "amount": amount, "descriptor": descriptor,
                    "mcc": mcc, "merchant_acceptor_id": acceptor_id,
                    // merchant_currency requires merchant_amount (sandbox 422 otherwise).
                    "merchant_amount": amount, "merchant_currency": "USD",
                }),
            )
            .await?;
        body["token"]
            .as_str()
            .map(str::to_owned)
            .ok_or(LithicError::Invalid)
    }

    pub async fn simulate_return(
        &self,
        pan: &PanRef,
        amount: u64,
        descriptor: &str,
    ) -> Result<String, LithicError> {
        let body = self
            .post(
                "/v1/simulate/return",
                json!({"pan": pan.0.as_str(), "amount": amount, "descriptor": descriptor}),
            )
            .await?;
        body["token"]
            .as_str()
            .map(str::to_owned)
            .ok_or(LithicError::Invalid)
    }

    pub async fn simulate(&self, path: &str, body: Value) -> Result<Value, LithicError> {
        if !path.starts_with("/v1/simulate/") || body.get("pan").is_some() {
            return Err(LithicError::Invalid);
        }
        self.post(path, body).await
    }

    /// Generic sandbox setup call for the operator tooling (responder endpoint,
    /// event subscriptions). Responses may contain secrets; callers never log them.
    pub async fn admin(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, LithicError> {
        self.send(method, path, body, false).await
    }
}

/// Shared handle to a PAN for the duration of one `with_pan` closure.
#[derive(Clone)]
pub struct PanRef(std::sync::Arc<Pan>);

impl std::fmt::Debug for PanRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PanRef([redacted])")
    }
}

/// Lithic tokens are UUIDs; refuse anything that could change the URL path.
fn path_token(token: &str) -> Result<&str, LithicError> {
    if !token.is_empty()
        && token.len() <= 64
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Ok(token)
    } else {
        Err(LithicError::Invalid)
    }
}

impl LithicError {
    pub fn is_not_found(&self) -> bool {
        matches!(self, Self::Remote { status, .. } if *status == StatusCode::NOT_FOUND.as_u16())
    }
}

#[cfg(test)]
mod tests {
    /// Review F4: an allow-list on the normalized host, not a deny-list on
    /// one spelling of production.
    #[test]
    fn only_the_sandbox_or_loopback_host_is_accepted() {
        let key = || "sandbox-key-123456".to_owned();
        for refused in [
            "https://api.lithic.com",
            "https://api.lithic.com./",
            "https://API.Lithic.COM:443/",
            "https://api.lithic.com.:8443",
            "https://evil.example",
            "https://sandbox.lithic.com.evil.example",
            "https://user:pw@sandbox.lithic.com",
            "http://sandbox.lithic.com",
        ] {
            assert!(
                super::LithicClient::new(refused, key(), true).is_err(),
                "{refused}"
            );
        }
        for accepted in [
            "https://sandbox.lithic.com",
            "https://SANDBOX.lithic.com./",
            "https://sandbox.lithic.com:443",
            "http://127.0.0.1:4010",
            "http://localhost:4010",
        ] {
            assert!(
                super::LithicClient::new(accepted, key(), true).is_ok(),
                "{accepted}"
            );
        }
    }

    use super::*;

    #[test]
    fn refuses_production_and_plain_http_and_redacts_the_key() {
        assert!(LithicClient::new("https://api.lithic.com", "k".repeat(20), true).is_err());
        assert!(LithicClient::new("http://sandbox.lithic.com", "k".repeat(20), true).is_err());
        let client = LithicClient::new(SANDBOX_URL, "secret-key-123".into(), true).unwrap();
        assert!(!format!("{client:?}").contains("secret-key"));
        assert!(path_token("../cards").is_err());
        assert!(path_token("7ef7d65c-9023-4da3-b113-3b8583fd7951").is_ok());
    }

    #[test]
    fn pan_debug_is_redacted() {
        let pan = Pan(b"4111111111111111".to_vec());
        assert_eq!(format!("{pan:?}"), "Pan([redacted])");
        assert_eq!(
            format!("{:?}", PanRef(std::sync::Arc::new(pan))),
            "PanRef([redacted])"
        );
    }

    #[tokio::test]
    async fn writes_are_refused_when_disabled_and_zero_limits_never_sent() {
        let client = LithicClient::new(SANDBOX_URL, "k".repeat(20), false).unwrap();
        assert_eq!(
            client.create_card("x").await.unwrap_err(),
            LithicError::WritesDisabled
        );
        let client = LithicClient::new(SANDBOX_URL, "k".repeat(20), true).unwrap();
        assert_eq!(
            client.set_spend_limit("7ef7d65c", 0).await.unwrap_err(),
            LithicError::Invalid
        );
        assert_eq!(
            client.set_state("7ef7d65c", "CLOSED").await.unwrap_err(),
            LithicError::Invalid
        );
    }
}
