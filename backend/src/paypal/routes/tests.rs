use super::*;
use crate::paypal::domain::{UnitState, random_id};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Mutex;

#[derive(Clone, Default)]
struct Fixture {
    order: Arc<Mutex<Value>>,
    creates: Arc<AtomicUsize>,
    captures: Arc<AtomicUsize>,
    refunds: Arc<AtomicUsize>,
}
async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    (
        origin,
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() }),
    )
}

#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn fixture_checkout_capture_approved_refund_and_private_sharing_end_to_end() {
    let database = std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap();
    let store = Store::connect(&database).await.unwrap();
    let p = Principal {
        id: random_id().unwrap(),
        workspace: random_id().unwrap(),
        role: Role::Buyer,
    };
    let buyer = store.issue_access(&p, 3600).await.unwrap();
    let mut m = p.clone();
    m.role = Role::Merchant;
    let merchant = store.issue_access(&m, 3600).await.unwrap();
    let mut a = p.clone();
    a.role = Role::Agent;
    let agent = store.issue_access(&a, 3600).await.unwrap();
    let fixture = Fixture::default();
    let provider_routes = Router::new()
        .route("/v1/oauth2/token",post(|| async { Json(json!({"access_token":"fixture","token_type":"Bearer","expires_in":3600})) }))
        .route("/v2/checkout/orders",post(|State(f):State<Fixture>,Json(body):Json<Value>| async move {
            f.creates.fetch_add(1,Ordering::SeqCst);
            let result = json!({"id":"ORDER","status":"APPROVED","purchase_units":body["purchase_units"],"links":[{"rel":"payer-action","href":"https://www.sandbox.paypal.com/checkoutnow?token=ORDER"}]});
            *f.order.lock().await = result.clone(); Json(result)
        }))
        .route("/v2/checkout/orders/ORDER",get(|State(f):State<Fixture>| async move { Json(f.order.lock().await.clone()) }))
        .route("/v2/checkout/orders/ORDER/capture",post(|State(f):State<Fixture>| async move {
            f.captures.fetch_add(1,Ordering::SeqCst);
            let mut order = f.order.lock().await;
            order["status"] = "COMPLETED".into();
            order["purchase_units"][0]["payments"] = json!({"captures":[{"id":"CAPTURE","status":"COMPLETED","amount":{"currency_code":"USD","value":"8.00"}}]});
            Json(order.clone())
        }))
        .route("/v2/payments/captures/CAPTURE/refund",post(|State(f):State<Fixture>,Json(body):Json<Value>| async move {
            f.refunds.fetch_add(1,Ordering::SeqCst);
            assert_eq!(body["amount"]["value"],"4.00");
            Json(json!({"id":"REFUND","status":"COMPLETED","amount":body["amount"]}))
        })).with_state(fixture.clone());
    let (provider_origin, provider_task) = serve(provider_routes).await;
    let config = Config {
        database_url: database,
        client_id: "fixture".into(),
        client_secret: "fixture".into(),
        webhook_id: "fixture".into(),
        public_origin: "https://paypal.example.com".into(),
        new_purchases: true,
        subscriptions: false,
        subscription_plan: None,
        allowances: true,
    };
    let provider = Provider::fixture(provider_origin, &config);
    let app = App {
        ai: crate::paypal::ai::Ai::fixture("http://127.0.0.1:1/unused".into()),
        store: store.clone(),
        provider,
        config: Arc::new(config),
    };
    let (origin, server) = serve(router(app)).await;
    let http = reqwest::Client::new();
    let bad_input = json!({"service_id":"document-extract-v1","documents":[{"name":"unreadable","text":"???"}]});
    assert_eq!(
        http.post(format!("{origin}/v1/paypal/preflight"))
            .json(&bad_input)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        http.post(format!("{origin}/v1/paypal/preflight"))
            .bearer_auth(&merchant)
            .json(&bad_input)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let check: Value = http
        .post(format!("{origin}/v1/paypal/preflight"))
        .bearer_auth(&agent)
        .json(&bad_input)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(check["ready"], false);
    assert_eq!(check["issues"][0]["document_index"], 0);
    let mut legacy = bad_input;
    legacy["request_id"] = json!(random_id().unwrap());
    let invalid: Value = http
        .post(format!("{origin}/v1/paypal/tasks"))
        .bearer_auth(&buyer)
        .json(&legacy)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        http.post(format!(
            "{origin}/v1/paypal/tasks/{}/checkout",
            invalid["id"].as_str().unwrap()
        ))
        .bearer_auth(&buyer)
        .json(&json!({"digest":invalid["quote_digest"]}))
        .send()
        .await
        .unwrap()
        .status(),
        422
    );
    assert_eq!(fixture.creates.load(Ordering::SeqCst), 0);
    assert!(
        store
            .get(invalid["id"].as_str().unwrap(), &p)
            .await
            .unwrap()
            .order
            .is_none()
    );
    assert_eq!(
        http.post(format!("{origin}/v1/paypal/recommend-service"))
            .bearer_auth(&buyer)
            .json(&json!({"objective":"Help compare delivery terms"}))
            .send()
            .await
            .unwrap()
            .status(),
        422
    );
    assert_eq!(fixture.creates.load(Ordering::SeqCst), 0);
    let quoted:Value = http.post(format!("{origin}/v1/paypal/tasks")).bearer_auth(&buyer)
        .json(&json!({"request_id":random_id().unwrap(),"documents":[{"name":"a","text":"private document A includes delivery in three working days"},{"name":"b","text":"private document B includes delivery in seven working days"}]})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
    let id = quoted["id"].as_str().unwrap();
    let approval = json!({"digest":quoted["quote_digest"]});
    let path = format!("{origin}/v1/paypal/tasks/{id}");
    assert_eq!(
        http.post(format!("{path}/checkout"))
            .bearer_auth(&agent)
            .json(&approval)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    for _ in 0..2 {
        http.post(format!("{path}/checkout"))
            .bearer_auth(&buyer)
            .json(&approval)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
        http.post(format!("{path}/capture"))
            .bearer_auth(&buyer)
            .json(&approval)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap();
    }
    assert_eq!(fixture.creates.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.captures.load(Ordering::SeqCst), 1);
    // Explicit work fixtures: real AI execution is covered in the next slice.
    store
        .update(id, &p, |t| {
            t.units[0].state = UnitState::Delivered;
            t.units[1].state = UnitState::Failed;
            Ok(())
        })
        .await
        .unwrap();
    let proposal: Value = http
        .get(format!("{path}/refund-proposal"))
        .bearer_auth(&merchant)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let approval = json!({"digest":proposal["digest"]});
    assert_eq!(
        http.post(format!("{path}/refund"))
            .bearer_auth(&buyer)
            .json(&approval)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let (left, right) = tokio::join!(
        http.post(format!("{path}/refund"))
            .bearer_auth(&merchant)
            .json(&approval)
            .send(),
        http.post(format!("{path}/refund"))
            .bearer_auth(&merchant)
            .json(&approval)
            .send()
    );
    left.unwrap().error_for_status().unwrap();
    right.unwrap().error_for_status().unwrap();
    assert_eq!(fixture.refunds.load(Ordering::SeqCst), 1);
    assert_eq!(
        store.get(id, &p).await.unwrap().net().unwrap().decimal(),
        "4.00"
    );
    let shared: Value = http
        .post(format!("{path}/share"))
        .bearer_auth(&buyer)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let public = format!(
        "{origin}/v1/paypal/receipts/{}",
        shared["token"].as_str().unwrap()
    );
    let public_response = http.get(&public).send().await.unwrap();
    assert_eq!(public_response.headers()[header::CACHE_CONTROL], "no-store");
    let public_text = public_response.text().await.unwrap();
    assert!(!public_text.contains("private document"));
    assert!(!public_text.contains("quote_digest"));
    http.delete(format!("{path}/share"))
        .bearer_auth(&buyer)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert_eq!(http.get(&public).send().await.unwrap().status(), 404);
    assert_eq!(
        http.post(format!("{origin}/v1/paypal/webhooks"))
            .json(&json!({"id":"unsigned"}))
            .send()
            .await
            .unwrap()
            .status(),
        422
    );
    let view: Value = http
        .get(format!("{origin}/v1/paypal/analytics"))
        .bearer_auth(&buyer)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(view["captured"], "8.00");
    assert_eq!(view["confirmed_refunds"], "4.00");
    assert_eq!(view["known_net_cost"], "4.00");
    assert!(!view.to_string().contains("quote_digest"));
    assert!(!view.to_string().contains("private document"));
    assert_eq!(
        http.get(format!("{origin}/v1/paypal/analytics"))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let other = Principal {
        id: random_id().unwrap(),
        workspace: random_id().unwrap(),
        role: Role::Merchant,
    };
    let other_token = store.issue_access(&other, 3600).await.unwrap();
    let other_view: Value = http
        .get(format!("{origin}/v1/paypal/analytics"))
        .bearer_auth(&other_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(other_view["task_count"], 0);
    assert_eq!(
        http.post(format!("{path}/reporting"))
            .bearer_auth(&other_token)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    server.abort();
    provider_task.abort();
}

#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn service_quote_retries_preserve_identity_and_reject_mutated_terms() {
    let database = std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap();
    let store = Store::connect(&database).await.unwrap();
    let p = Principal {
        id: random_id().unwrap(),
        workspace: random_id().unwrap(),
        role: Role::Agent,
    };
    let token = store.issue_access(&p, 3600).await.unwrap();
    let config = Config {
        database_url: database,
        client_id: "fixture".into(),
        client_secret: "fixture".into(),
        webhook_id: "fixture".into(),
        public_origin: "https://paypal.example.com".into(),
        new_purchases: true,
        subscriptions: false,
        subscription_plan: None,
        allowances: true,
    };
    let app = App {
        ai: crate::paypal::ai::Ai::fixture("http://127.0.0.1:1/unused".into()),
        provider: Provider::fixture("http://127.0.0.1:1".into(), &config),
        store: store.clone(),
        config: Arc::new(config),
    };
    let (origin, server) = serve(router(app)).await;
    let http = reqwest::Client::new();
    let url = format!("{origin}/v1/paypal/tasks");
    let docs = vec![
        Document {
            name: "A".into(),
            text: "Delivery within three working days.".into(),
        },
        Document {
            name: "B".into(),
            text: "Delivery within seven working days.".into(),
        },
    ];
    // Seed the pre-catalog fingerprint, then retry both implicit and explicit summary.
    let legacy = Task::quote(&p, docs.clone()).unwrap();
    let request_id = random_id().unwrap();
    store
        .create(
            &legacy,
            &request_id,
            &domain::hash(&serde_json::to_vec(&docs).unwrap()),
        )
        .await
        .unwrap();
    let mut body = json!({"request_id":request_id,"documents":docs});
    for explicit in [false, true] {
        if explicit {
            body["service_id"] = json!(domain::OFFER_VERSION);
        }
        let response: Value = http
            .post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(response["id"], legacy.id);
    }
    body["service_id"] = json!(super::super::services::COMPARE);
    assert_eq!(
        http.post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    body["request_id"] = json!(random_id().unwrap());
    body["service_id"] = json!(super::super::services::CHECK);
    body["requirements"] = json!("PRIVATE exact terms");
    let first: Value = http
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let retried: Value = http
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["id"], retried["id"]);
    assert_eq!(retried["requirements"], "PRIVATE exact terms");
    body["requirements"] = json!("substituted terms");
    assert_eq!(
        http.post(&url)
            .bearer_auth(&token)
            .json(&body)
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    let path = format!("{url}/{}", first["id"].as_str().unwrap());
    for action in ["checkout", "capture", "refund"] {
        assert_eq!(
            http.post(format!("{path}/{action}"))
                .bearer_auth(&token)
                .json(&json!({"digest":first["quote_digest"]}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    server.abort();
}

#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn recommendation_route_projection_rejection_and_paid_capacity() {
    let database = std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap();
    let store = Store::connect(&database).await.unwrap();
    let p = Principal {
        id: random_id().unwrap(),
        workspace: random_id().unwrap(),
        role: Role::Buyer,
    };
    let grant = store.issue_access(&p, 3600).await.unwrap();
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let (model_origin, model_server) = serve(Router::new().route("/model", post({
        let entered = entered.clone(); let release = release.clone();
        move |Json(body): Json<Value>| {
            let entered = entered.clone(); let release = release.clone();
            async move {
                assert!(body.get("tools").is_none());
                let data: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                let output = if let Some(objective) = data["objective"].as_str() {
                    assert_eq!(data.as_object().unwrap().len(), 2);
                    assert_eq!(data["catalog"].as_array().unwrap().len(), 3);
                    assert!(!data.to_string().contains("unit_price"));
                    assert!(!data.to_string().contains("private paid document"));
                    assert!(data["catalog"].as_array().unwrap().iter().all(|s| s.get("price").is_none() && s.get("documents").is_none()));
                    match objective {
                        "unsupported: book a flight" => json!({"service_id":null}),
                        "unknown" => json!({"service_id":"invented"}),
                        "extra" => json!({"service_id":"document-compare-v1","price":"0.01"}),
                        "malformed" => json!(["document-compare-v1"]),
                        "outage" => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({}))),
                        "hold" => { entered.notify_one(); release.notified().await; json!({"service_id":"document-compare-v1"}) },
                        "compare delivery" => json!({"service_id":"document-compare-v1"}),
                        _ => panic!("unexpected objective"),
                    }
                } else {
                    assert!(data["document"]["text"].as_str().unwrap().contains("private paid document"));
                    json!({"summary":"Delivery timing","facts":[{"claim":"Three day delivery","evidence":"three working days"}]})
                };
                (StatusCode::OK, Json(json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]})))
            }
        }
    }))).await;
    let config = Config {
        database_url: database,
        client_id: "fixture".into(),
        client_secret: "fixture".into(),
        webhook_id: "fixture".into(),
        public_origin: "https://paypal.example.com".into(),
        new_purchases: true,
        subscriptions: false,
        subscription_plan: None,
        allowances: true,
    };
    let ai = crate::paypal::ai::Ai::fixture(format!("{model_origin}/model"));
    let app = App {
        ai: ai.clone(),
        store: store.clone(),
        provider: Provider::fixture("http://127.0.0.1:1".into(), &config),
        config: Arc::new(config),
    };
    let (origin, server) = serve(router(app)).await;
    let http = reqwest::Client::new();
    let url = format!("{origin}/v1/paypal/recommend-service");
    assert_eq!(
        http.post(&url)
            .json(&json!({"objective":"compare delivery"}))
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    for (objective, status) in [
        ("compare delivery", 200),
        ("unsupported: book a flight", 422),
        ("unknown", 422),
        ("extra", 422),
        ("malformed", 422),
        ("outage", 422),
    ] {
        let response = http
            .post(&url)
            .bearer_auth(&grant)
            .json(&json!({"objective":objective}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), status);
        let body: Value = response.json().await.unwrap();
        if status == 200 {
            assert_eq!(body["service_id"], "document-compare-v1");
            assert_eq!(
                body["explanation"],
                crate::paypal::services::get("document-compare-v1")
                    .unwrap()
                    .delivery
            );
            assert!(body.get("price").is_none());
        } else if objective.starts_with("unsupported") {
            assert!(body["error"].as_str().unwrap().contains("No registered"));
        }
    }
    let holding = tokio::spawn(
        http.post(&url)
            .bearer_auth(&grant)
            .json(&json!({"objective":"hold"}))
            .send(),
    );
    tokio::time::timeout(std::time::Duration::from_secs(1), entered.notified())
        .await
        .unwrap();
    for _ in 0..25 {
        let response = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            http.post(&url)
                .bearer_auth(&grant)
                .json(&json!({"objective":"compare delivery"}))
                .send(),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(response.status(), 422);
    }
    let mut task = Task::quote(
        &p,
        vec![Document {
            name: "private".into(),
            text: "A private paid document promises delivery in three working days.".into(),
        }],
    )
    .unwrap();
    task.captured = true;
    task.capture_id = Some("fixture".into());
    store
        .create(&task, &random_id().unwrap(), "fixture")
        .await
        .unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        ai.run(&store, &task.id, &p),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        store.get(&task.id, &p).await.unwrap().units[0].state,
        UnitState::Delivered
    );
    release.notify_one();
    assert_eq!(holding.await.unwrap().unwrap().status(), 200);
    // Busy calls did not consume the separate suggestion budget.
    assert_eq!(
        http.post(&url)
            .bearer_auth(&grant)
            .json(&json!({"objective":"compare delivery"}))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    server.abort();
    model_server.abort();
}

// Allowances, vault, catalog purchases and approvals against a fixture PayPal.
#[derive(Clone, Default)]
struct VaultFixture {
    orders: Arc<Mutex<std::collections::BTreeMap<String, Value>>>,
    approved: Arc<std::sync::atomic::AtomicBool>,
    auto_capture: Arc<std::sync::atomic::AtomicBool>,
    setups: Arc<AtomicUsize>,
    tokens: Arc<AtomicUsize>,
    creates: Arc<AtomicUsize>,
    captures: Arc<AtomicUsize>,
    refunds: Arc<AtomicUsize>,
}
fn vault_routes(f: VaultFixture) -> Router {
    Router::new()
        .route("/v1/oauth2/token",post(|| async { Json(json!({"access_token":"fixture","token_type":"Bearer","expires_in":3600})) }))
        .route("/v3/vault/setup-tokens",post(|State(f):State<VaultFixture>,Json(body):Json<Value>| async move {
            f.setups.fetch_add(1,Ordering::SeqCst);
            if body["payment_source"].get("card").is_some() {
                assert_eq!(body["payment_source"]["card"]["number"],"4111111111111111");
                Json(json!({"id":"SETUP-CARD","status":"APPROVED"}))
            } else {
                assert_eq!(body["payment_source"]["paypal"]["usage_type"],"MERCHANT");
                Json(json!({"id":"SETUP-PP","status":"PAYER_ACTION_REQUIRED","links":[{"rel":"approve","href":"https://www.sandbox.paypal.com/agreements/approve?approval_session_id=SETUP-PP"}]}))
            }
        }))
        .route("/v3/vault/setup-tokens/SETUP-PP",get(|State(f):State<VaultFixture>| async move {
            let status = if f.approved.load(Ordering::SeqCst) {"APPROVED"} else {"PAYER_ACTION_REQUIRED"};
            Json(json!({"id":"SETUP-PP","status":status}))
        }))
        .route("/v3/vault/payment-tokens",post(|State(f):State<VaultFixture>,Json(body):Json<Value>| async move {
            f.tokens.fetch_add(1,Ordering::SeqCst);
            assert_eq!(body["payment_source"]["token"]["type"],"SETUP_TOKEN");
            Json(json!({"id":format!("TOKEN-{}",body["payment_source"]["token"]["id"].as_str().unwrap()),"status":"ACTIVE"}))
        }))
        .route("/v2/checkout/orders",post(|State(f):State<VaultFixture>,headers:HeaderMap,Json(body):Json<Value>| async move {
            let n = f.creates.fetch_add(1,Ordering::SeqCst);
            let source = &body["payment_source"];
            let vault = source.get("card").or(source.get("paypal")).unwrap();
            assert!(vault["vault_id"].as_str().unwrap().starts_with("TOKEN-"));
            assert_eq!(vault["stored_credential"]["payment_initiator"],"MERCHANT");
            assert!(headers["paypal-request-id"].to_str().unwrap().len()<=38);
            let id = format!("ORDER-{n}");
            let mut order = json!({"id":id,"status":"APPROVED","purchase_units":body["purchase_units"]});
            if f.auto_capture.load(Ordering::SeqCst) {
                order["status"] = "COMPLETED".into();
                order["purchase_units"][0]["payments"] = json!({"captures":[{"id":format!("CAPTURE-{n}"),"status":"COMPLETED","amount":body["purchase_units"][0]["amount"]}]});
            }
            f.orders.lock().await.insert(id, order.clone());
            Json(order)
        }))
        .route("/v2/checkout/orders/{id}",get(|State(f):State<VaultFixture>,Path(id):Path<String>| async move { Json(f.orders.lock().await[&id].clone()) }))
        .route("/v2/checkout/orders/{id}/capture",post(|State(f):State<VaultFixture>,Path(id):Path<String>| async move {
            let n = f.captures.fetch_add(1,Ordering::SeqCst);
            let mut orders = f.orders.lock().await;
            let order = orders.get_mut(&id).unwrap();
            order["status"] = "COMPLETED".into();
            let amount = order["purchase_units"][0]["amount"].clone();
            order["purchase_units"][0]["payments"] = json!({"captures":[{"id":format!("CAPTURE-C{n}"),"status":"COMPLETED","amount":amount}]});
            Json(order.clone())
        }))
        .route("/v2/payments/captures/{id}/refund",post(|State(f):State<VaultFixture>,Json(body):Json<Value>| async move {
            f.refunds.fetch_add(1,Ordering::SeqCst);
            Json(json!({"id":"REFUND","status":"COMPLETED","amount":body["amount"]}))
        }))
        .with_state(f)
}
fn fixture_config(database: String) -> Config {
    Config {
        database_url: database,
        client_id: "fixture".into(),
        client_secret: "fixture".into(),
        webhook_id: "fixture".into(),
        public_origin: "https://paypal.example.com".into(),
        new_purchases: true,
        subscriptions: false,
        subscription_plan: None,
        allowances: true,
    }
}
async fn call(
    http: &reqwest::Client,
    method: &reqwest::Method,
    url: String,
    token: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let mut request = http.request(method.clone(), url).bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.unwrap();
    let status = response.status().as_u16();
    (status, response.json().await.unwrap_or(Value::Null))
}

#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn allowances_vault_purchases_and_approvals_end_to_end() {
    let database = std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap();
    let store = Store::connect(&database).await.unwrap();
    let p = Principal {
        id: random_id().unwrap(),
        workspace: random_id().unwrap(),
        role: Role::Buyer,
    };
    let buyer = store.issue_access(&p, 3600).await.unwrap();
    let mut m = p.clone();
    m.role = Role::Merchant;
    let merchant = store.issue_access(&m, 3600).await.unwrap();
    let a = Principal {
        id: random_id().unwrap(),
        workspace: p.workspace.clone(),
        role: Role::Agent,
    };
    let agent = store.issue_access(&a, 3600).await.unwrap();
    let fixture = VaultFixture::default();
    fixture.auto_capture.store(true, Ordering::SeqCst);
    let (provider_origin, provider_task) = serve(vault_routes(fixture.clone())).await;
    let config = fixture_config(database);
    let app = App {
        ai: crate::paypal::ai::Ai::fixture("http://127.0.0.1:1/unused".into()),
        store: store.clone(),
        provider: Provider::fixture(provider_origin, &config),
        config: Arc::new(config),
    };
    let (origin, server) = serve(router(app.clone())).await;
    let http = reqwest::Client::new();
    let api = |path: &str| format!("{origin}/v1/paypal{path}");
    let expires = domain::now() + 86400;
    let card_request = random_id().unwrap();
    let mut card_body = json!({"request_id":card_request,"name":"Groceries","total_cap_cents":5000,"per_purchase_cap_cents":2000,
        "expires_at":expires,"cooldown_seconds":0,"max_per_day":10,"merchants":["grocer"],"mode":"agent_pays",
        "vault_source":"card","card":{"number":"4111111111111111","expiry":"2030-01","name":"Test Buyer"}});
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api("/allowances"),
            &agent,
            Some(card_body.clone())
        )
        .await
        .0,
        403
    );
    let (status, card) = call(
        &http,
        &reqwest::Method::POST,
        api("/allowances"),
        &buyer,
        Some(card_body.clone()),
    )
    .await;
    assert_eq!(status, 200, "{card}");
    assert_eq!(card["vault"]["status"], "ready");
    assert_eq!(card["vault"]["source"], "card");
    assert_eq!(card["status"], "Active");
    assert_eq!(card["remaining_cents"], 5000);
    assert!(!card.to_string().contains("TOKEN-"));
    assert!(!card.to_string().contains("4111"));
    assert_eq!(fixture.setups.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.tokens.load(Ordering::SeqCst), 1);
    let card_id = card["id"].as_str().unwrap().to_string();
    // Same request again is the same allowance; a changed cap is a conflict.
    let (_, again) = call(
        &http,
        &reqwest::Method::POST,
        api("/allowances"),
        &buyer,
        Some(card_body.clone()),
    )
    .await;
    assert_eq!(again["id"], card_id);
    assert_eq!(fixture.setups.load(Ordering::SeqCst), 1);
    card_body["total_cap_cents"] = json!(9000);
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api("/allowances"),
            &buyer,
            Some(card_body)
        )
        .await
        .0,
        409
    );
    // PayPal wallet source needs the buyer's approval before the token exists.
    let wallet_body = json!({"request_id":random_id().unwrap(),"name":"Tours","total_cap_cents":10000,"per_purchase_cap_cents":5000,
        "expires_at":expires,"cooldown_seconds":0,"max_per_day":3,"merchants":["tours","box-office"],"mode":"agent_pays","vault_source":"paypal"});
    let (status, wallet) = call(
        &http,
        &reqwest::Method::POST,
        api("/allowances"),
        &buyer,
        Some(wallet_body),
    )
    .await;
    assert_eq!(status, 200, "{wallet}");
    assert_eq!(wallet["vault"]["status"], "pending_approval");
    assert!(
        wallet["vault"]["approval_url"]
            .as_str()
            .unwrap()
            .starts_with("https://www.sandbox.paypal.com/")
    );
    let wallet_id = wallet["id"].as_str().unwrap().to_string();
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/allowances/{wallet_id}/vault")),
            &buyer,
            Some(json!({}))
        )
        .await
        .0,
        422
    );
    fixture.approved.store(true, Ordering::SeqCst);
    let (status, finished) = call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/allowances/{wallet_id}/vault")),
        &buyer,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 200, "{finished}");
    assert_eq!(finished["vault"]["status"], "ready");
    assert!(finished["vault"].get("approval_url").is_none());
    call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/allowances/{wallet_id}/vault")),
        &buyer,
        Some(json!({})),
    )
    .await;
    assert_eq!(fixture.tokens.load(Ordering::SeqCst), 2);
    // Agents and merchants see the allowances but never the vault.
    let (_, agent_list) = call(
        &http,
        &reqwest::Method::GET,
        api("/allowances"),
        &agent,
        None,
    )
    .await;
    assert_eq!(agent_list["allowances"].as_array().unwrap().len(), 2);
    assert!(
        agent_list["allowances"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a.get("vault").is_none())
    );
    assert!(!agent_list.to_string().contains("TOKEN-"));
    assert!(!agent_list.to_string().contains("approval_url"));
    let (_, merchant_list) = call(
        &http,
        &reqwest::Method::GET,
        api("/allowances"),
        &merchant,
        None,
    )
    .await;
    assert_eq!(merchant_list["allowances"].as_array().unwrap().len(), 2);
    assert!(!merchant_list.to_string().contains("vault"));
    let (_, catalog) = call(
        &http,
        &reqwest::Method::GET,
        format!("{}?q=coffee", api("/catalog")),
        &agent,
        None,
    )
    .await;
    assert_eq!(catalog["merchants"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["merchants"][0]["id"], "grocer");
    // Quote: no write, verdict included when an allowance is named.
    let items = json!([{"id":"oat-milk","qty":2}]);
    let (status, quote) = call(
        &http,
        &reqwest::Method::POST,
        api("/purchases/quote"),
        &agent,
        Some(json!({"merchant":"grocer","items":items,"allowance_id":card_id})),
    )
    .await;
    assert_eq!(status, 200, "{quote}");
    assert_eq!(quote["amount_cents"], 780);
    assert_eq!(quote["amount"], "7.80");
    assert_eq!(quote["lines"][0]["line_cents"], 780);
    assert_eq!(quote["policy"]["allowed"], true);
    assert_eq!(quote["policy"]["rule"], "allowance-rules-v1");
    assert_eq!(fixture.creates.load(Ordering::SeqCst), 0);
    // agent_pays with an auto-captured vault order.
    let r1 = random_id().unwrap();
    let purchase_body =
        json!({"request_id":r1,"allowance_id":card_id,"merchant":"grocer","items":items});
    let (status, first) = call(
        &http,
        &reqwest::Method::POST,
        api("/purchases"),
        &agent,
        Some(purchase_body.clone()),
    )
    .await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["captured"], true);
    assert_eq!(first["funding_method"], "paypal_vault");
    assert_eq!(first["purchase"]["policy"]["allowed"], true);
    assert_eq!(first["purchase"]["merchant"], "grocer");
    assert_eq!(first["purchase"]["buyer"], p.id);
    assert_eq!(first["purchase"]["mode"], "agent_pays");
    assert!(first["purchase"]["approval"].is_null());
    assert_eq!(first["units"].as_array().unwrap().len(), 2);
    assert_eq!(first["units"][0]["price"], "3.90");
    assert_eq!(first["service_name"], "Corner Grocer");
    assert_eq!(fixture.creates.load(Ordering::SeqCst), 1);
    let first_id = first["id"].as_str().unwrap().to_string();
    let (_, retry) = call(
        &http,
        &reqwest::Method::POST,
        api("/purchases"),
        &agent,
        Some(purchase_body),
    )
    .await;
    assert_eq!(retry["id"], first_id);
    assert_eq!(fixture.creates.load(Ordering::SeqCst), 1);
    assert_eq!(call(&http, &reqwest::Method::POST, api("/purchases"), &agent, Some(json!({"request_id":r1,"allowance_id":card_id,"merchant":"grocer","items":[{"id":"oat-milk","qty":1}]}))).await.0, 409);
    // The buyer can read it; a stranger cannot.
    assert_eq!(
        call(
            &http,
            &reqwest::Method::GET,
            api(&format!("/tasks/{first_id}")),
            &buyer,
            None
        )
        .await
        .0,
        200
    );
    let stranger = store
        .issue_access(
            &Principal {
                id: random_id().unwrap(),
                workspace: p.workspace.clone(),
                role: Role::Buyer,
            },
            3600,
        )
        .await
        .unwrap();
    assert_eq!(
        call(
            &http,
            &reqwest::Method::GET,
            api(&format!("/tasks/{first_id}")),
            &stranger,
            None
        )
        .await
        .0,
        404
    );
    // Vault order that only reaches APPROVED is captured in the same call.
    fixture.auto_capture.store(false, Ordering::SeqCst);
    let (status, second) = call(&http, &reqwest::Method::POST, api("/purchases"), &agent, Some(json!({"request_id":random_id().unwrap(),"allowance_id":card_id,"merchant":"grocer","items":[{"id":"coffee-beans","qty":1}]}))).await;
    assert_eq!(status, 200, "{second}");
    assert_eq!(second["captured"], true);
    assert_eq!(fixture.creates.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.captures.load(Ordering::SeqCst), 1);
    // Refusals are 200 with a reason and never reach PayPal.
    let (status, refused) = call(&http, &reqwest::Method::POST, api("/purchases"), &agent, Some(json!({"request_id":random_id().unwrap(),"allowance_id":card_id,"merchant":"tours","items":[{"id":"audio-guide","qty":1}]}))).await;
    assert_eq!(status, 200, "{refused}");
    assert_eq!(refused["purchase"]["policy"]["allowed"], false);
    assert_eq!(
        refused["purchase"]["policy"]["reason_code"],
        "merchant_not_allowed"
    );
    assert_eq!(refused["captured"], false);
    let (_, over) = call(&http, &reqwest::Method::POST, api("/purchases"), &agent, Some(json!({"request_id":random_id().unwrap(),"allowance_id":card_id,"merchant":"grocer","items":[{"id":"coffee-beans","qty":2}]}))).await;
    assert_eq!(
        over["purchase"]["policy"]["reason_code"],
        "per_purchase_cap"
    );
    assert_eq!(fixture.creates.load(Ordering::SeqCst), 2);
    let (_, view) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/allowances/{card_id}")),
        &buyer,
        None,
    )
    .await;
    assert_eq!(view["spent_cents"], 780 + 1250);
    assert_eq!(view["remaining_cents"], 5000 - 780 - 1250);
    assert_eq!(view["purchases_today"], 2);
    // Pause hides it from agents and blocks spending; Revoked is final.
    let (_, paused) = call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/allowances/{card_id}/status")),
        &buyer,
        Some(json!({"status":"Paused"})),
    )
    .await;
    assert_eq!(paused["status"], "Paused");
    let (_, agent_list) = call(
        &http,
        &reqwest::Method::GET,
        api("/allowances"),
        &agent,
        None,
    )
    .await;
    assert_eq!(agent_list["allowances"].as_array().unwrap().len(), 1);
    let (_, blocked) = call(&http, &reqwest::Method::POST, api("/purchases"), &agent, Some(json!({"request_id":random_id().unwrap(),"allowance_id":card_id,"merchant":"grocer","items":[{"id":"oat-milk","qty":1}]}))).await;
    assert_eq!(
        blocked["purchase"]["policy"]["reason_code"],
        "allowance_not_active"
    );
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/allowances/{card_id}/status")),
            &agent,
            Some(json!({"status":"Active"}))
        )
        .await
        .0,
        403
    );
    call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/allowances/{card_id}/status")),
        &buyer,
        Some(json!({"status":"Revoked"})),
    )
    .await;
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/allowances/{card_id}/status")),
            &buyer,
            Some(json!({"status":"Active"}))
        )
        .await
        .0,
        409
    );
    // ask_first: the agent only requests; the buyer approves or denies.
    fixture.auto_capture.store(true, Ordering::SeqCst);
    let (_, ask) = call(&http, &reqwest::Method::POST, api("/allowances"), &buyer, Some(json!({"request_id":random_id().unwrap(),"name":"Ask me","total_cap_cents":5000,"per_purchase_cap_cents":2000,
        "expires_at":expires,"cooldown_seconds":0,"max_per_day":10,"merchants":["grocer"],"mode":"ask_first",
        "vault_source":"card","card":{"number":"4111111111111111","expiry":"2030-01","name":"Test Buyer"}}))).await;
    let ask_id = ask["id"].as_str().unwrap().to_string();
    let creates_before = fixture.creates.load(Ordering::SeqCst);
    let (status, requested) = call(&http, &reqwest::Method::POST, api("/purchases"), &agent, Some(json!({"request_id":random_id().unwrap(),"allowance_id":ask_id,"merchant":"grocer","items":[{"id":"sourdough","qty":1}]}))).await;
    assert_eq!(status, 200, "{requested}");
    assert_eq!(requested["purchase"]["approval"], "requested");
    assert_eq!(requested["purchase"]["policy"]["allowed"], true);
    assert_eq!(requested["captured"], false);
    assert_eq!(fixture.creates.load(Ordering::SeqCst), creates_before);
    let requested_id = requested["id"].as_str().unwrap().to_string();
    let (_, inbox) = call(
        &http,
        &reqwest::Method::GET,
        api("/purchases/approvals"),
        &buyer,
        None,
    )
    .await;
    assert_eq!(inbox["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(inbox["approvals"][0]["id"], requested_id);
    let digest = inbox["approvals"][0]["quote_digest"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/purchases/{requested_id}/approve")),
            &agent,
            Some(json!({"digest":digest}))
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/purchases/{requested_id}/approve")),
            &buyer,
            Some(json!({"digest":"wrong"}))
        )
        .await
        .0,
        409
    );
    let (status, approved) = call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/purchases/{requested_id}/approve")),
        &buyer,
        Some(json!({"digest":digest})),
    )
    .await;
    assert_eq!(status, 200, "{approved}");
    assert_eq!(approved["purchase"]["approval"], "approved");
    assert_eq!(approved["purchase"]["approved_by"], p.id);
    assert_eq!(approved["captured"], true);
    call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/purchases/{requested_id}/approve")),
        &buyer,
        Some(json!({"digest":digest})),
    )
    .await;
    assert_eq!(fixture.creates.load(Ordering::SeqCst), creates_before + 1);
    let (_, second_request) = call(&http, &reqwest::Method::POST, api("/purchases"), &agent, Some(json!({"request_id":random_id().unwrap(),"allowance_id":ask_id,"merchant":"grocer","items":[{"id":"oat-milk","qty":1}]}))).await;
    let second_id = second_request["id"].as_str().unwrap().to_string();
    let (_, before_deny) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/allowances/{ask_id}")),
        &buyer,
        None,
    )
    .await;
    assert_eq!(before_deny["spent_cents"], 650 + 390);
    let (status, denied) = call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/purchases/{second_id}/deny")),
        &buyer,
        Some(json!({"reason":"Not this week"})),
    )
    .await;
    assert_eq!(status, 200, "{denied}");
    assert_eq!(denied["purchase"]["approval"], "denied");
    assert_eq!(denied["purchase"]["policy"]["allowed"], false);
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/purchases/{second_id}/approve")),
            &buyer,
            Some(json!({"digest":second_request["quote_digest"]}))
        )
        .await
        .0,
        409
    );
    let (_, after_deny) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/allowances/{ask_id}")),
        &buyer,
        None,
    )
    .await;
    assert_eq!(after_deny["spent_cents"], 650);
    assert_eq!(
        call(
            &http,
            &reqwest::Method::GET,
            api("/purchases/approvals"),
            &buyer,
            None
        )
        .await
        .1["approvals"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    // Merchant fulfils per unit; a failed unit is refunded at its own price.
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/tasks/{first_id}/process")),
            &buyer,
            None
        )
        .await
        .0,
        422
    );
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/tasks/{first_id}/fulfil")),
            &buyer,
            Some(json!({"outcomes":[{"unit":0,"state":"delivered"}]}))
        )
        .await
        .0,
        403
    );
    let (status, fulfilled) = call(&http, &reqwest::Method::POST, api(&format!("/tasks/{first_id}/fulfil")), &merchant, Some(json!({"outcomes":[{"unit":0,"state":"delivered"},{"unit":1,"state":"failed","reason":"Out of stock"}]}))).await;
    assert_eq!(status, 200, "{fulfilled}");
    assert_eq!(fulfilled["units"][0]["state"], "delivered");
    assert_eq!(fulfilled["units"][1]["state"], "failed");
    assert!(fulfilled["units"][0]["output_hash"].is_string());
    let (status, refund_request) = call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/tasks/{first_id}/refund-request")),
        &agent,
        Some(json!({"reason":"One item never arrived"})),
    )
    .await;
    assert_eq!(status, 200, "{refund_request}");
    assert_eq!(refund_request["amount"], "3.90");
    assert_eq!(refund_request["failed_units"], json!([1]));
    assert_eq!(refund_request["requires_merchant_approval"], true);
    let (_, with_request) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/tasks/{first_id}")),
        &merchant,
        None,
    )
    .await;
    assert_eq!(
        with_request["purchase"]["refund_request"]["reason"],
        "One item never arrived"
    );
    let (status, refunded) = call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/tasks/{first_id}/refund")),
        &merchant,
        Some(json!({"digest":refund_request["digest"]})),
    )
    .await;
    assert_eq!(status, 200, "{refunded}");
    assert_eq!(refunded["refund"], "3.90");
    assert_eq!(refunded["net"], "3.90");
    assert_eq!(fixture.refunds.load(Ordering::SeqCst), 1);
    // Refunds never give the allowance budget back.
    let (_, still_spent) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/allowances/{card_id}")),
        &buyer,
        None,
    )
    .await;
    assert_eq!(still_spent["spent_cents"], 780 + 1250);
    // Public receipt shows the merchant and rule only.
    let (_, shared) = call(
        &http,
        &reqwest::Method::POST,
        api(&format!("/tasks/{first_id}/share")),
        &buyer,
        None,
    )
    .await;
    let public: Value = http
        .get(api(&format!(
            "/receipts/{}",
            shared["token"].as_str().unwrap()
        )))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(public["purchase"]["merchant"], "grocer");
    assert_eq!(public["purchase"]["policy"]["rule"], "allowance-rules-v1");
    assert_eq!(public["funding_method"], "paypal_vault");
    let text = public.to_string();
    for private in [
        "allowance_id",
        "checks",
        p.id.as_str(),
        &card_id,
        "Out of stock",
        "reason_code",
    ] {
        assert!(!text.contains(private), "{private}");
    }
    // A deleted vault token pauses the allowance.
    assert!(
        app.vault_event(
            &json!({"event_type":"VAULT.PAYMENT-TOKEN.DELETED","resource":{"id":"TOKEN-SETUP-PP"}})
        )
        .await
        .unwrap()
    );
    let (_, wallet_after) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/allowances/{wallet_id}")),
        &buyer,
        None,
    )
    .await;
    assert_eq!(wallet_after["status"], "Paused");
    assert_eq!(wallet_after["vault"]["status"], "none");
    assert!(
        !app.vault_event(
            &json!({"event_type":"VAULT.PAYMENT-TOKEN.DELETED","resource":{"id":"unknown"}})
        )
        .await
        .unwrap()
    );
    server.abort();
    provider_task.abort();
}

