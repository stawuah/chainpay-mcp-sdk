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
    #[cfg(test)]
    pub(crate) fn fixture(base: String, config: &Config) -> Self {
        let mut provider = Self::new(config).unwrap();
        provider.base = base;
        provider.client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        provider
    }
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
        let permits_empty = (method == Method::POST
            && path.starts_with("/v1/billing/subscriptions/")
            && path.ends_with("/cancel"))
            || (method == Method::DELETE && path.starts_with("/v3/vault/payment-tokens/"));
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
        if permits_empty && response.status().as_u16() == 204 {
            return Ok(Value::Null);
        }
        // Never automatically replay a mutation, including on 401 or 5xx.
        bounded_json(response).await
    }

    pub async fn subscription_plan(&self, plan: &str) -> Result<Value, ProviderError> {
        id(plan)?;
        self.request(
            Method::GET,
            &format!("/v1/billing/plans/{plan}"),
            None,
            None,
            &[],
        )
        .await
    }
    pub async fn create_subscription(
        &self,
        local: &str,
        plan: &str,
        key: &str,
    ) -> Result<Value, ProviderError> {
        id(local)?;
        id(plan)?;
        self.request(Method::POST, "/v1/billing/subscriptions", Some(key), Some(json!({
            "plan_id":plan,"custom_id":local,"quantity":"1",
            "application_context":{"shipping_preference":"NO_SHIPPING","user_action":"SUBSCRIBE_NOW",
            "return_url":format!("{}/paypal/?subscription={local}",self.origin),
            "cancel_url":format!("{}/paypal/?subscription={local}&cancelled=true",self.origin)}
        })), &[]).await
    }
    pub async fn subscription(&self, subscription: &str) -> Result<Value, ProviderError> {
        id(subscription)?;
        self.request(
            Method::GET,
            &format!("/v1/billing/subscriptions/{subscription}"),
            None,
            None,
            &[],
        )
        .await
    }
    pub async fn subscription_transactions(
        &self,
        subscription: &str,
        start: &str,
        end: &str,
    ) -> Result<Value, ProviderError> {
        id(subscription)?;
        if start.len() > 40 || end.len() > 40 {
            return Err(ProviderError::Invalid("Invalid subscription date range"));
        }
        self.request(
            Method::GET,
            &format!("/v1/billing/subscriptions/{subscription}/transactions"),
            None,
            None,
            &[("start_time", start.into()), ("end_time", end.into())],
        )
        .await
    }
    pub async fn cancel_subscription(
        &self,
        subscription: &str,
        reason: &str,
        key: &str,
    ) -> Result<Value, ProviderError> {
        id(subscription)?;
        if reason.is_empty() || reason.chars().count() > 128 {
            return Err(ProviderError::Invalid(
                "Cancellation reason must be 1–128 characters",
            ));
        }
        self.request(
            Method::POST,
            &format!("/v1/billing/subscriptions/{subscription}/cancel"),
            Some(key),
            Some(json!({"reason":reason})),
            &[],
        )
        .await
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
            // The key doubles as invoice_id so a webhook can still find this refund
            // when the response was lost and no refund id was stored.
            Some(json!({
                "invoice_id":key,
                "amount":{"currency_code":"USD","value":amount.decimal()}
            })),
            &[],
        )
        .await
    }

    /// A local immutable reference lets a verified webhook recover a lost response.
    pub async fn resolution_refund(
        &self,
        capture: &str,
        amount: Cents,
        key: &str,
    ) -> Result<Value, ProviderError> {
        id(capture)?;
        id(key)?;
        if amount.0 == 0 {
            return Err(ProviderError::Invalid("zero refund"));
        }
        self.request(
            Method::POST,
            &format!("/v2/payments/captures/{capture}/refund"),
            Some(key),
            Some(
                json!({"invoice_id":key,"amount":{"currency_code":"USD","value":amount.decimal()}}),
            ),
            &[],
        )
        .await
    }

    /// Vault setup token: a PayPal wallet needs the buyer's approval first; a
    /// card is passed straight through and never stored here.
    pub async fn create_setup_token(
        &self,
        allowance_id: &str,
        card: Option<Value>,
        key: &str,
    ) -> Result<Value, ProviderError> {
        id(allowance_id)?;
        let source = match card {
            Some(card) => card,
            None => json!({"paypal":{"usage_type":"MERCHANT","experience_context":{
                "return_url":format!("{}/paypal/?allowance={allowance_id}", self.origin),
                "cancel_url":format!("{}/paypal/?allowance={allowance_id}&cancelled=true", self.origin)
            }}}),
        };
        self.request(
            Method::POST,
            "/v3/vault/setup-tokens",
            Some(key),
            Some(json!({"payment_source":source})),
            &[],
        )
        .await
    }
    pub async fn setup_token(&self, token: &str) -> Result<Value, ProviderError> {
        id(token)?;
        self.request(
            Method::GET,
            &format!("/v3/vault/setup-tokens/{token}"),
            None,
            None,
            &[],
        )
        .await
    }
    pub async fn create_payment_token(
        &self,
        setup_token: &str,
        key: &str,
    ) -> Result<Value, ProviderError> {
        id(setup_token)?;
        self.request(
            Method::POST,
            "/v3/vault/payment-tokens",
            Some(key),
            Some(json!({"payment_source":{"token":{"id":setup_token,"type":"SETUP_TOKEN"}}})),
            &[],
        )
        .await
    }
    /// Deletes a vaulted payment token. PayPal answers an empty 204.
    pub async fn delete_payment_token(&self, token: &str) -> Result<Value, ProviderError> {
        id(token)?;
        self.request(
            Method::DELETE,
            &format!("/v3/vault/payment-tokens/{token}"),
            None,
            None,
            &[],
        )
        .await
    }
    /// Merchant-initiated charge against a vaulted source. Same purchase unit
    /// shape as create_order so observations::order can check it.
    pub async fn create_vault_order(
        &self,
        task_id: &str,
        amount: Cents,
        source: &str,
        vault_id: &str,
        key: &str,
    ) -> Result<Value, ProviderError> {
        id(task_id)?;
        id(vault_id)?;
        if amount.0 == 0 {
            return Err(ProviderError::Invalid("zero purchase"));
        }
        if source != "paypal" && source != "card" {
            return Err(ProviderError::Invalid("vault source is paypal or card"));
        }
        let stored = json!({"vault_id":vault_id,"stored_credential":{"payment_initiator":"MERCHANT","payment_type":"UNSCHEDULED","usage":"SUBSEQUENT"}});
        self.request(
            Method::POST,
            "/v2/checkout/orders",
            Some(key),
            Some(json!({
                "intent":"CAPTURE",
                "purchase_units":[{"reference_id":task_id,"custom_id":task_id,"invoice_id":task_id,
                    "description":"ChainPay catalog purchase",
                    "amount":{"currency_code":"USD","value":amount.decimal()}}],
                "payment_source":{source:stored}
            })),
            &[],
        )
        .await
    }

    pub async fn disputes_for_capture(&self, capture: &str) -> Result<Value, ProviderError> {
        id(capture)?;
        self.request(
            Method::GET,
            "/v1/customer/disputes",
            None,
            None,
            &[
                ("disputed_transaction_id", capture.into()),
                ("page_size", "10".into()),
            ],
        )
        .await
    }
    pub async fn dispute(&self, dispute: &str) -> Result<Value, ProviderError> {
        id(dispute)?;
        self.request(
            Method::GET,
            &format!("/v1/customer/disputes/{dispute}"),
            None,
            None,
            &[],
        )
        .await
    }
    /// Evidence goes up as multipart with one JSON part named `input`. PayPal
    /// answers 200 or an empty 204; both mean accepted.
    pub async fn provide_evidence(
        &self,
        dispute: &str,
        notes: &str,
        key: &str,
    ) -> Result<Value, ProviderError> {
        id(dispute)?;
        id(key)?;
        if notes.is_empty() || notes.chars().count() > 2000 {
            return Err(ProviderError::Invalid(
                "evidence notes must be 1–2000 characters",
            ));
        }
        let input = json!({"evidences":[{"evidence_type":"PROOF_OF_FULFILLMENT","notes":notes}]});
        let boundary = format!("chainpay-{key}");
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"input\"\r\nContent-Type: application/json\r\n\r\n{input}\r\n--{boundary}--\r\n"
        );
        let token = self.access_token().await?;
        let response = self
            .client
            .post(format!(
                "{}/v1/customer/disputes/{dispute}/provide-evidence",
                self.base
            ))
            .bearer_auth(token)
            .header("Accept", "application/json")
            .header("PayPal-Request-Id", key)
            .header(
                "Content-Type",
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .map_err(|_| ProviderError::Unknown)?;
        if response.status() == 401 {
            *self.token.lock().await = None;
        }
        if response.status().as_u16() == 204 {
            return Ok(Value::Null);
        }
        bounded_json(response).await
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
        if start.len() > 40 || end.len() > 40 || page == 0 || page > i32::MAX as u32 {
            return Err(ProviderError::Invalid("invalid reporting range/page"));
        }
        let from = chrono::DateTime::parse_from_rfc3339(start)
            .map_err(|_| ProviderError::Invalid("invalid reporting start"))?;
        let to = chrono::DateTime::parse_from_rfc3339(end)
            .map_err(|_| ProviderError::Invalid("invalid reporting end"))?;
        if to <= from || (to - from).num_seconds() > 31 * 86400 {
            return Err(ProviderError::Invalid("invalid reporting window"));
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
                ("balance_affecting_records_only", "N".into()),
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
