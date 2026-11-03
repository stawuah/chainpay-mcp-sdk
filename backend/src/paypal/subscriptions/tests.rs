use super::*;
fn buyer() -> Principal {
    Principal {
        id: domain::random_id().unwrap(),
        workspace: domain::random_id().unwrap(),
        role: Role::Buyer,
    }
}
fn initial(p: &Principal) -> Subscription {
    Subscription {
        id: domain::random_id().unwrap(),
        workspace: p.workspace.clone(),
        buyer: p.id.clone(),
        plan_id: "P-FIXTURE".into(),
        terms: TERMS.into(),
        created_at: domain::now(),
        create: Operation::begin().unwrap(),
        cancel: None,
        provider_id: None,
        approval_url: None,
        status: "PENDING".into(),
        payment_review: None,
        anchor: None,
        observed_next: None,
        payment_proofs: Default::default(),
    }
}
fn details(s: &Subscription, start: i64) -> Value {
    json!({"id":format!("I-{}",s.id),"custom_id":s.id,"plan_id":s.plan_id,"status":"ACTIVE","quantity":"1","start_time":stamp(start).unwrap(),"billing_info":{"next_billing_time":stamp(month(start,1).unwrap()).unwrap()},"subscriber":{"email_address":"PRIVATE-SENTINEL@example.test"}})
}
fn history(id: &str, time: i64) -> Value {
    json!({"total_items":1,"total_pages":1,"transactions":[{"id":id,"status":"COMPLETED","time":stamp(time).unwrap(),"amount_with_breakdown":{"gross_amount":{"currency_code":"USD","value":"40.00"}}}]})
}
async fn fixture() -> (Store, Principal, Subscription, i64) {
    fixture_at(domain::now() as i64 - 60).await
}
async fn fixture_at(start: i64) -> (Store, Principal, Subscription, i64) {
    let store = Store::connect(&std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let p = buyer();
    let s = initial(&p);
    sqlx::query("INSERT INTO paypal_subscriptions(id,workspace,buyer,request_id,record) VALUES($1,$2,$3,$4,$5)").bind(&s.id).bind(&p.workspace).bind(&p.id).bind(domain::random_id().unwrap()).bind(json!(s)).execute(store.pool()).await.unwrap();
    let s = store
        .observe_subscription(&s.id, &p, details(&s, start))
        .await
        .unwrap();
    (store, p, s, start)
}
async fn task(store: &Store, p: &Principal) -> Task {
    let t = Task::quote(
        p,
        vec![domain::Document {
            name: "source".into(),
            text:
                "This source document contains more than thirty readable characters for preflight."
                    .into(),
        }],
    )
    .unwrap();
    store
        .create(&t, &domain::random_id().unwrap(), &t.quote_digest)
        .await
        .unwrap()
}
#[test]
fn calendar_anchor_and_terms() {
    let jan = epoch(&json!("2026-01-31T12:30:00Z")).unwrap();
    assert_eq!(
        stamp(month(jan, 1).unwrap()).unwrap(),
        "2026-02-28T12:30:00+00:00"
    );
    assert_eq!(
        stamp(month(jan, 2).unwrap()).unwrap(),
        "2026-03-31T12:30:00+00:00"
    );
    let mut v = json!({"id":"P","status":"ACTIVE","quantity_supported":false,"billing_cycles":[{"tenure_type":"REGULAR","sequence":1,"total_cycles":0,"frequency":{"interval_unit":"MONTH","interval_count":1},"pricing_scheme":{"fixed_price":{"currency_code":"USD","value":"40.00"}}}],"payment_preferences":{"auto_bill_outstanding":false,"setup_fee":{"value":"0.00","currency_code":"USD"}}});
    validate_plan(&v, "P").unwrap();
    v["billing_cycles"][0]["frequency"]["interval_unit"] = "DAY".into();
    assert!(validate_plan(&v, "P").is_err());
}
#[test]
fn cannot_claim_terms_or_foreign_provider_identity() {
    let p = buyer();
    let mut s = initial(&p);
    let mut v = details(&s, domain::now() as i64);
    v["custom_id"] = "other".into();
    s.observe(v).unwrap();
    assert!(s.provider_id.is_none());
    assert!(s.payment_review.is_some());
    let mut paid = history("same-id", domain::now() as i64)["transactions"][0].clone();
    let completed = paid.clone();
    paid["status"] = json!("FAILED");
    assert!(canonical_payments(&s, &[paid.clone(), completed.clone()]).is_err());
    assert!(canonical_payments(&s, &[completed.clone(), paid]).is_err());
    let mut fractional = completed.clone();
    fractional["time"] = json!(
        stamp(domain::now() as i64)
            .unwrap()
            .replace("+00:00", ".001Z")
    );
    assert_ne!(
        payment_proof(&completed).unwrap(),
        payment_proof(&fractional).unwrap()
    );
    for value in ["40", "40.0", "40.00"] {
        assert_eq!(money(&json!(value)), Some(super::super::money::Cents(4000)));
    }
    for value in ["40.001", "40.", "+40", " 40", "4e1", "18446744073709551616"] {
        assert_eq!(money(&json!(value)), None);
    }
}
#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn active_replay_last_unit_delegation_ownership_and_failure() {
    let (store, p, s, start) = fixture().await;
    let t = task(&store, &p).await;
    assert!(
        store
            .allocate(&t.id, &p, &s.id, &t.quote_digest, None)
            .await
            .is_err()
    );
    let payment = domain::random_id().unwrap();
    store
        .grant_payments(&s, history(&payment, start))
        .await
        .unwrap();
    store
        .grant_payments(&s, history(&payment, start))
        .await
        .unwrap();
    let grants: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paypal_allowance_ledger WHERE subscription_id=$1 AND kind='grant'",
    )
    .bind(&s.id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(grants, 1);
    let mut agent = p.clone();
    agent.id = domain::random_id().unwrap();
    agent.role = Role::Agent;
    let d = Delegation {
        id: domain::random_id().unwrap(),
        agent: agent.id.clone(),
        services: vec![domain::OFFER_VERSION.into()],
        task_limit: 1,
        period_limit: 1,
        expires_at: domain::now() + 500,
        revoked: false,
    };
    sqlx::query("INSERT INTO paypal_delegations VALUES($1,$2,$3)")
        .bind(&d.id)
        .bind(&s.id)
        .bind(json!(d))
        .execute(store.pool())
        .await
        .unwrap();
    let delegated = task(&store, &agent).await;
    let funded = store
        .allocate(
            &delegated.id,
            &agent,
            &s.id,
            &delegated.quote_digest,
            Some(&d.id),
        )
        .await
        .unwrap();
    assert!(!funded.captured);
    assert!(funded.verified_funded());
    assert!(funded.can_read(&p));
    assert_eq!(store.get(&delegated.id, &p).await.unwrap().id, delegated.id);
    assert!(
        store
            .list(&p)
            .await
            .unwrap()
            .iter()
            .any(|t| t.id == delegated.id)
    );
    let mut stranger = p.clone();
    stranger.id = domain::random_id().unwrap();
    assert!(store.get(&delegated.id, &stranger).await.is_err());
    let private = store
        .subscription_view(&s.id, &agent)
        .await
        .unwrap()
        .to_string();
    assert!(!private.contains("PRIVATE-SENTINEL"));
    assert!(!private.contains(&s.create.key));
    store
        .update(&delegated.id, &p, |t| {
            t.units[0].state = UnitState::Failed;
            Ok(())
        })
        .await
        .unwrap();
    store.update(&delegated.id, &p, |_| Ok(())).await.unwrap();
    let restored: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paypal_allowance_ledger WHERE task_id=$1 AND kind='restore'",
    )
    .bind(&delegated.id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(restored, 1);
    let allowance = store.subscription_view(&s.id, &agent).await.unwrap();
    assert_eq!(allowance["delegations"][0]["lifetime_reserved_units"], 1);
    assert_eq!(allowance["delegations"][0]["remaining_period_capacity"], 0);
    assert_eq!(allowance["delegations"][0]["available_units"], 0);
    let again = task(&store, &agent).await;
    assert!(
        store
            .allocate(&again.id, &agent, &s.id, &again.quote_digest, Some(&d.id))
            .await
            .is_err()
    );
    sqlx::query("UPDATE paypal_subscription_periods SET remaining=1 WHERE subscription_id=$1")
        .bind(&s.id)
        .execute(store.pool())
        .await
        .unwrap();
    let t2 = task(&store, &p).await;
    let (a, b) = tokio::join!(
        store.allocate(&t.id, &p, &s.id, &t.quote_digest, None),
        store.allocate(&t2.id, &p, &s.id, &t2.quote_digest, None)
    );
    assert_eq!([a.is_ok(), b.is_ok()].iter().filter(|v| **v).count(), 1);
    let winner = if a.is_ok() { t } else { t2 };
    let before = store.get(&winner.id, &p).await.unwrap();
    assert!(
        store
            .update(&winner.id, &p, |t| t
                .start_checkout(&p, &before.quote_digest))
            .await
            .is_err()
    );
    // Expiry stops only new allocations. Already reserved work retains its funding.
    sqlx::query("UPDATE paypal_subscription_periods SET end_at=$1 WHERE subscription_id=$2")
        .bind(domain::now() as i64 - 1)
        .bind(&s.id)
        .execute(store.pool())
        .await
        .unwrap();
    let (paid, ()) = store
        .update(&winner.id, &p, |t| {
            assert!(t.verified_funded());
            t.units[0].state = UnitState::Delivered;
            Ok(())
        })
        .await
        .unwrap();
    assert!(paid.verified_funded());
    sqlx::query("UPDATE paypal_subscription_periods SET blocked=TRUE WHERE subscription_id=$1")
        .bind(&s.id)
        .execute(store.pool())
        .await
        .unwrap();
    assert!(
        !store
            .update(&winner.id, &p, |_| Ok(()))
            .await
            .unwrap()
            .0
            .verified_funded()
    );
}
#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn incomplete_and_ambiguous_history_never_grant() {
    for mode in 0..4 {
        let (store, _p, s, start) = fixture().await;
        let mut h = history(&domain::random_id().unwrap(), start);
        match mode {
            0 => h["total_pages"] = 2.into(),
            1 => h["transactions"][0]["time"] = stamp(start + 7200).unwrap().into(),
            2 => {
                h["transactions"][0]["amount_with_breakdown"]["gross_amount"]["value"] =
                    "80.00".into()
            }
            _ => {
                let mut extra = h["transactions"][0].clone();
                extra["id"] = domain::random_id().unwrap().into();
                h["transactions"].as_array_mut().unwrap().push(extra);
                h["total_items"] = 2.into();
            }
        }
        store.grant_payments(&s, h).await.unwrap();
        let n:i64=sqlx::query_scalar("SELECT COUNT(*) FROM paypal_subscription_periods WHERE subscription_id=$1 AND payment_id IS NOT NULL").bind(&s.id).fetch_one(store.pool()).await.unwrap();
        assert_eq!(n, 0);
    }
}
#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn checkout_and_allowance_share_the_same_lock() {
    let (store, p, s, start) = fixture().await;
    store
        .grant_payments(&s, history(&domain::random_id().unwrap(), start))
        .await
        .unwrap();
    let t = task(&store, &p).await;
    let (a, b) = tokio::join!(
        store.allocate(&t.id, &p, &s.id, &t.quote_digest, None),
        store.update(&t.id, &p, |t| {
            let digest = t.quote_digest.clone();
            t.start_checkout(&p, &digest)
        })
    );
    assert_ne!(a.is_ok(), b.is_ok());
    let t = store.get(&t.id, &p).await.unwrap();
    assert_ne!(t.order.is_some(), t.subscription_funding.is_some());
}
#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn routes_preserve_unknown_operations_delegation_intent_and_sale_refunds() {
    use axum::http::StatusCode;
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::Mutex;
    #[derive(Clone, Default)]
    struct Fixture {
        value: Arc<Mutex<Value>>,
        creates: Arc<AtomicUsize>,
        cancels: Arc<AtomicUsize>,
        history_fail: Arc<AtomicUsize>,
        model_calls: Arc<AtomicUsize>,
    }
    let f = Fixture::default();
    let start = domain::now() as i64 - 10;
    let payment = domain::random_id().unwrap();
    let history_value = history(&payment, start);
    f.history_fail.store(1, Ordering::SeqCst);
    let provider_routes=Router::new()
   .route("/v1/oauth2/token",post(||async{Json(json!({"access_token":"fixture","token_type":"Bearer","expires_in":3600}))}))
   .route("/v1/billing/plans/P-FIXTURE",get(||async{Json(json!({"id":"P-FIXTURE","status":"ACTIVE","quantity_supported":false,"billing_cycles":[{"tenure_type":"REGULAR","sequence":1,"total_cycles":0,"frequency":{"interval_unit":"MONTH","interval_count":1},"pricing_scheme":{"fixed_price":{"currency_code":"USD","value":"40"}}}],"payment_preferences":{"auto_bill_outstanding":false,"setup_fee":{"value":"0","currency_code":"USD"}}}))}))
   .route("/v1/billing/subscriptions",post(move|State(f):State<Fixture>,Json(body):Json<Value>|async move{
    f.creates.fetch_add(1,Ordering::SeqCst);
    *f.value.lock().await=json!({"id":format!("I-{}",body["custom_id"].as_str().unwrap()),"custom_id":body["custom_id"],"plan_id":body["plan_id"],"status":"ACTIVE","quantity":"1","start_time":stamp(start).unwrap(),"billing_info":{"next_billing_time":stamp(month(start,1).unwrap()).unwrap()}});
    StatusCode::SERVICE_UNAVAILABLE
   }))
   .route("/v1/billing/subscriptions/{provider_id}",get(|State(f):State<Fixture>|async move{Json(f.value.lock().await.clone())}))
   .route("/v1/billing/subscriptions/{provider_id}/transactions",get(move|State(f):State<Fixture>|{let v=history_value.clone();async move{(if f.history_fail.load(Ordering::SeqCst)>0 {StatusCode::SERVICE_UNAVAILABLE}else{StatusCode::OK},Json(v))}}))
   .route("/model",post(|State(f):State<Fixture>|async move{f.model_calls.fetch_add(1,Ordering::SeqCst);Json(json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"summary":"The source contains readable content.","facts":[{"claim":"Source has readable content","evidence":"more than thirty readable characters"}]}).to_string()}}]}))}))
   .route("/v1/billing/subscriptions/{provider_id}/cancel",post(|State(f):State<Fixture>|async move{f.cancels.fetch_add(1,Ordering::SeqCst);f.value.lock().await["status"]="CANCELLED".into();StatusCode::NO_CONTENT}))
   .with_state(f.clone());
    async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", l.local_addr().unwrap());
        (
            origin,
            tokio::spawn(async move { axum::serve(l, router).await.unwrap() }),
        )
    }
    let (provider_base, provider_server) = serve(provider_routes).await;
    let store = Store::connect(&std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap())
        .await
        .unwrap();
    let p = buyer();
    let token = store.issue_access(&p, 3600).await.unwrap();
    let config = super::super::config::Config {
        reporting_workspace: None,
        database_url: std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap(),
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
    let app = App {
        store: store.clone(),
        ai: super::super::ai::Ai::fixture(format!("{provider_base}/model")),
        provider: super::super::provider::Provider::fixture(provider_base, &config),
        config: Arc::new(config),
    };
    let (origin, server) = serve(super::super::routes::router(app.clone())).await;
    let http = reqwest::Client::new();
    let body =
        json!({"request_id":domain::random_id().unwrap(),"terms":TERMS,"plan_id":"P-FIXTURE"});
    let created: Value = http
        .post(format!("{origin}/v1/paypal/subscriptions"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["subscription"]["id"].as_str().unwrap();
    assert_eq!(created["subscription"]["create"]["state"], "unknown");
    http.post(format!("{origin}/v1/paypal/subscriptions"))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(f.creates.load(Ordering::SeqCst), 1);
    let event_id = domain::random_id().unwrap();
    store.insert_event(&json!({"id":event_id,"event_type":"BILLING.SUBSCRIPTION.ACTIVATED","resource":{"id":format!("I-{id}"),"custom_id":id}})).await.unwrap();
    app.process_events().await.unwrap();
    let processed: Option<i64> =
        sqlx::query_scalar("SELECT processed_at FROM paypal_webhook_inbox WHERE id=$1")
            .bind(&event_id)
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert!(processed.is_none());
    assert_eq!(
        store.subscription_view(id, &p).await.unwrap()["periods"][0]["available"],
        0
    );
    f.history_fail.store(0, Ordering::SeqCst);
    // The shared fixture inbox can contain older unmatched events; bounded repeated worker passes recover this original event.
    for _ in 0..10 {
        app.process_events().await.unwrap();
        let processed: Option<i64> =
            sqlx::query_scalar("SELECT processed_at FROM paypal_webhook_inbox WHERE id=$1")
                .bind(&event_id)
                .fetch_one(store.pool())
                .await
                .unwrap();
        if processed.is_some() {
            break;
        }
    }
    let processed: Option<i64> =
        sqlx::query_scalar("SELECT processed_at FROM paypal_webhook_inbox WHERE id=$1")
            .bind(&event_id)
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert!(processed.is_some());
    app.process_events().await.unwrap();
    let grants: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paypal_allowance_ledger WHERE subscription_id=$1 AND kind='grant'",
    )
    .bind(id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(grants, 1);
    assert_eq!(
        store.subscription_view(id, &p).await.unwrap()["periods"][0]["available"],
        10
    );
    let delegate_body = json!({"request_id":domain::random_id().unwrap(),"agent":"distinct-route-agent","services":[domain::OFFER_VERSION],"task_limit":1,"period_limit":3,"expires_at":domain::now()+300,"approve":true});
    let url = format!("{origin}/v1/paypal/subscriptions/{id}/delegations");
    let d1: Value = http
        .post(&url)
        .bearer_auth(&token)
        .json(&delegate_body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let d2: Value = http
        .post(&url)
        .bearer_auth(&token)
        .json(&delegate_body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(d1["id"].is_string());
    assert_eq!(d1, d2);
    let mut changed = delegate_body;
    changed["period_limit"] = 4.into();
    assert_eq!(
        http.post(&url)
            .bearer_auth(&token)
            .json(&changed)
            .send()
            .await
            .unwrap()
            .status(),
        409
    );
    let t = task(&store, &p).await;
    store
        .allocate(&t.id, &p, id, &t.quote_digest, None)
        .await
        .unwrap();
    let process_url = format!("{origin}/v1/paypal/tasks/{}/process", t.id);
    assert_eq!(
        http.post(&process_url)
            .bearer_auth(&token)
            .send()
            .await
            .unwrap()
            .status(),
        202
    );
    for _ in 0..100 {
        if store.get(&t.id, &p).await.unwrap().units[0].state == UnitState::Delivered {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    let delivered = store.get(&t.id, &p).await.unwrap();
    assert_eq!(delivered.units[0].state, UnitState::Delivered);
    assert!(delivered.units[0].output_hash.is_some());
    assert!(!delivered.captured);
    assert!(delivered.order.is_none());
    assert!(delivered.capture_id.is_none());
    http.post(&process_url)
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    app.ai.run(&store, &t.id, &p).await.unwrap();
    assert_eq!(f.model_calls.load(Ordering::SeqCst), 1);
    let consumed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paypal_allowance_ledger WHERE task_id=$1 AND kind='consume'",
    )
    .bind(&t.id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(consumed, 1);
    // Cancellation remains available under both purchase pauses and preserves paid access.
    let mut paused = app.clone();
    let mut config = (*paused.config).clone();
    config.new_purchases = false;
    config.subscriptions = false;
    paused.config = Arc::new(config);
    let (paused_origin, paused_server) = serve(super::super::routes::router(paused)).await;
    let cancel_url = format!("{paused_origin}/v1/paypal/subscriptions/{id}/cancel");
    let cancel_body = json!({"terms":format!("cancel:{id}:stop-renewal-keep-paid-access"),"reason":"Buyer stopped renewal"});
    for _ in 0..2 {
        assert_eq!(
            http.post(&cancel_url)
                .bearer_auth(&token)
                .json(&cancel_body)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    assert_eq!(f.cancels.load(Ordering::SeqCst), 1);
    assert!(store.get(&t.id, &p).await.unwrap().verified_funded());
    assert!(app.subscription_event(&json!({"event_type":"PAYMENT.SALE.REFUNDED","resource":{"id":"REFUND-ONLY","sale_id":payment}})).await.unwrap());
    assert!(!store.get(&t.id, &p).await.unwrap().verified_funded());
    assert_eq!(
        store.subscription_view(id, &p).await.unwrap()["periods"][0]["available"],
        0
    );
    paused_server.abort();
    server.abort();
    provider_server.abort();
}

#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn chronological_history_and_immutable_replay_proofs() {
    let feb = epoch(&json!("2026-02-01T00:00:00Z")).unwrap();
    let (store, p, s, _) = fixture_at(feb).await;
    let mut observed = details(&s, feb);
    observed["billing_info"]["next_billing_time"] = json!(stamp(month(feb, 2).unwrap()).unwrap());
    let s = store
        .observe_subscription(&s.id, &p, observed)
        .await
        .unwrap();
    let a = history(&domain::random_id().unwrap(), feb)["transactions"][0].clone();
    let b =
        history(&domain::random_id().unwrap(), month(feb, 1).unwrap())["transactions"][0].clone();
    store
        .grant_payments(
            &s,
            json!({"total_items":2,"total_pages":1,"transactions":[b,a]}),
        )
        .await
        .unwrap();
    assert!(
        store
            .subscription(&s.id, &p)
            .await
            .unwrap()
            .payment_review
            .is_none()
    );
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paypal_allowance_ledger WHERE subscription_id=$1 AND kind='grant'",
    )
    .bind(&s.id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(n, 2);
    for field in [
        "amount",
        "currency",
        "time",
        "PARTIALLY_REFUNDED",
        "DECLINED",
        "FAILED",
    ] {
        let (store, p, s, start) = fixture().await;
        let id = domain::random_id().unwrap();
        let h = history(&id, start);
        store.grant_payments(&s, h.clone()).await.unwrap();
        let t = task(&store, &p).await;
        store
            .allocate(&t.id, &p, &s.id, &t.quote_digest, None)
            .await
            .unwrap();
        let mut bad = h;
        match field {
            "amount" => {
                bad["transactions"][0]["amount_with_breakdown"]["gross_amount"]["value"] =
                    json!("39.99")
            }
            "currency" => {
                bad["transactions"][0]["amount_with_breakdown"]["gross_amount"]["currency_code"] =
                    json!("EUR")
            }
            "time" => bad["transactions"][0]["time"] = json!(stamp(start + 1).unwrap()),
            status => bad["transactions"][0]["status"] = json!(status),
        }
        store.grant_payments(&s, bad).await.unwrap();
        assert!(
            !store.get(&t.id, &p).await.unwrap().verified_funded(),
            "{field}"
        );
        let current = store.subscription(&s.id, &p).await.unwrap();
        assert_eq!(current.payment_proofs[&id].time, start);
        assert_eq!(current.payment_proofs[&id].amount_cents, 4000);
    }
}

#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn whole_history_precedes_grants_and_cutoff_is_explicit() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::Notify;
    let start = domain::now() as i64 - 3600;
    let (store, p, mut s, _) = fixture_at(start).await;
    s.created_at = (start + 1800 - 30 * 86400 + 60) as u64;
    sqlx::query("UPDATE paypal_subscriptions SET record=$1 WHERE id=$2")
        .bind(json!(s))
        .bind(&s.id)
        .execute(store.pool())
        .await
        .unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let calls = Arc::new(AtomicUsize::new(0));
    let first = history(&domain::random_id().unwrap(), start + 1799);
    let second = history(&domain::random_id().unwrap(), start + 1801);
    let info = details(&s, start);
    let enter = entered.clone();
    let resume = release.clone();
    let count = calls.clone();
    let provider=Router::new().route("/v1/oauth2/token",post(||async{Json(json!({"access_token":"fixture","token_type":"Bearer","expires_in":3600}))}))
 .route("/v1/billing/plans/P-FIXTURE",get(||async{Json(json!({"id":"P-FIXTURE","status":"ACTIVE","billing_cycles":[{"tenure_type":"REGULAR","sequence":1,"total_cycles":0,"frequency":{"interval_unit":"MONTH","interval_count":1},"pricing_scheme":{"fixed_price":{"currency_code":"USD","value":"40.00"}}}],"payment_preferences":{"auto_bill_outstanding":false}}))}))
 .route("/v1/billing/subscriptions/{id}",get(move||{let v=info.clone();async move{Json(v)}}))
 .route("/v1/billing/subscriptions/{id}/transactions",get(move||{let n=count.fetch_add(1,Ordering::SeqCst);let v=if n==0{first.clone()}else{second.clone()};let enter=enter.clone();let resume=resume.clone();async move{if n==1 {enter.notify_one();resume.notified().await;}Json(v)}}));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", l.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(l, provider).await.unwrap() });
    let config = super::super::config::Config {
        reporting_workspace: None,
        database_url: std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap(),
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
    let app = App {
        store: store.clone(),
        ai: super::super::ai::Ai::fixture("http://127.0.0.1:1/unused".into()),
        provider: super::super::provider::Provider::fixture(origin, &config),
        config: Arc::new(config),
    };
    let runner = app.clone();
    let id = s.id.clone();
    let owner = p.clone();
    let job = tokio::spawn(async move { runner.reconcile_subscription(&id, &owner).await });
    tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
        .await
        .unwrap();
    assert_eq!(
        store.subscription_view(&s.id, &p).await.unwrap()["periods"][0]["available"],
        0,
        "no first-window allowance while next window is unknown"
    );
    release.notify_one();
    assert!(job.await.unwrap().is_err());
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM paypal_allowance_ledger WHERE subscription_id=$1 AND kind='grant'",
    )
    .bind(&s.id)
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(n, 0);
    // The cutoff is checked before any transaction traversal; never silently stops after 120 windows.
    s.created_at = domain::now() - ((HISTORY_WINDOWS as u64 + 1) * 30 * 86400);
    sqlx::query("UPDATE paypal_subscriptions SET record=$1 WHERE id=$2")
        .bind(json!(s))
        .bind(&s.id)
        .execute(store.pool())
        .await
        .unwrap();
    let before = calls.load(Ordering::SeqCst);
    assert!(app.reconcile_subscription(&s.id, &p).await.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), before);
    assert!(
        store
            .subscription(&s.id, &p)
            .await
            .unwrap()
            .payment_review
            .unwrap()
            .contains("cutoff")
    );
    server.abort();
}

#[tokio::test]
#[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
async fn rework_of_restored_failure_never_reconsumes_or_restores_quota() {
    use super::super::{
        ai::Ai,
        resolution::{Action, Binding, Intent},
    };
    let (store, p, s, start) = fixture().await;
    store
        .grant_payments(&s, history(&domain::random_id().unwrap(), start))
        .await
        .unwrap();
    let t = task(&store, &p).await;
    store
        .allocate(&t.id, &p, &s.id, &t.quote_digest, None)
        .await
        .unwrap();
    store
        .update(&t.id, &p, |t| {
            t.units[0].state = UnitState::Failed;
            Ok(())
        })
        .await
        .unwrap();
    let before = store.subscription_view(&s.id, &p).await.unwrap();
    let m = Principal {
        role: Role::Merchant,
        ..p.clone()
    };
    store
        .update(&t.id, &m, |t| {
            t.rework(
                &m,
                Intent {
                    request_id: domain::random_id()?,
                    binding: Binding {
                        unit: 0,
                        revision: 0,
                        output_hash: None,
                    },
                    action: Action::Rework,
                    reason: "Retry free without changing purchased source".into(),
                },
            )
        })
        .await
        .unwrap();
    let model=Router::new().route("/model",post(||async {let output=json!({"summary":"Source review","facts":[{"claim":"Source has readable text","evidence":"more than thirty readable characters"}]});Json(json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}))}));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let ai = Ai::fixture(format!("http://{}/model", l.local_addr().unwrap()));
    let server = tokio::spawn(async move { axum::serve(l, model).await.unwrap() });
    ai.run(&store, &t.id, &p).await.unwrap();
    assert_eq!(
        store.get(&t.id, &p).await.unwrap().units[0].state,
        UnitState::Delivered
    );
    let after = store.subscription_view(&s.id, &p).await.unwrap();
    assert_eq!(
        before["periods"][0]["available"],
        after["periods"][0]["available"]
    );
    let outcomes:Vec<String>=sqlx::query_scalar("SELECT kind FROM paypal_allowance_ledger WHERE task_id=$1 AND kind IN ('consume','restore')").bind(&t.id).fetch_all(store.pool()).await.unwrap();
    assert_eq!(outcomes, vec!["restore"]);
    server.abort();
}