#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn disputes_sync_evidence_pack_and_single_submission() {
    let database = std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap();
    let store = Store::connect(&database).await.unwrap();
    let p = Principal {
        id: random_id().unwrap(),
        workspace: random_id().unwrap(),
        role: Role::Buyer,
    };
    let buyer = store.issue_access(&p, 3600).await.unwrap();
    let mut m = p.clone();
    m.role = Role::Merchant;
    let merchant = store.issue_access(&m, 3600).await.unwrap();
    let capture = format!("CAP-{}", &random_id().unwrap()[..8]);
    let mut task = Task::quote_purchase(
        &p,
        &crate::paypal::allowance::Allowance::fixture(&p.id, "agent_pays"),
        "grocer",
        &[crate::paypal::catalog::ItemInput {
            id: "oat-milk".into(),
            qty: 2,
        }],
    )
    .unwrap();
    task.captured = true;
    task.capture_id = Some(capture.clone());
    task.units[0].state = UnitState::Delivered;
    task.units[1].state = UnitState::Delivered;
    let task = store
        .create(&task, &random_id().unwrap(), "fixture")
        .await
        .unwrap();
    let submits = Arc::new(AtomicUsize::new(0));
    let under_review = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let dispute_id = format!("PP-D-{}", &random_id().unwrap()[..8]);
    let detail = {
        let capture = capture.clone();
        let under_review = under_review.clone();
        let dispute_id = dispute_id.clone();
        move || {
            let status = if under_review.load(Ordering::SeqCst) {
                "UNDER_REVIEW"
            } else {
                "WAITING_FOR_SELLER_RESPONSE"
            };
            json!({"dispute_id":dispute_id,"create_time":"2026-10-20T10:00:00.000Z","update_time":"2026-10-21T10:00:00.000Z","status":status,
                "reason":"MERCHANDISE_OR_SERVICE_NOT_RECEIVED","dispute_life_cycle_stage":"INQUIRY","seller_response_due_date":"2026-10-30T10:00:00.000Z",
                "dispute_amount":{"currency_code":"USD","value":"7.80"},"disputed_transactions":[{"seller_transaction_id":capture}]})
        }
    };
    let list_detail = detail.clone();
    let get_detail = detail.clone();
    let provider_routes = Router::new()
        .route(
            "/v1/oauth2/token",
            post(|| async {
                Json(json!({"access_token":"fixture","token_type":"Bearer","expires_in":3600}))
            }),
        )
        .route(
            "/v1/customer/disputes",
            get({
                let capture = capture.clone();
                move |axum::extract::Query(q): axum::extract::Query<
                    std::collections::HashMap<String, String>,
                >| {
                    let capture = capture.clone();
                    let list_detail = list_detail.clone();
                    async move {
                        if q.get("disputed_transaction_id") == Some(&capture) {
                            Json(json!({"items":[{"dispute_id":list_detail()["dispute_id"]}]}))
                        } else {
                            Json(json!({"items":[]}))
                        }
                    }
                }
            }),
        )
        .route(
            "/v1/customer/disputes/{id}",
            get(move |Path(id): Path<String>| {
                let get_detail = get_detail.clone();
                async move {
                    assert_eq!(id, get_detail()["dispute_id"]);
                    Json(get_detail())
                }
            }),
        )
        .route(
            "/v1/customer/disputes/{id}/provide-evidence",
            post({
                let submits = submits.clone();
                move |headers: HeaderMap, body: axum::body::Bytes| {
                    let submits = submits.clone();
                    async move {
                        submits.fetch_add(1, Ordering::SeqCst);
                        let content_type = headers["content-type"].to_str().unwrap().to_string();
                        assert!(content_type.starts_with("multipart/form-data; boundary="));
                        let text = String::from_utf8(body.to_vec()).unwrap();
                        assert!(text.contains("name=\"input\""));
                        assert!(text.contains("PROOF_OF_FULFILLMENT"));
                        assert!(text.contains("were marked delivered"));
                        assert!(headers["paypal-request-id"].to_str().unwrap().len() <= 38);
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        StatusCode::NO_CONTENT
                    }
                }
            }),
        );
    let (provider_origin, provider_task) = serve(provider_routes).await;
    let config = fixture_config(database);
    let app = App {
        ai: crate::paypal::ai::Ai::fixture("http://127.0.0.1:1/unused".into()),
        store: store.clone(),
        provider: Provider::fixture(provider_origin, &config),
        config: Arc::new(config),
    };
    let (origin, server) = serve(router(app.clone())).await;
    let http = reqwest::Client::new();
    let api = |path: &str| format!("{origin}/v1/paypal{path}");
    assert_eq!(
        call(&http, &reqwest::Method::GET, api("/disputes"), &buyer, None)
            .await
            .0,
        403
    );
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api("/disputes/sync"),
            &buyer,
            Some(json!({}))
        )
        .await
        .0,
        403
    );
    let (status, synced) = call(
        &http,
        &reqwest::Method::POST,
        api("/disputes/sync"),
        &merchant,
        Some(json!({})),
    )
    .await;
    assert_eq!(status, 200, "{synced}");
    assert_eq!(synced["disputes"].as_array().unwrap().len(), 1);
    let d = &synced["disputes"][0];
    assert_eq!(d["id"], dispute_id);
    assert_eq!(d["task_id"], task.id);
    assert_eq!(d["capture_id"], capture);
    assert_eq!(d["status"], "WAITING_FOR_SELLER_RESPONSE");
    assert_eq!(d["amount_cents"], 780);
    assert_eq!(d["amount"], "7.80");
    assert_eq!(d["evidence"], "none");
    assert_eq!(d["seller_response_due"], 1_793_354_400u64);
    let (_, receipt) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/tasks/{}", task.id)),
        &buyer,
        None,
    )
    .await;
    assert_eq!(receipt["dispute"]["id"], dispute_id);
    assert_eq!(receipt["dispute"]["status"], "WAITING_FOR_SELLER_RESPONSE");
    let (status, pack) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/disputes/{dispute_id}/evidence")),
        &merchant,
        None,
    )
    .await;
    assert_eq!(status, 200, "{pack}");
    assert_eq!(pack["capture_id"], capture);
    assert_eq!(pack["delivery"].as_array().unwrap().len(), 2);
    assert_eq!(pack["allowance"]["rule"], "allowance-rules-v1");
    let digest = pack["digest"].as_str().unwrap().to_string();
    assert_eq!(
        call(
            &http,
            &reqwest::Method::GET,
            api(&format!("/disputes/{dispute_id}/evidence")),
            &buyer,
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/disputes/{dispute_id}/evidence")),
            &merchant,
            Some(json!({"digest":"stale"}))
        )
        .await
        .0,
        409
    );
    assert_eq!(submits.load(Ordering::SeqCst), 0);
    let (left, right) = tokio::join!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/disputes/{dispute_id}/evidence")),
            &merchant,
            Some(json!({"digest":digest}))
        ),
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/disputes/{dispute_id}/evidence")),
            &merchant,
            Some(json!({"digest":digest}))
        )
    );
    assert_eq!(left.0, 200, "{}", left.1);
    assert_eq!(right.0, 200, "{}", right.1);
    assert_eq!(submits.load(Ordering::SeqCst), 1);
    let (_, after) = call(
        &http,
        &reqwest::Method::GET,
        api("/disputes"),
        &merchant,
        None,
    )
    .await;
    assert_eq!(after["disputes"][0]["evidence"], "submitted");
    assert_eq!(after["disputes"][0]["evidence_digest"], digest);
    assert!(after["disputes"][0]["evidence_submitted_at"].is_u64());
    // A later sync or webhook updates PayPal's fields but keeps our submission record.
    under_review.store(true, Ordering::SeqCst);
    let event = json!({"id":random_id().unwrap(),"event_type":"CUSTOMER.DISPUTE.UPDATED","resource":detail()});
    assert!(app.dispute_event(&event).await.unwrap());
    assert!(!app.dispute_event(&json!({"event_type":"CUSTOMER.DISPUTE.UPDATED","resource":{"dispute_id":"x","disputed_transactions":[{"seller_transaction_id":"nope"}]}})).await.unwrap());
    let (_, updated) = call(
        &http,
        &reqwest::Method::GET,
        api("/disputes"),
        &merchant,
        None,
    )
    .await;
    assert_eq!(updated["disputes"][0]["status"], "UNDER_REVIEW");
    assert_eq!(updated["disputes"][0]["evidence"], "submitted");
    // The pack digest moved with the status; the stale one is refused and the
    // fresh one replays without a second upload.
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/disputes/{dispute_id}/evidence")),
            &merchant,
            Some(json!({"digest":digest}))
        )
        .await
        .0,
        409
    );
    let (_, fresh) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/disputes/{dispute_id}/evidence")),
        &merchant,
        None,
    )
    .await;
    assert_eq!(
        call(
            &http,
            &reqwest::Method::POST,
            api(&format!("/disputes/{dispute_id}/evidence")),
            &merchant,
            Some(json!({"digest":fresh["digest"]}))
        )
        .await
        .0,
        200
    );
    assert_eq!(submits.load(Ordering::SeqCst), 1);
    let (_, receipt) = call(
        &http,
        &reqwest::Method::GET,
        api(&format!("/tasks/{}", task.id)),
        &merchant,
        None,
    )
    .await;
    assert_eq!(receipt["dispute"]["status"], "UNDER_REVIEW");
    assert_eq!(receipt["dispute"]["evidence"], "submitted");
    server.abort();
    provider_task.abort();
}
