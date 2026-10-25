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
