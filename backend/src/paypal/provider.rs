//! Raw provider observations, not business authorization. Callers must persist
//! immutable intent and explicit approval before invoking any money mutation.
use super::{
    config::{Config, SANDBOX_API, http_client},
    money::Cents,
};
use axum::http::HeaderMap;
use reqwest::{Client, Method};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const MAX_RESPONSE: usize = 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("Invalid provider request: {0}")]
    Invalid(&'static str),
    #[error("Provider result unavailable; reconcile the original operation")]
    Unknown,
    #[error("Provider rejected request (HTTP {0}); inspect original operation before retry")]
    Rejected(u16),
}

struct Token {
    value: String,
    expires: Instant,
}

#[derive(Clone)]
pub struct Provider {
    client: Client,
    base: String,
    client_id: String,
    secret: String,
    webhook_id: String,
    origin: String,
    token: Arc<Mutex<Option<Token>>>,
}

impl Provider {
    pub fn new(config: &Config) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: http_client()?,
            base: SANDBOX_API.into(),
            client_id: config.client_id.clone(),
            secret: config.client_secret.clone(),
            webhook_id: config.webhook_id.clone(),
            origin: config.public_origin.clone(),
            token: Arc::new(Mutex::new(None)),
        })
    }

    async fn access_token(&self) -> Result<String, ProviderError> {
        let mut cached = self.token.lock().await;
        if let Some(token) = cached.as_ref().filter(|t| t.expires > Instant::now()) {
            return Ok(token.value.clone());
        }
        let response = self
            .client
            .post(format!("{}/v1/oauth2/token", self.base))
            .basic_auth(&self.client_id, Some(&self.secret))
            .form(&[("grant_type", "client_credentials")])
            .send()
            .await
            .map_err(|_| ProviderError::Unknown)?;
        let value = bounded_json(response).await?;
        #[derive(Deserialize)]
        struct AccessToken {
            access_token: String,
            token_type: String,
            expires_in: u64,
        }
        let token: AccessToken =
            serde_json::from_value(value).map_err(|_| ProviderError::Unknown)?;
        if !token.token_type.eq_ignore_ascii_case("bearer")
            || token.access_token.is_empty()
            || token.expires_in == 0
            || token.expires_in > 86400
        {
            return Err(ProviderError::Unknown);
        }
        // Short-lived tokens are used once, but never cached beyond expiry.
        let expires = Instant::now() + Duration::from_secs(token.expires_in.saturating_sub(30));
        let result = token.access_token.clone();
        *cached = Some(Token {
            value: token.access_token,
            expires,
        });
        Ok(result)
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        key: Option<&str>,
        body: Option<Value>,
        query: &[(&str, String)],
    ) -> Result<Value, ProviderError> {
        if let Some(key) = key {
            if key.is_empty()
                || key.len() > 38
                || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                return Err(ProviderError::Invalid(
                    "request ID must be 1–38 alphanumeric/hyphen characters",
                ));
            }
        }
        let token = self.access_token().await?;
        let mut request = self
            .client
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(token)
            .header("Accept", "application/json")
            .header("Prefer", "return=representation")
            .query(query);
        if let Some(key) = key {
            request = request.header("PayPal-Request-Id", key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| ProviderError::Unknown)?;
        if response.status() == 401 {
            *self.token.lock().await = None;
        }
        // Never automatically replay a mutation, including on 401 or 5xx.
        bounded_json(response).await
    }

    pub async fn create_order(
        &self,
        task_id: &str,
        amount: Cents,
        key: &str,
    ) -> Result<Value, ProviderError> {
        id(task_id)?;
        if amount.0 == 0 {
            return Err(ProviderError::Invalid("zero purchase"));
        }
        self.request(Method::POST, "/v2/checkout/orders", Some(key), Some(json!({
            "intent":"CAPTURE",
            "purchase_units":[{"reference_id":task_id,"custom_id":task_id,"invoice_id":task_id,
                "description":"ChainPay document processing",
                "amount":{"currency_code":"USD","value":amount.decimal()}}],
            "payment_source":{"paypal":{"experience_context":{
                "shipping_preference":"NO_SHIPPING","user_action":"PAY_NOW",
                "return_url":format!("{}/paypal/checkout?task={task_id}", self.origin),
                "cancel_url":format!("{}/paypal/checkout?task={task_id}&cancelled=true", self.origin)
            }}}
        })), &[]).await
    }

    pub async fn capture_order(&self, order: &str, key: &str) -> Result<Value, ProviderError> {
        id(order)?;
        self.request(
            Method::POST,
            &format!("/v2/checkout/orders/{order}/capture"),
            Some(key),
            Some(json!({})),
            &[],
        )
        .await
    }

    pub async fn refund_capture(
        &self,
        capture: &str,
        amount: Cents,
        key: &str,
    ) -> Result<Value, ProviderError> {
        id(capture)?;
        if amount.0 == 0 {
            return Err(ProviderError::Invalid("zero refund"));
        }
        self.request(
            Method::POST,
            &format!("/v2/payments/captures/{capture}/refund"),
            Some(key),
            Some(json!({
                "amount":{"currency_code":"USD","value":amount.decimal()}
            })),
            &[],
        )
        .await
    }

    pub async fn order(&self, order: &str) -> Result<Value, ProviderError> {
        id(order)?;
        self.request(
            Method::GET,
            &format!("/v2/checkout/orders/{order}"),
            None,
            None,
            &[],
        )
        .await
    }
    pub async fn capture(&self, capture: &str) -> Result<Value, ProviderError> {
        id(capture)?;
        self.request(
            Method::GET,
            &format!("/v2/payments/captures/{capture}"),
            None,
            None,
            &[],
        )
        .await
    }
    pub async fn refund(&self, refund: &str) -> Result<Value, ProviderError> {
        id(refund)?;
        self.request(
            Method::GET,
            &format!("/v2/payments/refunds/{refund}"),
            None,
            None,
            &[],
        )
        .await
    }

    pub async fn transactions(
        &self,
        start: &str,
        end: &str,
        page: u32,
    ) -> Result<Value, ProviderError> {
        if start.len() > 40 || end.len() > 40 || page == 0 || page > 100 {
            return Err(ProviderError::Invalid("invalid reporting range/page"));
        }
        self.request(
            Method::GET,
            "/v1/reporting/transactions",
            None,
            None,
            &[
                ("start_date", start.into()),
                ("end_date", end.into()),
                ("page", page.to_string()),
                ("page_size", "100".into()),
                ("fields", "all".into()),
            ],
        )
        .await
    }

    pub async fn verify_webhook(
        &self,
        headers: &HeaderMap,
        event: Value,
    ) -> Result<bool, ProviderError> {
        let header = |key: &'static str| -> Result<String, ProviderError> {
            headers
                .get(key)
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty() && v.len() <= 4096)
                .map(str::to_string)
                .ok_or(ProviderError::Invalid("missing webhook signature header"))
        };
        let cert = header("paypal-cert-url")?;
        let url = url::Url::parse(&cert)
            .map_err(|_| ProviderError::Invalid("invalid certificate URL"))?;
        if url.scheme() != "https"
            || !matches!(
                url.host_str(),
                Some("api.sandbox.paypal.com" | "api-m.sandbox.paypal.com")
            )
            || url.port().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
            || !url.path().starts_with("/v1/notifications/certs/")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ProviderError::Invalid("unexpected certificate origin"));
        }
        // Certificate is not downloaded by our server: PayPal verifies the event.
        let response = self
            .request(
                Method::POST,
                "/v1/notifications/verify-webhook-signature",
                None,
                Some(json!({
                    "auth_algo":header("paypal-auth-algo")?, "cert_url":cert,
                    "transmission_id":header("paypal-transmission-id")?,
                    "transmission_sig":header("paypal-transmission-sig")?,
                    "transmission_time":header("paypal-transmission-time")?,
                    "webhook_id":self.webhook_id, "webhook_event":event,
                })),
                &[],
            )
            .await?;
        Ok(response.get("verification_status").and_then(Value::as_str) == Some("SUCCESS"))
    }
}

fn id(value: &str) -> Result<(), ProviderError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(ProviderError::Invalid("invalid resource ID"));
    }
    Ok(())
}

async fn bounded_json(mut response: reqwest::Response) -> Result<Value, ProviderError> {
    let status = response.status();
    if !status.is_success() {
        return Err(
            if status.is_server_error() || status.is_redirection() || status.as_u16() == 408 {
                ProviderError::Unknown
            } else {
                ProviderError::Rejected(status.as_u16())
            },
        );
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err(ProviderError::Unknown);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ProviderError::Unknown)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(ProviderError::Unknown);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ProviderError::Unknown)
}

#[cfg(test)]
mod tests;
