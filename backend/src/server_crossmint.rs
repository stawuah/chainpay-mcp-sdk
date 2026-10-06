//! Crossmint's Orders API, seen from the relay: the authenticated order
//! readback, and the one notice that tells Crossmint which finalized
//! transaction paid an order.
//!
//! The relay owns this because it holds the server API key, decides finality
//! (a payment is `confirmed` only after the finalized receipt matched), and
//! stores the job that binds the payment to exactly one order.
use super::*;

const CROSSMINT_STAGING_API: &str = "https://staging.crossmint.com/api/2022-06-09";
const CROSSMINT_MAX_RESPONSE: usize = 128_000;
/// Bounds the notice sent while a payment confirms. The receipt is already
/// stored by then; this only caps how long the caller waits for the extra call.
const CROSSMINT_NOTICE_BUDGET: std::time::Duration = std::time::Duration::from_secs(10);

/// Where the relay reaches Crossmint and with which server key. The key is
/// never logged or returned.
#[derive(Clone)]
pub struct CrossmintApi {
    pub base_url: String,
    pub api_key: Option<String>,
}

impl CrossmintApi {
    pub fn from_env() -> Self {
        Self {
            base_url: CROSSMINT_STAGING_API.to_owned(),
            api_key: std::env::var("CROSSMINT_API_KEY")
                .ok()
                .filter(|key| !key.is_empty()),
        }
    }

    fn client(timeout: std::time::Duration) -> Result<reqwest::Client, ()> {
        reqwest::Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| ())
    }
}

