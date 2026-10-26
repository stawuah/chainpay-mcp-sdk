use super::*;
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Clone, Default)]
struct Fixture {
    tokens: Arc<AtomicUsize>,
    writes: Arc<AtomicUsize>,
    requests: Arc<Mutex<Vec<(HeaderMap, Value)>>>,
}

async fn token(State(f): State<Fixture>, headers: HeaderMap, body: String) -> Json<Value> {
    assert!(
        headers["authorization"]
            .to_str()
            .unwrap()
            .starts_with("Basic ")
    );
    assert_eq!(body, "grant_type=client_credentials");
    f.tokens.fetch_add(1, Ordering::SeqCst);
    Json(json!({"access_token":"fixture-token","token_type":"Bearer","expires_in":3600}))
}

async fn record(
    State(f): State<Fixture>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    assert_eq!(headers["authorization"], "Bearer fixture-token");
    f.writes.fetch_add(1, Ordering::SeqCst);
    f.requests.lock().await.push((headers, body));
    Json(
        json!({"id":"fixture-id","status":"COMPLETED","verification_status":"SUCCESS",
        "seller_receivable_breakdown":{"gross_amount":{"currency_code":"USD","value":"12.00"}}}),
    )
}

async fn fixture() -> (Provider, Fixture, tokio::task::JoinHandle<()>) {
    let state = Fixture::default();
    let routes = Router::new()
        .route("/v1/oauth2/token", post(token))
        .route("/v2/checkout/orders", post(record))
        .route("/v2/checkout/orders/ORDER/capture", post(record))
        .route("/v2/payments/captures/CAPTURE/refund", post(record))
        .route(
            "/v2/checkout/orders/ORDER",
            get(|| async { Json(json!({"id":"ORDER","status":"APPROVED"})) }),
        )
        .route(
            "/v2/checkout/orders/BROKEN/capture",
            post(|State(f): State<Fixture>| async move {
                f.writes.fetch_add(1, Ordering::SeqCst);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "provider secret must not escape",
                )
            }),
        )
        .route(
            "/v2/checkout/orders/REDIRECT/capture",
            post(|| async {
                (
                    StatusCode::TEMPORARY_REDIRECT,
                    [("location", "/v2/checkout/orders/ORDER/capture")],
                )
            }),
        )
        .route(
            "/v2/checkout/orders/UNAUTHORIZED",
            get(|| async { StatusCode::UNAUTHORIZED }),
        )
        .route(
            "/v2/checkout/orders/OVERSIZED",
            get(|| async { "x".repeat(MAX_RESPONSE + 1) }),
        )
        .route("/v1/notifications/verify-webhook-signature", post(record))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
    // The only configurable non-sandbox transport is private to this test module.
    let provider = Provider {
        client: Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap(),
        base,
        client_id: "fixture-client".into(),
        secret: "fixture-secret".into(),
        webhook_id: "registered-webhook-id".into(),
        origin: "https://paypal.example.com".into(),
        token: Arc::new(Mutex::new(None)),
    };
    (provider, state, handle)
}

#[tokio::test]
async fn exact_capture_refund_contract_and_original_provider_fields_are_preserved() {
    let (p, f, task) = fixture().await;
    p.create_order("task-123", Cents(1200), "create-123")
        .await
        .unwrap();
    let capture = p.capture_order("ORDER", "capture-123").await.unwrap();
    p.refund_capture("CAPTURE", Cents(400), "refund-123")
        .await
        .unwrap();
    assert_eq!(
        capture["seller_receivable_breakdown"]["gross_amount"]["value"],
        "12.00"
    );
    let requests = f.requests.lock().await;
    assert_eq!(requests[0].0["paypal-request-id"], "create-123");
    assert_eq!(
        requests[0].1["purchase_units"][0]["amount"]["value"],
        "12.00"
    );
    assert_eq!(requests[0].1["purchase_units"][0]["custom_id"], "task-123");
    assert_eq!(
        requests[0].1["payment_source"]["paypal"]["experience_context"]["return_url"],
        "https://paypal.example.com/paypal/checkout?task=task-123"
    );
    assert_eq!(requests[1].0["paypal-request-id"], "capture-123");
    assert_eq!(requests[2].0["paypal-request-id"], "refund-123");
    assert_eq!(
        requests[2].1,
        json!({"invoice_id":"refund-123","amount":{"currency_code":"USD","value":"4.00"}})
    );
    assert_eq!(f.tokens.load(Ordering::SeqCst), 1);
    task.abort();
}

#[tokio::test]
async fn token_refresh_is_single_flight_and_expiry_is_respected() {
    let (p, f, task) = fixture().await;
    let (a, b, c) = tokio::join!(p.order("ORDER"), p.order("ORDER"), p.order("ORDER"));
    a.unwrap();
    b.unwrap();
    c.unwrap();
    assert_eq!(f.tokens.load(Ordering::SeqCst), 1);
    p.token.lock().await.as_mut().unwrap().expires = Instant::now();
    p.order("ORDER").await.unwrap();
    assert_eq!(f.tokens.load(Ordering::SeqCst), 2);
    assert!(matches!(
        p.order("UNAUTHORIZED").await,
        Err(ProviderError::Rejected(401))
    ));
    p.order("ORDER").await.unwrap();
    assert_eq!(f.tokens.load(Ordering::SeqCst), 3);
    task.abort();
}

