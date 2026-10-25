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
    let quoted:Value = http.post(format!("{origin}/v1/paypal/tasks")).bearer_auth(&buyer)
        .json(&json!({"request_id":random_id().unwrap(),"documents":[{"name":"a","text":"private document A"},{"name":"b","text":"private document B"}]})).send().await.unwrap().error_for_status().unwrap().json().await.unwrap();
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