/// A stored order id is only ever used as one path segment.
pub(super) fn valid_order_id(order_id: &str) -> bool {
    !order_id.is_empty()
        && order_id.len() <= 128
        && order_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// GET the order with the server key. Errors leave settlement unchanged.
pub(super) async fn fetch_order(api: &CrossmintApi, order_id: &str) -> Result<Value, ApiError> {
    if !valid_order_id(order_id) {
        return Err(ApiError::BadRequest(
            "Invalid stored Crossmint order ID".into(),
        ));
    }
    let key = api.api_key.as_deref().ok_or_else(|| {
        ApiError::BadRequest("Crossmint staging readback is not configured".into())
    })?;
    let client = CrossmintApi::client(std::time::Duration::from_secs(15))
        .map_err(|_| ApiError::BadRequest("Crossmint readback unavailable".into()))?;
    let mut response = client
        .get(format!("{}/orders/{order_id}", api.base_url))
        .header("X-API-KEY", key)
        .send()
        .await
        .map_err(|_| {
            ApiError::BadRequest("Crossmint readback unavailable; settlement is unchanged".into())
        })?;
    if !response.status().is_success() {
        return Err(ApiError::BadRequest(
            "Crossmint readback rejected; settlement is unchanged".into(),
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::BadRequest("Crossmint readback incomplete".into()))?
    {
        if bytes.len() + chunk.len() > CROSSMINT_MAX_RESPONSE {
            return Err(ApiError::BadRequest("Crossmint response too large".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::BadRequest("Invalid Crossmint response".into()))
}

/// What an order readback says about telling Crossmint our transaction.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum PaymentNotice {
    /// Still awaiting payment with nothing received: send the notice.
    Due,
    /// Crossmint already has this transaction, or is past waiting for one.
    NotDue,
    /// Crossmint credited a different transaction. Never overwrite that.
    OtherTransaction,
}

pub(super) fn payment_notice(order: &Value, signature: &str) -> PaymentNotice {
    let payment = &order.get("order").unwrap_or(order)["payment"];
    match payment["received"]["txId"].as_str() {
        Some(tx) if tx == signature => PaymentNotice::NotDue,
        Some(_) => PaymentNotice::OtherTransaction,
        None if payment["status"].as_str() == Some("awaiting-payment") => PaymentNotice::Due,
        None => PaymentNotice::NotDue,
    }
}

/// POST `{"type":"crypto-tx-id","txId":…}` for one order. Crossmint keys the
/// notice by order and transaction, so repeating it for the same pair is safe.
async fn post_payment_notice(
    api: &CrossmintApi,
    order_id: &str,
    signature: &str,
) -> Result<(), String> {
    if !valid_order_id(order_id) {
        return Err("the stored Crossmint order ID is invalid".into());
    }
    if bs58::decode(signature)
        .into_vec()
        .map_or(true, |bytes| bytes.len() != 64)
    {
        return Err("the settled payment has no valid transaction signature".into());
    }
    let key = api
        .api_key
        .as_deref()
        .ok_or("the Crossmint server key is not configured")?;
    let client = CrossmintApi::client(std::time::Duration::from_secs(10))
        .map_err(|_| "the Crossmint client could not be built".to_owned())?;
    let response = client
        .post(format!("{}/orders/{order_id}/payment", api.base_url))
        .header("X-API-KEY", key)
        .json(&json!({ "type": "crypto-tx-id", "txId": signature }))
        .send()
        .await
        .map_err(|_| "Crossmint could not be reached".to_owned())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Crossmint answered HTTP {}",
            response.status().as_u16()
        ))
    }
}

/// Send the notice if this readback shows it is still due. Returns the
/// failure to record on the job, or `None` when nothing is outstanding.
///
/// Callers pass only a payment that is `confirmed` (finalized and its receipt
/// verified) and the order bound to that payment's job; the transaction is
/// always the payment's own signature.
pub(super) async fn send_payment_notice_if_due(
    api: &CrossmintApi,
    order_id: &str,
    payment: &PaymentRecord,
    order: &Value,
) -> Option<String> {
    if payment.status != PaymentStatus::Confirmed {
        return None;
    }
    let Some(signature) = payment.signature.as_deref() else {
        return Some(notice_failure(
            "the settled payment has no transaction signature",
        ));
    };
    match payment_notice(order, signature) {
        PaymentNotice::NotDue => None,
        PaymentNotice::OtherTransaction => Some(
            "Crossmint reports a different transaction for this order. ChainPay did not overwrite it; the receipt for this payment is unchanged."
                .into(),
        ),
        PaymentNotice::Due => post_payment_notice(api, order_id, signature)
            .await
            .err()
            .map(|reason| notice_failure(&reason)),
    }
}

fn notice_failure(reason: &str) -> String {
    format!(
        "Payment is settled, but Crossmint has not been told which transaction paid it ({reason}). ChainPay retries on the next status check; do not pay again."
    )
}

/// Right after a Crossmint payment confirms: read the bound order, check it is
/// still this owner's order, and send the notice when due. Any failure is
/// written to the job and retried by the order-status readback; nothing here
/// can fail or undo the confirmation, which is already stored.
pub(super) async fn notify_after_confirmation(
    state: &BackendState,
    payment: &PaymentRecord,
    crossmint: &CrossmintPaymentMetadata,
) {
    let attempt = async {
        let owner = state
            .store
            .operation_owner(&payment.payment_id)
            .await
            .map_err(|_| notice_failure("the payment owner could not be read"))?
            .ok_or_else(|| notice_failure("the payment owner is unknown"))?;
        let order = fetch_order(&state.crossmint, &crossmint.order_id)
            .await
            .map_err(|_| notice_failure("the order could not be read back"))?;
        // Same identity and payer checks as the status readback.
        crossmint_observation(&order, &crossmint.order_id, &owner, &crossmint.terms)
            .map_err(|_| notice_failure("the order no longer matches this payment"))?;
        match send_payment_notice_if_due(&state.crossmint, &crossmint.order_id, payment, &order)
            .await
        {
            Some(failure) => Err(failure),
            None => Ok(()),
        }
    };
    let failure = match tokio::time::timeout(CROSSMINT_NOTICE_BUDGET, attempt).await {
        Ok(Ok(())) => return,
        Ok(Err(failure)) => failure,
        Err(_) => notice_failure("Crossmint did not answer in time"),
    };
    eprintln!(
        "[chainpay] crossmint payment notice pending for {}",
        payment.payment_id
    );
    let Ok(Some(mut job)) = state
        .store
        .find_x402_by_idempotency(&payment.idempotency_key)
        .await
    else {
        return;
    };
    if job.connector != ConnectorKind::Crossmint
        || job.payment_id.as_deref() != Some(payment.payment_id.as_str())
    {
        return;
    }
    job.error = Some(failure);
    job.updated_at_ms = now_ms().max(job.updated_at_ms + 1);
    let _ = state.store.put_x402(job).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const SIGNATURE: &str =
        "AsCF3JLhHxtuYNiu82KqJW8epaKWiF7sWmYujLfsMgbsqyxkiutGmr6Ag7YmsSxoeZHEFymko6fJ4T1MvMpWaEx";

    fn order(status: &str, received: Option<&str>) -> Value {
        let mut payment = json!({ "status": status, "method": "solana" });
        if let Some(tx) = received {
            payment["received"] = json!({ "chain": "solana", "txId": tx, "amount": "0.1203" });
        }
        json!({ "order": { "orderId": "order_1", "phase": "payment", "payment": payment } })
    }

    fn confirmed() -> PaymentRecord {
        let (_, request, _) = transactions::tests::fixture(0);
        let mut record = recovery::initial(&request, SigningMode::Human).unwrap();
        record.status = PaymentStatus::Confirmed;
        record.signature = Some(SIGNATURE.into());
        record
    }

    type Seen = Arc<Mutex<Vec<(String, String, Option<String>, Value)>>>;

    /// A fake Crossmint: records each request and answers with `status`.
    async fn crossmint(status: StatusCode) -> (CrossmintApi, Seen, tokio::task::JoinHandle<()>) {
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let router = Router::new().fallback(move |request: Request<axum::body::Body>| {
            let log = log.clone();
            async move {
                let method = request.method().to_string();
                let path = request.uri().path().to_owned();
                let key = request
                    .headers()
                    .get("X-API-KEY")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned);
                let bytes = axum::body::to_bytes(request.into_body(), 4096)
                    .await
                    .unwrap();
                let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
                log.lock().unwrap().push((method, path, key, body));
                (status, Json(json!({ "ok": true })))
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let api = CrossmintApi {
            base_url: format!("http://{address}/api/2022-06-09"),
            api_key: Some("sk_staging_fixture".into()),
        };
        (api, seen, task)
    }

    #[test]
    fn notice_is_due_only_while_crossmint_awaits_payment_and_has_nothing() {
        assert_eq!(
            payment_notice(&order("awaiting-payment", None), SIGNATURE),
            PaymentNotice::Due
        );
        // Already credited with this transaction (the Lane A end state).
        assert_eq!(
            payment_notice(&order("completed", Some(SIGNATURE)), SIGNATURE),
            PaymentNotice::NotDue
        );
        assert_eq!(
            payment_notice(&order("in-progress", None), SIGNATURE),
            PaymentNotice::NotDue
        );
        assert_eq!(
            payment_notice(&order("awaiting-payment", Some("another")), SIGNATURE),
            PaymentNotice::OtherTransaction
        );
        assert_eq!(
            payment_notice(&order("completed", Some("another")), SIGNATURE),
            PaymentNotice::OtherTransaction
        );
    }

    #[tokio::test]
    async fn due_notice_posts_the_payment_signature_to_the_bound_order_with_the_server_key() {
        let (api, seen, task) = crossmint(StatusCode::CREATED).await;
        let payment = confirmed();
        let failure =
            send_payment_notice_if_due(&api, "order_1", &payment, &order("awaiting-payment", None))
                .await;
        assert_eq!(failure, None);
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        let (method, path, key, body) = &seen[0];
        assert_eq!(method, "POST");
        assert_eq!(path, "/api/2022-06-09/orders/order_1/payment");
        assert_eq!(key.as_deref(), Some("sk_staging_fixture"));
        assert_eq!(body, &json!({ "type": "crypto-tx-id", "txId": SIGNATURE }));
        task.abort();
    }

    #[tokio::test]
    async fn no_notice_before_confirmation_once_credited_or_for_another_transaction() {
        let (api, seen, task) = crossmint(StatusCode::CREATED).await;
        let mut submitted = confirmed();
        submitted.status = PaymentStatus::Submitted;
        let awaiting = order("awaiting-payment", None);
        assert_eq!(
            send_payment_notice_if_due(&api, "order_1", &submitted, &awaiting).await,
            None
        );
        let payment = confirmed();
        assert_eq!(
            send_payment_notice_if_due(
                &api,
                "order_1",
                &payment,
                &order("completed", Some(SIGNATURE))
            )
            .await,
            None
        );
        let other = send_payment_notice_if_due(
            &api,
            "order_1",
            &payment,
            &order("awaiting-payment", Some("another")),
        )
        .await
        .unwrap();
        assert!(other.contains("different transaction"));
        // An order id that is not one path segment is never sent anywhere.
        let invalid = send_payment_notice_if_due(&api, "../orders/x", &payment, &awaiting).await;
        assert!(invalid.unwrap().contains("do not pay again"));
        assert!(seen.lock().unwrap().is_empty());
        task.abort();
    }

    #[tokio::test]
    async fn a_refused_or_unreachable_notice_is_returned_for_the_job_never_raised() {
        let (api, _, task) = crossmint(StatusCode::INTERNAL_SERVER_ERROR).await;
        let payment = confirmed();
        let awaiting = order("awaiting-payment", None);
        let failure = send_payment_notice_if_due(&api, "order_1", &payment, &awaiting)
            .await
            .unwrap();
        assert!(failure.contains("HTTP 500"));
        assert!(failure.contains("do not pay again"));
        assert!(!failure.contains("sk_staging_fixture"));
        task.abort();
        let unconfigured = CrossmintApi {
            api_key: None,
            ..api
        };
        let failure = send_payment_notice_if_due(&unconfigured, "order_1", &payment, &awaiting)
            .await
            .unwrap();
        assert!(failure.contains("not configured"));
    }
}