#[tokio::test]
async fn uncertain_mutation_is_never_retried_or_redirected_and_errors_are_sanitized() {
    let (p, f, task) = fixture().await;
    let error = p.capture_order("BROKEN", "same-key").await.unwrap_err();
    assert!(matches!(error, ProviderError::Unknown));
    assert!(!error.to_string().contains("secret"));
    assert_eq!(f.writes.load(Ordering::SeqCst), 1);
    assert!(matches!(
        p.capture_order("REDIRECT", "same-key").await,
        Err(ProviderError::Unknown)
    ));
    assert_eq!(f.writes.load(Ordering::SeqCst), 1);
    assert!(matches!(
        p.order("OVERSIZED").await,
        Err(ProviderError::Unknown)
    ));
    task.abort();
}

#[tokio::test]
async fn invalid_ids_amounts_and_missing_signature_never_reach_provider() {
    let (p, f, task) = fixture().await;
    assert!(p.order("../token").await.is_err());
    assert!(p.capture_order("ORDER", "bad\nheader").await.is_err());
    assert!(
        p.refund_capture("CAPTURE", Cents(0), "valid-key")
            .await
            .is_err()
    );
    assert!(
        p.verify_webhook(&HeaderMap::new(), json!({}))
            .await
            .is_err()
    );
    assert_eq!(f.tokens.load(Ordering::SeqCst), 0);
    assert_eq!(f.writes.load(Ordering::SeqCst), 0);
    task.abort();
}

#[tokio::test]
async fn webhook_verification_uses_registered_id_not_an_event_supplied_id() {
    let (p, f, task) = fixture().await;
    let mut headers = HeaderMap::new();
    for (name, value) in [
        (
            "paypal-cert-url",
            "https://api.sandbox.paypal.com/v1/notifications/certs/test",
        ),
        ("paypal-auth-algo", "SHA256withRSA"),
        ("paypal-transmission-id", "transmission"),
        ("paypal-transmission-sig", "fixture-signature"),
        ("paypal-transmission-time", "2026-10-24T12:00:00Z"),
    ] {
        headers.insert(name, value.parse().unwrap());
    }
    let event = json!({"id":"event-123","webhook_id":"attacker-controlled"});
    assert!(p.verify_webhook(&headers, event.clone()).await.unwrap());
    assert_eq!(
        f.requests.lock().await[0].1["webhook_id"],
        "registered-webhook-id"
    );
    assert_eq!(f.requests.lock().await[0].1["webhook_event"], event);
    headers.insert(
        "paypal-cert-url",
        "https://evil.example/cert".parse().unwrap(),
    );
    assert!(p.verify_webhook(&headers, json!({})).await.is_err());
    assert_eq!(f.writes.load(Ordering::SeqCst), 1);
    task.abort();
}

#[tokio::test]
async fn subscription_payload_and_cancel_empty_204_are_bounded() {
    let state = Fixture::default();
    let routes = Router::new()
        .route("/v1/oauth2/token", post(token))
        .route("/v1/billing/subscriptions", post(record))
        .route(
            "/v1/billing/subscriptions/I-FIXTURE/cancel",
            post(
                |State(f): State<Fixture>, headers: HeaderMap, Json(body): Json<Value>| async move {
                    f.requests.lock().await.push((headers, body));
                    StatusCode::NO_CONTENT
                },
            ),
        )
        .route(
            "/v1/billing/subscriptions/I-FIXTURE",
            get(|| async { StatusCode::NO_CONTENT }),
        )
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
    let config = Config {
        database_url: "unused".into(),
        client_id: "fixture".into(),
        client_secret: "fixture".into(),
        webhook_id: "fixture".into(),
        public_origin: "https://paypal.example.test".into(),
        new_purchases: true,
        subscriptions: true,
        subscription_plan: Some("P-FIXTURE".into()),
        allowances: true,
        wallet_login: false,
        relay_url: None,
        extra_origins: vec![],
    };
    let provider = Provider::fixture(base, &config);
    provider
        .create_subscription("local123", "P-FIXTURE", "operation123")
        .await
        .unwrap();
    assert!(
        provider
            .cancel_subscription("I-FIXTURE", "buyer cancellation", "operation456")
            .await
            .unwrap()
            .is_null()
    );
    assert!(
        provider.subscription("I-FIXTURE").await.is_err(),
        "empty 204 must not satisfy a details read"
    );
    assert!(
        provider
            .cancel_subscription("I-FIXTURE", "", "operation789")
            .await
            .is_err()
    );
    let reqs = state.requests.lock().await;
    assert_eq!(reqs[0].1["plan_id"], "P-FIXTURE");
    assert_eq!(reqs[0].1["custom_id"], "local123");
    assert!(reqs[0].1.get("plan").is_none());
    assert_eq!(reqs[1].1, json!({"reason":"buyer cancellation"}));
    assert_eq!(reqs[1].0["paypal-request-id"], "operation456");
    server.abort();
}
