//! Audit R2: card activation reports done only once the public commitment
//! reads back from the base layer; checkpoints, mirror failures and storage
//! failures are reported as they are; the reconcile cron repairs the same
//! persisted operation; the selective `CARDS_NEW_ACTIVATION_ENABLED` gate.

use super::*;

impl Harness {
    async fn activate(&self, op: &str, version: u32) -> (u16, Value) {
        self.owner(
            "POST",
            &format!("/v1/cards/{}/activate", self.card_id),
            Some(json!({"clientOperationId": op, "expectedPolicyVersion": version})),
        )
        .await
    }

    async fn reconcile_now(&self) -> Value {
        let (status, report) = self
            .call("POST", "/internal/cron/cards/reconcile", Some(CRON), None)
            .await;
        assert_eq!(status, 200, "{report}");
        report
    }

    async fn record(&self) -> Value {
        self.cards
            .card(&self.card_id)
            .await
            .unwrap()
            .unwrap()
            .record
    }

    fn rule_creates(&self) -> usize {
        self.sim
            .calls()
            .iter()
            .filter(|(m, p, _)| m == "POST" && p == "/v2/auth_rules")
            .count()
    }

    /// A second Axum over the same store, PER, issuer and chain, with
    /// `CARDS_NEW_ACTIVATION_ENABLED=false`.
    async fn gated_url(&self) -> String {
        let mut config = config(AttestationMode::Report);
        config.new_activation_enabled = false;
        let lithic = LithicClient::new(&self.sim.url, "sim-api-key-123".into(), true).unwrap();
        let cards = Arc::new(CardsConnector::new(
            config,
            lithic,
            Per::Fake(self.per.clone()),
            crypto::test_crypto(),
            self.store.clone(),
        ));
        let mut backend = BackendConfig::from_env().unwrap();
        backend.rpc.url = base_rpc(
            self.chain.clone(),
            self.commitments.clone(),
            self.txs.clone(),
        )
        .await;
        let mut state = BackendState::new(backend, self.store.clone()).unwrap();
        state.cards = Some(cards);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let app = build_router(state);
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap()
        });
        url
    }

    async fn call_at(
        &self,
        base: &str,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut request = self
            .http
            .request(method.parse().unwrap(), format!("{base}{path}"));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_issuer_opens_only_after_the_public_commitment_reads_back() {
    let h = Harness::with(AttestationMode::Report, false).await;
    // The base layer has not run the scheduled `write_commitment` yet.
    h.per.knobs.lock().unwrap().hold_commitments = true;
    let (status, view) = h.activate("activate-0001", 1).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["activation"]["state"], "pending_commitment");
    assert_eq!(view["activation"]["steps"]["mirror"], "acknowledged");
    assert_eq!(
        view["activation"]["steps"]["checkpoint"]["state"],
        "scheduled"
    );
    assert_eq!(view["activation"]["steps"]["commitment"], "pending");
    assert_eq!(
        view["commitment"]["state"], "pending",
        "scheduled is not a commitment"
    );
    assert_eq!(view["issuerState"], "PAUSED");
    assert_eq!(h.sim.card_state(&h.card_token).state, "PAUSED");
    // The card route reads the base layer itself: still nothing there.
    let (_, card) = h
        .owner("GET", &format!("/v1/cards/{}", h.card_id), None)
        .await;
    assert_ne!(card["activation"]["state"], "active");
    assert_ne!(card["commitment"]["state"], "confirmed");
    // A retry, even under a new clientOperationId, resumes the same
    // operation: no second mirror, no second checkpoint.
    let (status, again) = h.activate("activate-0002", 1).await;
    assert_eq!(status, 200, "{again}");
    assert_eq!(again["activation"]["state"], "pending_commitment");
    assert_eq!(h.program_count("checkpoint"), 1);
    assert_eq!(h.rule_creates(), 1);
    // The base write lands: the next retry reads it back and opens the card.
    h.per.release_commitments();
    let (status, done) = h.activate("activate-0002", 1).await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["activation"]["state"], "active");
    assert_eq!(done["commitment"]["state"], "confirmed");
    assert_eq!(done["commitment"]["seq"], "1");
    assert_eq!(done["commitment"]["policyVersion"], 1);
    assert_eq!(done["issuerState"], "OPEN");
    assert_eq!(h.sim.card_state(&h.card_token).state, "OPEN");
    assert_eq!(h.program_count("checkpoint"), 1);
    // The same clientOperationId cannot be reused for another version.
    let (status, reused) = h.activate("activate-0002", 2).await;
    assert_eq!(status, 409, "{reused}");
    assert_eq!(reused["code"], "operation_reused");
    let (_, card) = h
        .owner("GET", &format!("/v1/cards/{}", h.card_id), None)
        .await;
    assert_eq!(card["commitment"]["state"], "confirmed");
    assert_eq!(card["commitment"]["source"], "base_readback");
    h.assert_no_pan().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconcile_repairs_the_same_activation_until_the_commitment_reads_back() {
    let h = Harness::with(AttestationMode::Report, false).await;
    h.per.knobs.lock().unwrap().hold_commitments = true;
    let (status, view) = h.activate("activate-0001", 1).await;
    assert_eq!(
        (status, view["activation"]["state"].as_str()),
        (200, Some("pending_commitment"))
    );
    let report = h.reconcile_now().await;
    assert_eq!(report["activationsCompleted"], 0);
    assert_eq!(
        h.record().await["activation"]["state"],
        "pending_commitment"
    );
    assert_eq!(h.sim.card_state(&h.card_token).state, "PAUSED");
    h.per.release_commitments();
    let report = h.reconcile_now().await;
    assert_eq!(report["activationsCompleted"], 1, "{report}");
    assert_eq!(report["commitmentsConfirmed"], 1, "{report}");
    let record = h.record().await;
    assert_eq!(record["activation"]["state"], "active");
    assert_eq!(
        record["commitment"]["seq"], "1",
        "the same checkpoint, not a new one"
    );
    assert_eq!(h.program_count("checkpoint"), 1);
    assert_eq!(h.sim.card_state(&h.card_token).state, "OPEN");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unknown_checkpoint_is_pending_and_resubmitted_at_the_same_seq() {
    let h = Harness::with(AttestationMode::Report, false).await;
    // The first checkpoint submit vanishes: outcome unknown.
    h.per.knobs.lock().unwrap().drop_next = 1;
    let (status, view) = h.activate("activate-0001", 1).await;
    assert_eq!(status, 200, "{view}");
    // Re-driven within the request: PER showed it never took seq 1, so the
    // same seq (same sealed salt) went again, not seq 2.
    assert_eq!(view["activation"]["state"], "active", "{view}");
    let record = h.record().await;
    assert_eq!(record["commitment"]["seq"], "1");
    assert_eq!(record["commitment"]["attempts"], 2);
    assert_eq!(h.program_count("checkpoint"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_mismatched_commitment_keeps_activation_incomplete() {
    let h = Harness::with(AttestationMode::Report, false).await;
    h.per.knobs.lock().unwrap().hold_commitments = true;
    let (status, view) = h.activate("activate-0001", 1).await;
    assert_eq!(
        (status, view["activation"]["state"].as_str()),
        (200, Some("pending_commitment"))
    );
    // The base layer holds seq 1, but for another policy version.
    h.per.drop_commitments();
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    let binding: solana_address::Address =
        card.record["bindingPda"].as_str().unwrap().parse().unwrap();
    let pda = card.record["commitmentPda"].as_str().unwrap().to_owned();
    h.chain.lock().unwrap().insert(
        pda,
        (
            program::CARD_POLICY_PROGRAM_ID.into(),
            super::fake_per::encode_commitment(&binding, 1, &[5; 32], 9, 1),
        ),
    );
    let (status, view) = h.activate("activate-0001", 1).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["activation"]["state"], "pending_commitment");
    assert_ne!(view["commitment"]["state"], "confirmed");
    assert_eq!(view["issuerState"], "PAUSED");
    assert_eq!(h.sim.card_state(&h.card_token).state, "PAUSED");
    // The mismatch was recorded and the current state re-checkpointed (seq 2).
    let record = h.record().await;
    assert_eq!(record["commitment"]["seq"], "2");
    assert_eq!(h.program_count("checkpoint"), 2);
    h.per.release_commitments();
    let (_, done) = h.activate("activate-0001", 1).await;
    assert_eq!(done["activation"]["state"], "active", "{done}");
    assert_eq!(done["commitment"]["seq"], "2");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_pause_after_a_failed_mirror_never_says_paused() {
    let h = Harness::new().await;
    assert_eq!(h.sim.card_state(&h.card_token).state, "OPEN");
    // The owner saved policy v2; the issuer refuses the new rules and the
    // compensating pause.
    h.per.with_card(&h.policy, |c| c.policy.version = 2);
    {
        let mut sim = h.sim.state.lock().unwrap();
        sim.fail_rules = true;
        sim.fail_pause = true;
    }
    let (status, body) = h.activate("activate-v2-01", 2).await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(body["code"], "mirror_failed");
    let message = body["message"].as_str().unwrap();
    assert!(
        !message.contains("stays paused") && !message.contains("confirms the card is paused"),
        "{message}"
    );
    assert!(message.contains("still shows the card open"), "{message}");
    assert_eq!(body["card"]["issuerState"], "OPEN");
    assert_eq!(body["card"]["activation"]["state"], "mirror_failed");
    assert_eq!(h.sim.card_state(&h.card_token).state, "OPEN");
    // The issuer cannot even be read: the answer says so instead of guessing.
    h.sim.state.lock().unwrap().fail_get = true;
    let (status, body) = h.activate("activate-v2-01", 2).await;
    assert_eq!(status, 503, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("could not read the card's state back"),
        "{body}"
    );
    // Pause works again: the issuer's own readback confirms it.
    {
        let mut sim = h.sim.state.lock().unwrap();
        sim.fail_pause = false;
        sim.fail_get = false;
    }
    let (status, body) = h.activate("activate-v2-01", 2).await;
    assert_eq!(status, 503, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("confirms the card is paused"),
        "{body}"
    );
    assert_eq!(body["card"]["issuerState"], "PAUSED");
    assert_eq!(h.sim.card_state(&h.card_token).state, "PAUSED");
    // The issuer recovers: the same operation finishes and reopens the card.
    h.sim.state.lock().unwrap().fail_rules = false;
    let (status, done) = h.activate("activate-v2-01", 2).await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["activation"]["state"], "active");
    assert_eq!(done["mirror"]["policyVersionMirrored"], 2);
    assert_eq!(done["commitment"]["policyVersion"], 2);
    assert_eq!(h.sim.card_state(&h.card_token).state, "OPEN");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rules_the_issuer_did_not_retire_are_surfaced_and_retried() {
    let h = Harness::new().await;
    h.per.with_card(&h.policy, |c| c.policy.version = 2);
    h.sim.state.lock().unwrap().fail_retire = true;
    let (status, view) = h.activate("activate-v2-01", 2).await;
    assert_eq!(status, 200, "{view}");
    assert_eq!(view["activation"]["state"], "active");
    assert_eq!(view["activation"]["steps"]["rules"], "retire_pending");
    assert_eq!(view["mirror"]["rulesRetirePending"], true);
    h.sim.state.lock().unwrap().fail_retire = false;
    h.reconcile_now().await;
    let (_, card) = h
        .owner("GET", &format!("/v1/cards/{}", h.card_id), None)
        .await;
    assert_eq!(card["activation"]["steps"]["rules"], "retired");
    assert!(card["mirror"].get("rulesRetirePending").is_none(), "{card}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_checkpoint_storage_failure_is_an_error_and_is_repaired() {
    let h = Harness::new().await;
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    // The write after the PER submit fails.
    h.store
        .fail_card_writes(Some(crate::storage::CardWriteFault(Arc::new(
            |kind, _, record: &Value| {
                kind == CardKind::Cards && record["commitment"]["state"] == "scheduled"
            },
        ))))
        .await;
    let result = routes::checkpoint(&h.cards, &card).await;
    let error = result.expect_err("a lost write is not a success");
    assert_eq!(error.code, "storage_unavailable");
    h.store.fail_card_writes(None).await;
    // What was stored before the submit is still the honest state: pending.
    let record = h.record().await;
    assert_eq!(record["commitment"]["seq"], "2");
    assert_eq!(record["commitment"]["state"], "pending");
    // The repair phase reads PER and the base layer: same seq, confirmed.
    h.reconcile_now().await;
    let record = h.record().await;
    assert_eq!(record["commitment"]["seq"], "2");
    assert_eq!(record["commitment"]["state"], "confirmed");
    assert_eq!(h.program_count("checkpoint"), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_the_gate_off_only_new_activations_are_refused() {
    let h = Harness::new().await;
    assert_eq!(h.sim.card_state(&h.card_token).state, "OPEN");
    let gated = h.gated_url().await;
    let owner = Some(ORIGIN_FREE_OWNER_TOKEN);
    // New card: refused before any issuer call.
    let creates = h
        .sim
        .calls()
        .iter()
        .filter(|(m, p, _)| m == "POST" && p == "/v1/cards")
        .count();
    let (status, body) = h
        .call_at(
            &gated,
            "POST",
            "/v1/cards/prepare",
            owner,
            Some(json!({"clientOperationId": "prepare-0002", "label": "Another"})),
        )
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (503, Some("new_activation_disabled")),
        "{body}"
    );
    assert_eq!(body["retryable"], false);
    assert_eq!(
        h.sim
            .calls()
            .iter()
            .filter(|(m, p, _)| m == "POST" && p == "/v1/cards")
            .count(),
        creates
    );
    // Activation of the existing OPEN card: refused, nothing changes.
    let calls = h.sim.calls().len();
    let (status, body) = h
        .call_at(
            &gated,
            "POST",
            &format!("/v1/cards/{}/activate", h.card_id),
            owner,
            Some(json!({"clientOperationId": "activate-0003", "expectedPolicyVersion": 1})),
        )
        .await;
    assert_eq!(
        (status, body["code"].as_str()),
        (503, Some("new_activation_disabled")),
        "{body}"
    );
    assert_eq!(h.sim.calls().len(), calls);
    assert_eq!(h.sim.card_state(&h.card_token).state, "OPEN");
    // Reads, statements, disclosure and the cron keep working.
    let (status, list) = h.call_at(&gated, "GET", "/v1/cards", owner, None).await;
    assert_eq!(status, 200, "{list}");
    let (status, card) = h
        .call_at(
            &gated,
            "GET",
            &format!("/v1/cards/{}", h.card_id),
            owner,
            None,
        )
        .await;
    assert_eq!((status, card["issuerState"].as_str()), (200, Some("OPEN")));
    let (status, statements) = h
        .call_at(
            &gated,
            "GET",
            &format!("/v1/cards/{}/statements", h.card_id),
            owner,
            None,
        )
        .await;
    assert_eq!(status, 200, "{statements}");
    let (status, salt) = h
        .call_at(
            &gated,
            "GET",
            &format!("/v1/cards/{}/disclosure-salt?seq=1", h.card_id),
            owner,
            None,
        )
        .await;
    assert_eq!(status, 200, "{salt}");
    let (status, report) = h
        .call_at(
            &gated,
            "POST",
            "/internal/cron/cards/reconcile",
            Some(CRON),
            None,
        )
        .await;
    assert_eq!(status, 200, "{report}");
    // Emergency pause still reaches the issuer.
    let (status, freeze) = h
        .call_at(
            &gated,
            "POST",
            &format!("/v1/cards/{}/freeze", h.card_id),
            owner,
            Some(json!({"clientOperationId": "freeze-gated-1", "reason": "gate test"})),
        )
        .await;
    assert_eq!(status, 200, "{freeze}");
    assert_eq!(h.sim.card_state(&h.card_token).state, "PAUSED");
    assert!(h.per.with_card(&h.policy, |c| c.policy.frozen));
    let (status, after) = h
        .call_at(
            &gated,
            "GET",
            &format!("/v1/cards/{}", h.card_id),
            owner,
            None,
        )
        .await;
    assert_eq!(
        (status, after["freeze"]["issuer"].as_str()),
        (200, Some("confirmed"))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn with_the_gate_off_reconcile_finishes_the_proof_but_never_opens_a_new_card() {
    let h = Harness::with(AttestationMode::Report, false).await;
    h.per.knobs.lock().unwrap().hold_commitments = true;
    let (status, view) = h.activate("activate-0001", 1).await;
    assert_eq!(
        (status, view["activation"]["state"].as_str()),
        (200, Some("pending_commitment"))
    );
    let gated = h.gated_url().await;
    h.per.release_commitments();
    let (status, report) = h
        .call_at(
            &gated,
            "POST",
            "/internal/cron/cards/reconcile",
            Some(CRON),
            None,
        )
        .await;
    assert_eq!(status, 200, "{report}");
    let record = h.record().await;
    assert_eq!(record["commitment"]["state"], "confirmed");
    assert_eq!(record["activation"]["state"], "issuer_pending");
    assert_eq!(record["activation"]["detail"], "new_activation_disabled");
    assert_eq!(h.sim.card_state(&h.card_token).state, "PAUSED");
}
