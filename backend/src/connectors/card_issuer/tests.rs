//! Connector integration tests: the real Axum router, the real connector, a
//! Lithic-shaped sandbox double (`sim`) and an in-process `card_policy` model
//! (`fake_per`). Scenario files are shared with `scripts/card-sim`.

use super::fake_per::{FakePer, FakePolicy};
use super::per::Per;
use super::sim::{self, LithicSim};
use super::tee::{AttestationMode, AttestationStatus};
use super::*;
use crate::server::{BackendConfig, BackendState, build_router};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

const ORIGIN_FREE_OWNER_TOKEN: &str = "owner-session-token-0123456789abcdef0123456789";
const AGENT_TOKEN: &str = "agent-connection-token-0123456789abcdef012345";
const OTHER_TOKEN: &str = "other-owner-session-token-0123456789abcdef0123";
const CRON: &str = "cron-secret-0123456789abcdef";
const RUNNER: &str = "runner-secret-0123456789abcdef0123456789abcdef";

fn hash(token: &str) -> String {
    program::hex(&Sha256::digest(token.as_bytes()))
}

struct Harness {
    url: String,
    http: reqwest::Client,
    store: StatusStore,
    per: Arc<FakePer>,
    sim: LithicSim,
    cards: Arc<CardsConnector>,
    owner: String,
    card_id: String,
    card_token: String,
    policy: solana_address::Address,
    responses: Arc<std::sync::Mutex<Vec<String>>>,
    asa_seq: std::sync::atomic::AtomicU64,
    chain: Chain,
    txs: Txs,
    commitments: Arc<std::sync::Mutex<Vec<String>>>,
    owner_key: ed25519_dalek::SigningKey,
}

fn config(mode: AttestationMode) -> CardsConfig {
    CardsConfig {
        issuer_writes: true,
        checkout_enabled: true,
        new_activation_enabled: true,
        asa_verifier: crate::connectors::inbox::StandardWebhooks::new(&sim::asa_secret()).unwrap(),
        events_verifier: crate::connectors::inbox::StandardWebhooks::new(&sim::events_secret())
            .unwrap(),
        attestation_mode: mode,
        measurements: vec![],
        tee_url: String::new(),
        pccs_url: String::new(),
        cron_secret: Some(CRON.into()),
        runner_secret: Some(RUNNER.into()),
        asa_budget: Duration::from_millis(2_000),
        embed_origin: None,
        issuer_code: program::ISSUER_LITHIC_SANDBOX,
        repayment: statements::RepaymentConfig {
            mint: statements::DEVNET_USDC_MINT.into(),
            partner_token_account: Some(PARTNER_TOKEN_ACCOUNT.into()),
        },
    }
}

/// Simulated partner's token account in tests: the Devnet partner's USDC
/// associated token account (private repayment checks it is the ATA).
pub(super) const PARTNER_TOKEN_ACCOUNT: &str = "3burs6CNFvrQW8US2C5W84do8J1EezWsQfsoBAvHF5q6";

/// Base-layer accounts served by the test RPC: address -> (owner, data).
pub(super) type Chain = Arc<std::sync::Mutex<HashMap<String, (String, Vec<u8>)>>>;

/// Finalized base-layer transactions served by the test RPC, oldest first:
/// (signature, slot, jsonParsed transaction). All of them touch the
/// simulated partner token account (private repayment settlements).
pub(super) type Txs = Arc<std::sync::Mutex<Vec<(String, u64, Value)>>>;

async fn base_rpc(
    chain: Chain,
    commitments: Arc<std::sync::Mutex<Vec<String>>>,
    txs: Txs,
) -> String {
    use axum::{Json as AxJson, Router};
    use base64::Engine;
    let app = Router::new().fallback(move |AxJson(body): AxJson<Value>| {
        let chain = chain.clone();
        let commitments = commitments.clone();
        let txs = txs.clone();
        async move {
            match body["method"].as_str() {
                Some("getSignaturesForAddress") => {
                    let opts = &body["params"][1];
                    let limit = opts["limit"].as_u64().unwrap_or(1000) as usize;
                    let list = txs.lock().unwrap().clone();
                    let mut out = Vec::new();
                    let mut started = opts["before"].is_null();
                    for (sig, slot, _) in list.iter().rev() {
                        if opts["until"].as_str() == Some(sig.as_str()) {
                            break;
                        }
                        if !started {
                            started = opts["before"].as_str() == Some(sig.as_str());
                            continue;
                        }
                        out.push(json!({"signature": sig, "slot": slot, "err": null, "blockTime": 1}));
                        if out.len() >= limit {
                            break;
                        }
                    }
                    AxJson(json!({"jsonrpc":"2.0","id":1,"result": out}))
                }
                Some("getTransaction") => {
                    let sig = body["params"][0].as_str().unwrap_or_default();
                    let tx = txs.lock().unwrap().iter().find(|(s, _, _)| s == sig).map(|(_, _, t)| t.clone());
                    AxJson(json!({"jsonrpc":"2.0","id":1,"result": tx}))
                }
                Some("getLatestBlockhash") => AxJson(json!({"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":{"blockhash":"11111111111111111111111111111111","lastValidBlockHeight":100}}})),
                Some("getAccountInfo") => {
                    let address = body["params"][0].as_str().unwrap_or_default();
                    if let Some(c) = body["params"][1]["commitment"].as_str() {
                        commitments.lock().unwrap().push(c.to_owned());
                    }
                    let value = chain.lock().unwrap().get(address).map(|(owner, data)| {
                        json!({"owner": owner, "data": [base64::engine::general_purpose::STANDARD.encode(data), "base64"], "lamports": 1, "executable": false, "rentEpoch": 0})
                    });
                    AxJson(json!({"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":value}}))
                }
                Some("sendTransaction") => AxJson(json!({"jsonrpc":"2.0","id":1,"result":"5wHu1qwD7q5ifaN5nwdcDqNFo53GJqa7nLp2BeeEpcHCusb4GzARz4GjgzsEHMkBMgCJMGa6GSQ1VG96Exv8kt2W"})),
                Some("getSignatureStatuses") => AxJson(json!({"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":[{"slot":3,"confirmations":null,"confirmationStatus":"finalized","err":null}]}})),
                Some("getSlot") => AxJson(json!({"jsonrpc":"2.0","id":1,"result":5})),
                _ => AxJson(json!({"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":null}})),
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

impl Harness {
    async fn new() -> Self {
        Self::with(AttestationMode::Report, true).await
    }

    async fn with(mode: AttestationMode, activate: bool) -> Self {
        let store = StatusStore::in_memory();
        let sim = LithicSim::start().await;
        let per = Arc::new(FakePer::new());
        let lithic = LithicClient::new(&sim.url, "sim-api-key-123".into(), true).unwrap();
        let cards = Arc::new(CardsConnector::new(
            config(mode),
            lithic,
            Per::Fake(per.clone()),
            crypto::test_crypto(),
            store.clone(),
        ));
        let chain: Chain = Arc::default();
        let txs: Txs = Arc::default();
        let commitments: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
        // Scheduled `write_commitment` actions land in the test RPC's accounts.
        *per.base.lock().unwrap() = Some(chain.clone());
        let mut backend = BackendConfig::from_env().unwrap();
        backend.rpc.url = base_rpc(chain.clone(), commitments.clone(), txs.clone()).await;
        let mut state = BackendState::new(backend, store.clone()).unwrap();
        state.cards = Some(cards.clone());
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
        sim.set_asa_url(&format!("{url}/v1/cards/lithic/asa"));
        let owner_key = ed25519_dalek::SigningKey::from_bytes(&[9; 32]);
        let owner = bs58::encode(owner_key.verifying_key().to_bytes()).into_string();
        let far = now_ms() + 86_400_000;
        store
            .put_auth(
                &format!("session:{}", hash(ORIGIN_FREE_OWNER_TOKEN)),
                json!({"wallet": owner}),
                far,
            )
            .await
            .unwrap();
        store
            .put_auth(
                &format!("session:{}", hash(OTHER_TOKEN)),
                json!({"wallet": bs58::encode([3u8; 32]).into_string()}),
                far,
            )
            .await
            .unwrap();
        let mut harness = Self {
            url,
            http: reqwest::Client::new(),
            store,
            per,
            sim,
            cards,
            owner,
            card_id: String::new(),
            card_token: String::new(),
            policy: solana_address::Address::default(),
            responses: Arc::new(std::sync::Mutex::new(Vec::new())),
            asa_seq: std::sync::atomic::AtomicU64::new(0),
            chain,
            txs,
            commitments,
            owner_key,
        };
        harness.create_card(activate).await;
        harness
    }

    async fn call(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut request = self
            .http
            .request(method.parse().unwrap(), format!("{}{path}", self.url));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        self.responses.lock().unwrap().push(text.clone());
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    async fn owner(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        self.call(method, path, Some(ORIGIN_FREE_OWNER_TOKEN), body)
            .await
    }

    async fn create_card(&mut self, activate: bool) {
        let (status, prepared) = self
            .owner(
                "POST",
                "/v1/cards/prepare",
                Some(json!({"clientOperationId": "prepare-0001", "label": "Data API card"})),
            )
            .await;
        assert_eq!(status, 200, "{prepared}");
        self.card_id = prepared["cardId"].as_str().unwrap().to_owned();
        let card = self.cards.card(&self.card_id).await.unwrap().unwrap();
        self.card_token = self.cards.card_issuer(&card).unwrap().card_token;
        self.policy = prepared["accounts"]["policy"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let period: solana_address::Address = prepared["accounts"]["period"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        self.per.add_card(
            self.policy,
            period,
            FakePolicy {
                binding: prepared["accounts"]["binding"]
                    .as_str()
                    .unwrap()
                    .parse()
                    .unwrap(),
                owner: self.owner.parse().unwrap(),
                authorizer: self.per.authorizer(),
                version: 1,
                budget: 5_000,
                max_purchase: 4_000,
                merchants: vec![program::merchant_id_hash("DEMO-DATAAPI")],
                fee_bps: 50,
                ..Default::default()
            },
        );
        let scope = json!({"version": 1, "mandates": [], "tools": ["request_card_checkout", "get_card_activity", "get_statement"], "agents": {}, "cards": [self.card_id]});
        self.store
            .put_auth(
                &format!("connection:{}", hash(AGENT_TOKEN)),
                json!({"wallet": self.owner, "scope": scope.to_string()}),
                now_ms() + 86_400_000,
            )
            .await
            .unwrap();
        if activate {
            let (status, view) = self
                .owner(
                    "POST",
                    &format!("/v1/cards/{}/activate", self.card_id),
                    Some(json!({"clientOperationId": "activate-0001", "expectedPolicyVersion": 1})),
                )
                .await;
            assert_eq!(status, 200, "{view}");
            assert_eq!(view["issuerState"], "OPEN");
        }
    }

    /// Opens an intent and redeems it the way the checkout runner does
    /// (`state: redeemed`), so an ASA can match it.
    async fn intent(&self, merchant: &str, amount: &str) -> (u16, Value) {
        let (status, body) = self.intent_unredeemed(merchant, amount).await;
        if let Some(id) = body["intentId"].as_str() {
            self.cards
                .update_txn_or_intent(&format!("intent:{id}"), |record| {
                    record["state"] = json!("redeemed");
                })
                .await
                .unwrap();
        }
        (status, body)
    }

    async fn intent_unredeemed(&self, merchant: &str, amount: &str) -> (u16, Value) {
        let n = self
            .asa_seq
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.call(
            "POST",
            &format!("/v1/cards/{}/checkout-intents", self.card_id),
            Some(AGENT_TOKEN),
            Some(json!({"clientOperationId": format!("checkout-{n:04}"), "merchantRef": merchant, "amountCents": amount, "currency": "USD"})),
        )
        .await
    }

    async fn asa(&self, txn: &str, amount: u64, merchant: &str, status: &str) -> (u16, String) {
        let m = merchant_by_ref(merchant).unwrap();
        let raw = serde_json::to_vec(&sim::asa_payload(
            txn,
            &self.card_token,
            amount,
            m.acceptor_id,
            m.descriptor,
            &m.mcc.to_string(),
            status,
        ))
        .unwrap();
        let response = self
            .http
            .post(format!("{}/v1/cards/lithic/asa", self.url))
            .headers(sim::signed_headers(
                &sim::ASA_KEY,
                &format!("asa_{txn}"),
                &raw,
            ))
            .body(raw)
            .send()
            .await
            .unwrap();
        let code = response.status().as_u16();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        self.responses.lock().unwrap().push(body.to_string());
        (code, body["result"].as_str().unwrap_or("").to_owned())
    }

    async fn deliver(&self, webhook_id: &str, raw: Vec<u8>) -> u16 {
        let response = self
            .http
            .post(format!("{}/v1/cards/lithic/events", self.url))
            .headers(sim::signed_headers(&sim::EVENTS_KEY, webhook_id, &raw))
            .body(raw)
            .send()
            .await
            .unwrap();
        response.status().as_u16()
    }

    async fn txn(&self, token: &str) -> Value {
        self.cards
            .txn(token)
            .await
            .unwrap()
            .map(|r| r.record)
            .unwrap_or(Value::Null)
    }

    fn program_count(&self, name: &str) -> usize {
        self.per.log().iter().filter(|n| *n == name).count()
    }

    /// Fails on any plaintext card number anywhere ChainPay keeps data.
    async fn assert_no_pan(&self) {
        let pans: Vec<String> = self
            .sim
            .state
            .lock()
            .unwrap()
            .cards
            .values()
            .map(|c| c.pan.clone())
            .collect();
        assert!(!pans.is_empty());
        let mut haystacks: Vec<String> = Vec::new();
        haystacks.extend(
            self.store
                .all_card_records()
                .await
                .iter()
                .map(|r| format!("{} {:?} {}", r.key, r.index, r.record)),
        );
        haystacks.extend(
            self.store
                .all_operation_claims()
                .await
                .iter()
                .map(|c| format!("{c:?}")),
        );
        haystacks.extend(self.responses.lock().unwrap().iter().cloned());
        haystacks.extend(captured_logs().lock().unwrap().iter().cloned());
        for pan in &pans {
            for text in &haystacks {
                assert!(
                    !text.contains(pan.as_str()),
                    "PAN leaked into: {}",
                    &text[..text.len().min(200)]
                );
                assert!(!text.contains(&pan[4..]), "PAN digits leaked");
            }
        }
        // The Lithic card token only ever lives inside an encryption envelope.
        for text in self
            .store
            .all_card_records()
            .await
            .iter()
            .map(|r| r.record.to_string())
        {
            assert!(
                !text.contains(&self.card_token),
                "issuer card token stored in plaintext"
            );
        }
        for text in self.responses.lock().unwrap().iter() {
            assert!(
                !text.contains(&self.card_token),
                "issuer card token returned to a client"
            );
        }
    }
}

// ------------------------------------------------------------ scenario runner

async fn run_scenario(file: &str) {
    let scenario: Value = serde_json::from_str(file).unwrap();
    let h = Harness::new().await;
    let mut snapshots: HashMap<String, Vec<u8>> = HashMap::new();
    let name = scenario["name"].as_str().unwrap().to_owned();
    for (i, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
        let at = format!("{name} step {i}: {step}");
        let txn = |s: &Value| format!("{}-{}", name, s["txn"].as_str().unwrap());
        if let Some(s) = step.get("intent") {
            let (status, body) = h
                .intent(
                    s["merchant"].as_str().unwrap(),
                    s["amountCents"].as_str().unwrap(),
                )
                .await;
            assert_eq!(status, 200, "{at}: {body}");
        } else if let Some(s) = step.get("asa") {
            let token = txn(s);
            let amount = s["amountCents"].as_u64().unwrap();
            let merchant = s["merchant"].as_str().unwrap();
            let status = s["status"].as_str().unwrap_or("AUTHORIZATION");
            let (code, result) = h.asa(&token, amount, merchant, status).await;
            assert_eq!(code, 200, "{at}");
            assert_eq!(result, step["expect"].as_str().unwrap(), "{at}");
            if h.sim.transaction(&token).is_none() {
                let kind = if status == "FINANCIAL_AUTHORIZATION" {
                    "FINANCIAL_AUTHORIZATION"
                } else {
                    "AUTHORIZATION"
                };
                h.sim.authorization(
                    &token,
                    &h.card_token,
                    amount,
                    merchant_by_ref(merchant).unwrap().acceptor_id,
                    if result == "APPROVED" {
                        "APPROVED"
                    } else {
                        "DECLINED"
                    },
                    kind,
                );
            }
        } else if let Some(s) = step.get("event") {
            h.sim.add_event(
                &txn(s),
                &format!("{}-{}", name, s["id"].as_str().unwrap()),
                s["type"].as_str().unwrap(),
                s["amountCents"].as_u64().unwrap(),
                s["polarity"].as_str().unwrap_or("DEBIT"),
            );
        } else if let Some(s) = step.get("forcePost") {
            let token = txn(s);
            let acceptor = merchant_by_ref(s["merchant"].as_str().unwrap())
                .unwrap()
                .acceptor_id;
            h.sim.put_transaction(json!({"token": token, "card_token": h.card_token, "status": "SETTLED", "result": "APPROVED", "merchant": {"acceptor_id": acceptor, "descriptor": "FORCED", "mcc": "5999"}, "events": []}));
            h.sim.add_event(
                &token,
                &format!("{}-{}", name, s["id"].as_str().unwrap()),
                "CLEARING",
                s["amountCents"].as_u64().unwrap(),
                "DEBIT",
            );
        } else if let Some(s) = step.get("snapshot") {
            snapshots.insert(s["as"].as_str().unwrap().to_owned(), h.sim.webhook(&txn(s)));
        } else if let Some(s) = step.get("deliver") {
            let raw = match s["snapshot"].as_str() {
                Some(name) => snapshots[name].clone(),
                None => h.sim.webhook(&txn(s)),
            };
            let webhook = format!("{}-{}", name, s["webhookId"].as_str().unwrap());
            assert_eq!(h.deliver(&webhook, raw).await, 200, "{at}");
        } else if let Some(s) = step.get("dispute") {
            let body = json!({"event_type": "dispute.updated", "token": format!("dsp-{}", s["webhookId"]), "transaction_token": txn(s), "status": s["status"]});
            let webhook = format!("{}-{}", name, s["webhookId"].as_str().unwrap());
            assert_eq!(
                h.deliver(&webhook, serde_json::to_vec(&body).unwrap())
                    .await,
                200,
                "{at}"
            );
        } else if let Some(s) = step.get("expect") {
            let record = h.txn(&txn(s)).await;
            for (field, expected) in s.as_object().unwrap() {
                match field.as_str() {
                    "txn" => {}
                    "declineReason" => {
                        assert_eq!(&record["decision"]["reason"], expected, "{at}: {record}")
                    }
                    "flags" => {
                        for (flag, value) in expected.as_object().unwrap() {
                            assert_eq!(&record["flags"][flag], value, "{at}: {record}");
                        }
                    }
                    "needsReview" => assert_eq!(
                        record["needsReview"].as_bool().unwrap_or(false),
                        expected.as_bool().unwrap(),
                        "{at}: {record}"
                    ),
                    _ => assert_eq!(&record[field], expected, "{at}: {record}"),
                }
            }
        } else if let Some(s) = step.get("expectProgram") {
            for (name_, count) in s.as_object().unwrap() {
                assert_eq!(
                    h.program_count(name_) as u64,
                    count.as_u64().unwrap(),
                    "{at}: {:?}",
                    h.per.log()
                );
            }
        } else if step.get("reconcile").is_some() {
            let (status, _) = h
                .call("POST", "/internal/cron/cards/reconcile", Some(CRON), None)
                .await;
            assert_eq!(status, 200);
        } else {
            panic!("unknown step {step}");
        }
    }
    h.assert_no_pan().await;
}

macro_rules! scenario {
    ($name:ident) => {
        #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
        async fn $name() {
            run_scenario(include_str!(concat!(
                "../../../../scripts/card-sim/scenarios/",
                stringify!($name),
                ".json"
            )))
            .await;
        }
    };
}

scenario!(approve_decline_duplicate);
scenario!(lifecycle_partial_return);
scenario!(reorder);
scenario!(void_expiry_late);
scenario!(force_post);
scenario!(advice);
scenario!(single_message);
scenario!(capacity_close_and_replay);

// --------------------------------------------------------------- targeted

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn feature_flag_off_makes_every_card_route_404() {
    let store = StatusStore::in_memory();
    let state = BackendState::new(BackendConfig::from_env().unwrap(), store.clone()).unwrap();
    assert!(
        state.cards.is_none(),
        "CARDS_CONNECTOR_ENABLED defaults to off"
    );
    let token = "owner-session-flag-test-0123456789abcdef012345";
    store
        .put_auth(
            &format!("session:{}", hash(token)),
            json!({"wallet": "owner"}),
            now_ms() + 60_000,
        )
        .await
        .unwrap();
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
    let http = reqwest::Client::new();
    for (method, path, auth) in [
        ("POST", "/v1/cards/lithic/asa", false),
        ("POST", "/v1/cards/lithic/events", false),
        ("POST", "/internal/cron/cards/reconcile", false),
        ("POST", "/v1/cards/checkout/redeem", false),
        ("GET", "/v1/cards", true),
        ("POST", "/v1/cards/prepare", true),
        ("GET", &format!("/v1/cards/{}", "a".repeat(64)), true),
    ] {
        let mut request = http
            .request(method.parse().unwrap(), format!("{url}{path}"))
            .body("{}");
        if auth {
            request = request.bearer_auth(token);
        }
        assert_eq!(
            request.send().await.unwrap().status().as_u16(),
            404,
            "{method} {path}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn asa_signatures_are_required_and_missing_secrets_refuse_to_decide() {
    let h = Harness::new().await;
    let raw = serde_json::to_vec(&sim::asa_payload(
        "t-bad",
        &h.card_token,
        100,
        "DEMO-DATAAPI",
        "X",
        "5734",
        "AUTHORIZATION",
    ))
    .unwrap();
    let wrong = h
        .http
        .post(format!("{}/v1/cards/lithic/asa", h.url))
        .headers(sim::signed_headers(&[1u8; 24], "asa_bad", &raw))
        .body(raw.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status().as_u16(), 401);
    let unsigned = h
        .http
        .post(format!("{}/v1/cards/lithic/asa", h.url))
        .body(raw.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(unsigned.status().as_u16(), 401);
    let events = h
        .http
        .post(format!("{}/v1/cards/lithic/events", h.url))
        .headers(sim::signed_headers(&sim::ASA_KEY, "w", &raw))
        .body(raw.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(events.status().as_u16(), 400, "events use their own secret");
    assert_eq!(h.program_count("authorize"), 0);
    // A connector with no ASA secret never decides.
    let mut cfg = config(AttestationMode::Report);
    cfg.asa_verifier = Default::default();
    let cards = Arc::new(CardsConnector::new(
        cfg,
        LithicClient::new(&h.sim.url, "k".repeat(12), true).unwrap(),
        Per::Fake(h.per.clone()),
        crypto::test_crypto(),
        h.store.clone(),
    ));
    let response = asa::handle(
        cards,
        sim::signed_headers(&sim::ASA_KEY, "asa_x", &raw),
        &raw,
    )
    .await;
    assert_eq!(response.status().as_u16(), 503);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn balance_inquiry_never_leaks_budget_and_zero_dollar_needs_an_intent() {
    let h = Harness::new().await;
    let m = merchant_by_ref("demo-approved").unwrap();
    let raw = serde_json::to_vec(&sim::asa_payload(
        "bal-1",
        &h.card_token,
        0,
        m.acceptor_id,
        m.descriptor,
        "5734",
        "BALANCE_INQUIRY",
    ))
    .unwrap();
    let response = h
        .http
        .post(format!("{}/v1/cards/lithic/asa", h.url))
        .headers(sim::signed_headers(&sim::ASA_KEY, "asa_bal", &raw))
        .body(raw)
        .send()
        .await
        .unwrap();
    let body: Value = response.json().await.unwrap();
    assert_eq!(body, json!({"token": "bal-1", "result": "APPROVED"}));
    assert_eq!(
        h.asa("zero-1", 0, "demo-approved", "AUTHORIZATION").await.1,
        "UNAUTHORIZED_MERCHANT"
    );
    h.intent("demo-approved", "500").await;
    assert_eq!(
        h.asa("zero-2", 0, "demo-approved", "AUTHORIZATION").await.1,
        "APPROVED"
    );
    assert_eq!(
        h.program_count("authorize"),
        0,
        "$0 verification never reaches authorize"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn timeout_declines_and_the_late_reservation_is_resolved_only_by_reconciliation() {
    let h = Harness::new().await;
    h.intent("demo-approved", "2000").await;
    h.per.knobs.lock().unwrap().confirm_delay = Duration::from_millis(2_600);
    let started = std::time::Instant::now();
    let (_, result) = h
        .asa("slow-1", 2_000, "demo-approved", "AUTHORIZATION")
        .await;
    let elapsed = started.elapsed();
    assert_eq!(result, "SUSPECTED_FRAUD", "a missing confirmation declines");
    assert!(
        elapsed < Duration::from_millis(2_500),
        "answered inside the budget: {elapsed:?}"
    );
    h.per.knobs.lock().unwrap().confirm_delay = Duration::ZERO;
    let record = h.txn("slow-1").await;
    assert_eq!(record["state"], "ambiguous");
    // Never released on a timer: nothing changes without evidence.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(h.txn("slow-1").await["state"], "ambiguous");
    let reserved_before = h.per.with_card(&h.policy, |c| c.period.reserved);
    assert_eq!(reserved_before, 2_000, "the transaction did land on PER");
    // Issuer truth: Lithic declined (it got our decline).
    h.sim.authorization(
        "slow-1",
        &h.card_token,
        2_000,
        "DEMO-DATAAPI",
        "DECLINED",
        "AUTHORIZATION",
    );
    let (status, report) = h
        .call("POST", "/internal/cron/cards/reconcile", Some(CRON), None)
        .await;
    assert_eq!(status, 200, "{report}");
    let record = h.txn("slow-1").await;
    assert_eq!(record["state"], "reversed", "{record}");
    assert_eq!(
        h.per.with_card(&h.policy, |c| c.period.reserved),
        0,
        "the hold is released on PER"
    );
    assert_eq!(h.program_count("reverse"), 1);
    h.assert_no_pan().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dropped_transaction_is_ambiguous_then_declined_when_per_shows_nothing() {
    let h = Harness::new().await;
    h.intent("demo-approved", "1000").await;
    h.per.knobs.lock().unwrap().drop_next = 1;
    assert_eq!(
        h.asa("drop-1", 1_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "SUSPECTED_FRAUD"
    );
    assert_eq!(h.txn("drop-1").await["state"], "ambiguous");
    h.sim.authorization(
        "drop-1",
        &h.card_token,
        1_000,
        "DEMO-DATAAPI",
        "DECLINED",
        "AUTHORIZATION",
    );
    h.call("POST", "/internal/cron/cards/reconcile", Some(CRON), None)
        .await;
    assert_eq!(h.txn("drop-1").await["state"], "declined");
    // A capture against it later is an exception, not approved spend.
    h.sim
        .add_event("drop-1", "drop-1-c", "CLEARING", 1_000, "DEBIT");
    assert_eq!(h.deliver("w-drop", h.sim.webhook("drop-1")).await, 200);
    let record = h.txn("drop-1").await;
    assert_eq!(record["state"], "forced_capture", "{record}");
    assert_eq!(record["needsReview"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rpc_outage_declines_internally_without_touching_the_budget() {
    let h = Harness::new().await;
    h.intent("demo-approved", "1000").await;
    let mut cfg = config(AttestationMode::Report);
    cfg.asa_budget = Duration::from_millis(600);
    h.per.knobs.lock().unwrap().outage = true;
    // Confirmed on submit but the reservation can never be read back.
    let (_, result) = h
        .asa("outage-1", 1_000, "demo-approved", "AUTHORIZATION")
        .await;
    assert_eq!(result, "SUSPECTED_FRAUD");
    assert_eq!(h.txn("outage-1").await["state"], "ambiguous");
    h.per.knobs.lock().unwrap().outage = false;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn enforce_mode_without_verified_measurements_declines_everything() {
    let h = Harness::with(AttestationMode::Enforce, true).await;
    h.intent("demo-approved", "1000").await;
    assert_eq!(
        h.asa("enf-1", 1_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "SUSPECTED_FRAUD"
    );
    assert_eq!(h.program_count("authorize"), 0);
    h.cards
        .set_attestation(AttestationStatus {
            hardware: "verified",
            measurements: "match",
            mode: "enforce",
            checked_at_ms: now_ms(),
            observed: None,
            detail: None,
            tcb_status: Some("UpToDate".into()),
        })
        .await;
    h.intent("demo-approved", "1000").await;
    assert_eq!(
        h.asa("enf-2", 1_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconcile_closes_final_holds_and_dead_intents_the_event_path_missed() {
    let h = Harness::new().await;
    // 1. The event path closes a hold as soon as PER and the issuer are final.
    h.intent("demo-approved", "1000").await;
    assert_eq!(
        h.asa("cap-1", 1_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
    if h.sim.transaction("cap-1").is_none() {
        h.sim.authorization(
            "cap-1",
            &h.card_token,
            1_000,
            "DEMO-DATAAPI",
            "APPROVED",
            "AUTHORIZATION",
        );
    }
    h.sim
        .add_event("cap-1", "cap-1-c", "CLEARING", 1_000, "DEBIT");
    assert_eq!(h.deliver("cap-1-w", h.sim.webhook("cap-1")).await, 200);
    let record = h.txn("cap-1").await;
    assert_eq!(record["state"], "captured");
    assert_eq!(record["reservationClosed"], true, "{record}");

    // 2. A reversal the issuer still listed as PENDING when it was applied:
    //    PER is final, the row is not closable yet.
    h.intent("demo-approved", "500").await;
    assert_eq!(
        h.asa("cap-2", 500, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
    if h.sim.transaction("cap-2").is_none() {
        h.sim.authorization(
            "cap-2",
            &h.card_token,
            500,
            "DEMO-DATAAPI",
            "APPROVED",
            "AUTHORIZATION",
        );
    }
    h.sim
        .add_event("cap-2", "cap-2-v", "AUTHORIZATION_REVERSAL", 500, "DEBIT");
    let mut truth = h.sim.transaction("cap-2").unwrap();
    truth["status"] = json!("PENDING");
    h.sim.put_transaction(truth.clone());
    assert_eq!(h.deliver("cap-2-w", h.sim.webhook("cap-2")).await, 200);
    let record = h.txn("cap-2").await;
    assert_eq!(record["state"], "reversed");
    assert_ne!(record["reservationClosed"], true);
    let auth_id = program::auth_id_hash(h.cards.config.issuer_code, "cap-2");
    let reservation = program::reservation_pda(&h.policy, &auth_id);
    assert!(
        h.per
            .with_card(&h.policy, |c| c.reservations.contains_key(&reservation))
    );
    truth["status"] = json!("VOIDED");
    h.sim.put_transaction(truth);

    // 3. An intent opened and never used, now well past its expiry.
    h.intent_unredeemed("demo-approved", "700").await;
    h.per.with_card(&h.policy, |c| {
        for intent in c.intents.values_mut() {
            if intent.state == 0 {
                intent.expires_at = 1;
            }
        }
    });
    for row in h
        .store
        .scan_card_records(CardKind::CardEvents, "intent:", None, 50)
        .await
        .unwrap()
    {
        if row.record["state"] == "open" {
            let mut record = row.record.clone();
            record["expiresAtSecs"] = json!(1);
            h.store
                .put_card_record(
                    CardKind::CardEvents,
                    &row.key,
                    row.index.clone(),
                    record,
                    Some(row.rev()),
                    now_ms(),
                )
                .await
                .unwrap();
        }
    }

    let (status, _) = h
        .call("POST", "/internal/cron/cards/reconcile", Some(CRON), None)
        .await;
    assert_eq!(status, 200);
    assert!(
        h.per.with_card(&h.policy, |c| c.reservations.is_empty()),
        "the cron closed the reversed hold"
    );
    assert_eq!(h.txn("cap-2").await["reservationClosed"], true);
    assert!(
        h.per.with_card(&h.policy, |c| c.intents.is_empty()),
        "consumed and expired intents are all closed"
    );
    assert_eq!(h.per.with_card(&h.policy, |c| c.closed_count), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_token_whose_hold_was_closed_is_declined_even_if_axum_forgot_it() {
    // Axum's durable claim normally answers a replay. Here it is gone (a
    // fresh row), so only the program's AuthGuard ring stands between the
    // replayed token and a second hold.
    let h = Harness::new().await;
    let auth_id = program::auth_id_hash(h.cards.config.issuer_code, "ghost-1");
    h.per.with_card(&h.policy, |c| {
        c.closed_auth_ids.push_back(auth_id);
        c.closed_count += 1;
    });
    h.intent("demo-approved", "1000").await;
    let (_, result) = h
        .asa("ghost-1", 1_000, "demo-approved", "AUTHORIZATION")
        .await;
    assert_eq!(result, "SUSPECTED_FRAUD");
    let record = h.txn("ghost-1").await;
    assert_eq!(record["state"], "declined", "{record}");
    assert!(h.per.with_card(&h.policy, |c| c.reservations.is_empty()));
    assert!(
        h.per
            .with_card(&h.policy, |c| c.intents.values().all(|i| i.state == 0)),
        "the intent was not consumed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_cold_start_attestation_checks_run_once() {
    let h = Harness::with(AttestationMode::Enforce, true).await;
    let before = h.cards.attestation_checks();
    // Eight callers race on a cold status: one check runs, all get its result.
    let results = futures_join_all(
        (0..8)
            .map(|_| {
                let cards = h.cards.clone();
                tokio::spawn(async move { cards.refresh_attestation().await })
            })
            .collect(),
    )
    .await;
    assert_eq!(h.cards.attestation_checks() - before, 1);
    assert!(results.windows(2).all(|w| w[0] == w[1]));
    // Once that flight lands, a later caller starts a fresh check.
    h.cards.refresh_attestation().await;
    assert_eq!(h.cards.attestation_checks() - before, 2);
    // A caller that gives up early never cancels the shared check.
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(5),
        h.cards.refresh_attestation(),
    )
    .await;
    h.cards.refresh_attestation().await;
    assert_eq!(h.cards.attestation_checks() - before, 3);
    // A check that panics still frees the slot: the next caller runs a new one.
    h.cards
        .attestation_panics
        .store(true, std::sync::atomic::Ordering::SeqCst);
    h.cards.refresh_attestation().await;
    h.cards
        .attestation_panics
        .store(false, std::sync::atomic::Ordering::SeqCst);
    h.cards.refresh_attestation().await;
    assert_eq!(h.cards.attestation_checks() - before, 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn checkout_steps_land_attestation_before_the_authorization() {
    // Cold instance: no attestation yet. Issuing the intent and redeeming it
    // run the check off the ASA's deadline, so the purchase that follows is
    // approved instead of declining while a check is still in flight.
    let h = Harness::with(AttestationMode::Enforce, true).await;
    *h.cards.attestation_next.lock().unwrap() = Some(AttestationStatus {
        hardware: "verified",
        measurements: "match",
        mode: "enforce",
        checked_at_ms: now_ms(),
        observed: None,
        detail: None,
        tcb_status: Some("UpToDate".into()),
    });
    assert!(
        !h.cards
            .attestation()
            .await
            .permits_approval(AttestationMode::Enforce, now_ms())
    );
    let before = h.cards.attestation_checks();
    let (status, cap) = h.intent_unredeemed("demo-approved", "100").await;
    assert_eq!(status, 200, "{cap}");
    assert!(
        h.cards.attestation_checks() > before,
        "intent issue warmed attestation"
    );
    let (status, run) = h
        .call(
            "POST",
            "/v1/cards/checkout/redeem",
            Some(RUNNER),
            Some(json!({"capability": cap["capability"]})),
        )
        .await;
    assert_eq!(status, 200, "{run}");
    let token = run["lithicToken"].as_str().unwrap().to_owned();
    assert_eq!(h.sim.state.lock().unwrap().asa_results[&token], "APPROVED");
}

async fn futures_join_all<T: Send + 'static>(handles: Vec<tokio::task::JoinHandle<T>>) -> Vec<T> {
    let mut out = Vec::with_capacity(handles.len());
    for handle in handles {
        out.push(handle.await.unwrap());
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn freeze_pauses_the_issuer_card_and_new_authorizations_decline() {
    let h = Harness::new().await;
    h.intent("demo-approved", "1000").await;
    let (status, result) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/freeze", h.card_id),
            Some(json!({"clientOperationId": "freeze-0001", "reason": "lost trust"})),
        )
        .await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["onChain"], "submitted");
    assert_eq!(result["issuer"], "pending_issuer_confirmation");
    assert_eq!(h.sim.card_state(&h.card_token).state, "PAUSED");
    assert!(h.per.with_card(&h.policy, |c| c.policy.frozen));
    for (method, path, body) in h.sim.calls() {
        if method == "PATCH" && path.starts_with("/v1/cards/") {
            assert_ne!(
                body["spend_limit"],
                json!(0),
                "a zero spend limit means unlimited at Lithic"
            );
            assert_ne!(body["state"], json!("CLOSED"));
        }
    }
    let (_, view) = h
        .owner("GET", &format!("/v1/cards/{}", h.card_id), None)
        .await;
    assert_eq!(
        view["freeze"],
        json!({"onChain": true, "issuer": "confirmed"})
    );
    assert_eq!(view["issuerState"], "PAUSED");
    // Same clientOperationId: same result, no second freeze.
    let (_, again) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/freeze", h.card_id),
            Some(json!({"clientOperationId": "freeze-0001", "reason": "lost trust"})),
        )
        .await;
    assert_eq!(again["freezeOperationId"], result["freezeOperationId"]);
    assert_eq!(h.program_count("freeze"), 1);
    // An intent opened before the freeze no longer authorizes.
    assert_eq!(
        h.asa("frozen-1", 1_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "CARD_PAUSED"
    );
    assert_eq!(h.txn("frozen-1").await["decision"]["reason"], "frozen");
    // And new checkouts are refused on PER.
    let (status, body) = h.intent("demo-approved", "500").await;
    assert_eq!(status, 409, "{body}");
    // card.updated acknowledgement path.
    let ack = json!({"event_type": "card.updated", "card_token": h.card_token, "state": "PAUSED", "previous_fields": {"state": "OPEN"}});
    assert_eq!(
        h.deliver("w-card-1", serde_json::to_vec(&ack).unwrap())
            .await,
        200
    );
    // Reopening needs the owner's on-chain unfreeze first.
    let (status, body) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/unfreeze-mirror", h.card_id),
            Some(json!({"clientOperationId": "unfreeze-0001", "expectedPolicyVersion": 1})),
        )
        .await;
    assert_eq!(status, 409, "{body}");
    h.per.with_card(&h.policy, |c| c.policy.frozen = false);
    let (status, body) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/unfreeze-mirror", h.card_id),
            Some(json!({"clientOperationId": "unfreeze-0002", "expectedPolicyVersion": 1})),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(h.sim.card_state(&h.card_token).state, "OPEN");
    h.assert_no_pan().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn activation_mirrors_limits_before_opening_and_prepare_is_idempotent() {
    let h = Harness::with(AttestationMode::Report, false).await;
    assert_eq!(
        h.sim.card_state(&h.card_token).state,
        "PAUSED",
        "cards are created paused"
    );
    let (status, again) = h
        .owner(
            "POST",
            "/v1/cards/prepare",
            Some(json!({"clientOperationId": "prepare-0001", "label": "Data API card"})),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(
        again["cardId"],
        h.card_id.as_str(),
        "same operation, same card"
    );
    let creates = h
        .sim
        .calls()
        .iter()
        .filter(|(m, p, _)| m == "POST" && p == "/v1/cards")
        .count();
    assert_eq!(creates, 1);
    let (status, conflict) = h
        .owner(
            "POST",
            "/v1/cards/prepare",
            Some(json!({"clientOperationId": "prepare-0001", "label": "Other"})),
        )
        .await;
    assert_eq!(status, 409, "{conflict}");
    // Unsigned owner transactions decode and name the owner as fee payer.
    use base64::Engine;
    let tx: solana_transaction::versioned::VersionedTransaction = wincode::deserialize(
        &base64::engine::general_purpose::STANDARD
            .decode(again["initTx"].as_str().unwrap())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(tx.message.static_account_keys()[0].to_string(), h.owner);
    assert_eq!(again["authorizer"], h.per.authorizer().to_string());
    // Wrong expected version: refused, nothing opened.
    let (status, _) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/activate", h.card_id),
            Some(json!({"clientOperationId": "activate-0009", "expectedPolicyVersion": 2})),
        )
        .await;
    assert_eq!(status, 409);
    assert_eq!(h.sim.card_state(&h.card_token).state, "PAUSED");
    let (status, view) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/activate", h.card_id),
            Some(json!({"clientOperationId": "activate-0001", "expectedPolicyVersion": 1})),
        )
        .await;
    assert_eq!(status, 200, "{view}");
    let card = h.sim.card_state(&h.card_token);
    assert_eq!((card.state.as_str(), card.spend_limit), ("OPEN", 4_000));
    let rules = h.sim.state.lock().unwrap().rules.clone();
    assert_eq!(rules[0]["type"], "MERCHANT_LOCK");
    assert_eq!(
        rules[0]["parameters"]["merchants"][0]["merchant_id"],
        "DEMO-DATAAPI"
    );
    assert_eq!(view["mirror"]["state"], "acknowledged");
    assert_eq!(view["mirror"]["policyVersionMirrored"], 1);
    assert!(
        view.get("budgetCents").is_none() && !view.to_string().contains("4000"),
        "card views carry no policy values"
    );
    // The open happened after the mirror calls.
    let calls = h.sim.calls();
    let open_at = calls
        .iter()
        .position(|(_, _, b)| b["state"] == "OPEN")
        .unwrap();
    let limit_at = calls
        .iter()
        .position(|(_, _, b)| b["spend_limit"] == 4_000)
        .unwrap();
    let rule_at = calls
        .iter()
        .position(|(_, p, _)| p == "/v2/auth_rules")
        .unwrap();
    assert!(limit_at < open_at && rule_at < open_at);
    assert!(
        h.program_count("checkpoint") == 1,
        "activation schedules a commitment checkpoint"
    );
    h.assert_no_pan().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn checkout_capabilities_are_scoped_single_use_and_merchant_bound() {
    let h = Harness::new().await;
    // Owner sessions have no agent identity to bind.
    let (status, _) = h.owner("POST", &format!("/v1/cards/{}/checkout-intents", h.card_id), Some(json!({"clientOperationId": "checkout-owner", "merchantRef": "demo-approved", "amountCents": "2000", "currency": "USD"}))).await;
    assert_eq!(status, 403);
    let (status, cap) = h.intent_unredeemed("demo-approved", "2000").await;
    assert_eq!(status, 200, "{cap}");
    let capability = cap["capability"].as_str().unwrap().to_owned();
    assert!(checkout::is_capability(&capability));
    assert_eq!(cap["status"], "ready");
    assert_eq!(cap["merchant"]["displayName"], "Data API credits");
    // Unapproved merchant: refused on PER, no capability.
    let (status, refused) = h.intent_unredeemed("demo-unapproved", "1000").await;
    assert_eq!(status, 409, "{refused}");
    assert_eq!(refused["detail"], "MerchantNotAllowed");
    // The runner needs its own secret.
    let (status, _) = h
        .call(
            "POST",
            "/v1/cards/checkout/redeem",
            Some(AGENT_TOKEN),
            Some(json!({"capability": capability})),
        )
        .await;
    assert_eq!(status, 401);
    let (status, run) = h
        .call(
            "POST",
            "/v1/cards/checkout/redeem",
            Some(RUNNER),
            Some(json!({"capability": capability})),
        )
        .await;
    assert_eq!(status, 200, "{run}");
    let token = run["lithicToken"].as_str().unwrap().to_owned();
    assert_eq!(
        h.sim.state.lock().unwrap().asa_results[&token],
        "APPROVED",
        "simulate/authorize went through our ASA"
    );
    assert_eq!(h.txn(&token).await["state"], "reserved");
    // The consumed intent is closed on PER after the reply, returning its rent.
    for _ in 0..50 {
        if h.program_count("close_checkout_intent") > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(
        h.program_count("close_checkout_intent"),
        1,
        "consumed intent closed"
    );
    let (status, used) = h
        .call(
            "POST",
            "/v1/cards/checkout/redeem",
            Some(RUNNER),
            Some(json!({"capability": capability})),
        )
        .await;
    assert_eq!(
        (status, used["code"].as_str()),
        (409, Some("capability_used"))
    );
    // A capability used at another shop fails and is dead afterwards.
    let (_, other) = h.intent_unredeemed("demo-approved", "1000").await;
    let other_cap = other["capability"].as_str().unwrap().to_owned();
    let (status, run) = h
        .call(
            "POST",
            "/v1/cards/checkout/redeem",
            Some(RUNNER),
            Some(json!({"capability": other_cap, "merchantRef": "demo-unapproved"})),
        )
        .await;
    assert_eq!(status, 200, "{run}");
    let token = run["lithicToken"].as_str().unwrap().to_owned();
    assert_ne!(h.sim.state.lock().unwrap().asa_results[&token], "APPROVED");
    let (status, _) = h
        .call(
            "POST",
            "/v1/cards/checkout/redeem",
            Some(RUNNER),
            Some(json!({"capability": other_cap})),
        )
        .await;
    assert_eq!(status, 409);
    // The PAN was fetched only for the simulate calls and never surfaced.
    for (_, path, body) in h.sim.calls() {
        if path == "/v1/simulate/authorize" {
            assert_eq!(body["pan"], "[redacted-by-sim]");
        }
    }
    // Same clientOperationId: same capability.
    let n = h.asa_seq.load(std::sync::atomic::Ordering::SeqCst);
    let body = json!({"clientOperationId": "checkout-repeat", "merchantRef": "demo-approved", "amountCents": "700", "currency": "USD"});
    let (_, first) = h
        .call(
            "POST",
            &format!("/v1/cards/{}/checkout-intents", h.card_id),
            Some(AGENT_TOKEN),
            Some(body.clone()),
        )
        .await;
    let (_, second) = h
        .call(
            "POST",
            &format!("/v1/cards/{}/checkout-intents", h.card_id),
            Some(AGENT_TOKEN),
            Some(body),
        )
        .await;
    assert_eq!(first["capability"], second["capability"]);
    let _ = n;
    h.assert_no_pan().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scopes_owners_and_agents_are_enforced() {
    let h = Harness::new().await;
    let card = format!("/v1/cards/{}", h.card_id);
    // Agent: reads its card's activity, never owner routes.
    assert_eq!(
        h.call("GET", &format!("{card}/activity"), Some(AGENT_TOKEN), None)
            .await
            .0,
        200
    );
    for (method, path, body) in [
        ("GET", card.clone(), None),
        (
            "POST",
            format!("{card}/freeze"),
            Some(json!({"clientOperationId": "freeze-agent", "reason": "x"})),
        ),
        ("POST", format!("{card}/embed-session"), Some(json!({}))),
        (
            "POST",
            format!("{card}/activate"),
            Some(json!({"clientOperationId": "activate-agent", "expectedPolicyVersion": 1})),
        ),
        (
            "POST",
            "/v1/cards/prepare".to_owned(),
            Some(json!({"clientOperationId": "prepare-agent", "label": "x"})),
        ),
    ] {
        assert_eq!(
            h.call(method, &path, Some(AGENT_TOKEN), body).await.0,
            403,
            "{method} {path}"
        );
    }
    // Another owner cannot see the card at all.
    assert_eq!(h.call("GET", &card, Some(OTHER_TOKEN), None).await.0, 404);
    assert_eq!(
        h.call("GET", &format!("{card}/activity"), Some(OTHER_TOKEN), None)
            .await
            .0,
        404
    );
    // Unknown fields are refused (closed schemas).
    let (status, _) = h
        .owner(
            "POST",
            &format!("{card}/freeze"),
            Some(json!({"clientOperationId": "freeze-0002", "reason": "x", "unfreeze": true})),
        )
        .await;
    assert_eq!(status, 400);
    // Embed: owner only, a Lithic-hosted URL, no card data in the body.
    let (status, embed) = h
        .owner("POST", &format!("{card}/embed-session"), Some(json!({})))
        .await;
    assert_eq!(status, 200);
    assert!(
        embed["embedUrl"]
            .as_str()
            .unwrap()
            .contains("/v1/embed?session=")
    );
    // Cron is bearer-protected.
    assert_eq!(
        h.call("POST", "/internal/cron/cards/reconcile", None, None)
            .await
            .0,
        401
    );
    assert_eq!(
        h.call(
            "GET",
            "/internal/cron/cards/reconcile",
            Some("wrong-secret-0123456789"),
            None
        )
        .await
        .0,
        401
    );
    assert_eq!(
        h.call("GET", "/internal/cron/cards/reconcile", Some(CRON), None)
            .await
            .0,
        200
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn activity_projects_distinct_lifecycle_rows_without_card_data() {
    let h = Harness::new().await;
    h.intent("demo-approved", "2000").await;
    h.asa("act-1", 2_000, "demo-approved", "AUTHORIZATION")
        .await;
    h.sim.authorization(
        "act-1",
        &h.card_token,
        2_000,
        "DEMO-DATAAPI",
        "APPROVED",
        "AUTHORIZATION",
    );
    h.sim
        .add_event("act-1", "act-1-c", "CLEARING", 1_200, "DEBIT");
    h.deliver("w-act-1", h.sim.webhook("act-1")).await;
    h.asa("act-2", 900, "demo-unapproved", "AUTHORIZATION")
        .await;
    let (status, page) = h
        .owner(
            "GET",
            &format!("/v1/cards/{}/activity?limit=10", h.card_id),
            None,
        )
        .await;
    assert_eq!(status, 200, "{page}");
    let rows = page["rows"].as_array().unwrap();
    let capture = rows.iter().find(|r| r["rowId"] == "asa:act-1").unwrap();
    assert_eq!(
        (
            capture["kind"].as_str(),
            capture["lifecycle"].as_str(),
            capture["amountCents"].as_str()
        ),
        (Some("capture"), Some("partially_captured"), Some("1200"))
    );
    assert_eq!(capture["merchant"]["displayName"], "Data API credits");
    let declined = rows.iter().find(|r| r["rowId"] == "asa:act-2").unwrap();
    assert_eq!(
        (
            declined["lifecycle"].as_str(),
            declined["declineReason"].as_str()
        ),
        (Some("declined"), Some("intent_missing"))
    );
    assert!(rows.iter().any(|r| r["kind"] == "policy_change"));
    // Agent view omits owner-only money detail.
    let (_, agent) = h
        .call(
            "GET",
            &format!("/v1/cards/{}/activity", h.card_id),
            Some(AGENT_TOKEN),
            None,
        )
        .await;
    assert!(
        agent["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r.get("reservedCents").is_none())
    );
    // Pagination by cursor.
    let (_, first) = h
        .owner(
            "GET",
            &format!("/v1/cards/{}/activity?limit=1", h.card_id),
            None,
        )
        .await;
    let cursor = first["nextCursor"].as_str().unwrap();
    let (_, second) = h
        .owner(
            "GET",
            &format!("/v1/cards/{}/activity?limit=1&cursor={cursor}", h.card_id),
            None,
        )
        .await;
    assert_ne!(first["rows"][0]["rowId"], second["rows"][0]["rowId"]);
    assert_eq!(
        h.owner(
            "GET",
            &format!("/v1/cards/{}/activity?cursor=bad", h.card_id),
            None
        )
        .await
        .0,
        400
    );
    h.assert_no_pan().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn conflicting_duplicate_under_one_token_is_declined_and_flagged() {
    let h = Harness::new().await;
    h.intent("demo-approved", "2000").await;
    assert_eq!(
        h.asa("dup-x", 2_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
    assert_eq!(
        h.asa("dup-x", 1_500, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "SUSPECTED_FRAUD"
    );
    let record = h.txn("dup-x").await;
    assert_eq!(record["exception"], "conflicting_duplicate");
    assert_eq!(record["state"], "reserved", "the first decision stands");
    assert_eq!(h.program_count("authorize"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_duplicate_asa_requests_get_one_decision() {
    let h = Arc::new(Harness::new().await);
    h.intent("demo-approved", "2000").await;
    h.per.knobs.lock().unwrap().confirm_delay = Duration::from_millis(300);
    let (a, b) = tokio::join!(
        h.asa("race-1", 2_000, "demo-approved", "AUTHORIZATION"),
        h.asa("race-1", 2_000, "demo-approved", "AUTHORIZATION")
    );
    assert_eq!((a.1.as_str(), b.1.as_str()), ("APPROVED", "APPROVED"));
    assert_eq!(
        h.program_count("authorize"),
        1,
        "exactly one authorize reached PER"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconciliation_finds_transactions_whose_webhooks_never_arrived() {
    let h = Harness::new().await;
    h.intent("demo-approved", "1500").await;
    assert_eq!(
        h.asa("lost-1", 1_500, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
    h.sim.authorization(
        "lost-1",
        &h.card_token,
        1_500,
        "DEMO-DATAAPI",
        "APPROVED",
        "AUTHORIZATION",
    );
    h.sim
        .add_event("lost-1", "lost-1-c", "CLEARING", 1_500, "DEBIT");
    // A force post nobody told us about.
    h.sim.put_transaction(json!({"token": "lost-2", "card_token": h.card_token, "status": "SETTLED", "result": "APPROVED", "merchant": {"acceptor_id": "X"}, "events": []}));
    h.sim
        .add_event("lost-2", "lost-2-c", "CLEARING", 300, "DEBIT");
    let (status, report) = h
        .call("GET", "/internal/cron/cards/reconcile", Some(CRON), None)
        .await;
    assert_eq!(status, 200, "{report}");
    assert_eq!(h.txn("lost-1").await["state"], "captured");
    assert_eq!(h.txn("lost-2").await["state"], "forced_capture");
    assert!(report["unpairedFlagged"].as_u64().unwrap() >= 1, "{report}");
    // Idempotent: a second pass changes nothing on PER.
    let captures = h.program_count("capture");
    h.call("GET", "/internal/cron/cards/reconcile", Some(CRON), None)
        .await;
    assert_eq!(h.program_count("capture"), captures);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn convex_records_hold_only_envelopes_for_sensitive_fields() {
    let h = Harness::new().await;
    h.intent("demo-approved", "2000").await;
    h.asa("env-1", 2_000, "demo-approved", "AUTHORIZATION")
        .await;
    // An inbox row and a card.updated event too (Convex enforces the same rule).
    h.sim.authorization(
        "env-1",
        &h.card_token,
        2_000,
        "DEMO-DATAAPI",
        "APPROVED",
        "AUTHORIZATION",
    );
    assert_eq!(h.deliver("w-env-1", h.sim.webhook("env-1")).await, 200);
    let ack = json!({"event_type": "card.updated", "card_token": h.card_token, "state": "OPEN", "previous_fields": {}});
    assert_eq!(
        h.deliver("w-env-2", serde_json::to_vec(&ack).unwrap())
            .await,
        200
    );
    for row in h.store.all_card_records().await {
        for field in [
            "issuer",
            "label",
            "provider",
            "raw",
            "secret",
            "snapshot",
            "masterSalt",
        ] {
            let value = &row.record[field];
            if !value.is_null() {
                assert_eq!(
                    value["alg"], "A256GCM",
                    "{} {field} must be encrypted",
                    row.key
                );
            }
        }
        if let Some(owner) = &row.index.owner {
            assert!(!owner.contains("4111"));
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issuer_side_declines_and_sandbox_return_amounts_project_correctly() {
    let h = Harness::new().await;
    // Lithic declined before ASA (paused card): a decline, not an exception.
    h.sim.put_transaction(json!({"token": "paused-1", "card_token": h.card_token, "status": "DECLINED", "result": "CARD_PAUSED", "merchant": {"acceptor_id": "DEMO-DATAAPI"},
        "events": [{"token": "paused-1-a", "type": "AUTHORIZATION", "amount": 500, "amounts": {"cardholder": {"amount": 500}}, "result": "CARD_PAUSED", "created": "2026-10-04T00:00:01Z"}]}));
    assert_eq!(h.deliver("w-paused", h.sim.webhook("paused-1")).await, 200);
    let record = h.txn("paused-1").await;
    assert_eq!(
        (
            record["state"].as_str(),
            record["decision"]["reason"].as_str()
        ),
        (Some("declined"), Some("frozen")),
        "{record}"
    );
    // Sandbox RETURN: cardholder amount 0, event amount -500.
    h.sim.put_transaction(json!({"token": "ret-1", "card_token": h.card_token, "status": "SETTLED", "result": "APPROVED", "merchant": {"acceptor_id": "DEMO-DATAAPI"},
        "events": [{"token": "ret-1-r", "type": "RETURN", "amount": -500, "amounts": {"cardholder": {"amount": 0}, "settlement": {"amount": 500}}, "result": "APPROVED", "effective_polarity": "CREDIT", "created": "2026-10-04T00:00:01Z"}]}));
    assert_eq!(h.deliver("w-ret", h.sim.webhook("ret-1")).await, 200);
    let record = h.txn("ret-1").await;
    assert_eq!(
        (record["state"].as_str(), record["refundedCents"].as_str()),
        (Some("refunded"), Some("500")),
        "{record}"
    );
    assert_eq!(h.per.with_card(&h.policy, |c| c.period.refunded), 500);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issuer_truth_behind_the_webhook_is_retried_not_marked_applied() {
    let h = Harness::new().await;
    h.intent("demo-approved", "1000").await;
    assert_eq!(
        h.asa("lag-1", 1_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
    h.sim.authorization(
        "lag-1",
        &h.card_token,
        1_000,
        "DEMO-DATAAPI",
        "APPROVED",
        "AUTHORIZATION",
    );
    // The webhook lists a reversal the issuer API does not show yet.
    let mut body: Value = serde_json::from_slice(&h.sim.webhook("lag-1")).unwrap();
    body["events"].as_array_mut().unwrap().push(json!({"token": "lag-1-v", "type": "AUTHORIZATION_REVERSAL", "amount": 1000, "result": "APPROVED", "created": "2026-10-04T00:00:09Z"}));
    assert_eq!(
        h.deliver("w-lag", serde_json::to_vec(&body).unwrap()).await,
        200
    );
    assert_eq!(h.txn("lag-1").await["state"], "reserved");
    let pending = events::inbox(&h.cards).pending(10).await.unwrap();
    assert_eq!(pending.len(), 1, "left for the cron job");
    // Truth catches up; the cron drains the inbox.
    h.sim
        .add_event("lag-1", "lag-1-v", "AUTHORIZATION_REVERSAL", 1_000, "DEBIT");
    h.call("POST", "/internal/cron/cards/reconcile", Some(CRON), None)
        .await;
    assert_eq!(h.txn("lag-1").await["state"], "reversed");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn zero_dollar_verification_leaves_the_intent_for_the_real_purchase() {
    let h = Harness::new().await;
    h.intent("demo-approved", "2000").await;
    assert_eq!(
        h.asa("verify-0", 0, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
    assert_eq!(
        h.asa("verify-1", 2_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
    // The issuer's approved $0 AUTHORIZATION event is not an exception.
    h.sim.authorization(
        "verify-0",
        &h.card_token,
        0,
        "DEMO-DATAAPI",
        "APPROVED",
        "AUTHORIZATION",
    );
    assert_eq!(
        h.deliver("w-verify-0", h.sim.webhook("verify-0")).await,
        200
    );
    let record = h.txn("verify-0").await;
    assert_eq!(record["state"], "account_verification");
    assert!(record["needsReview"].is_null(), "{record}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_freeze_retried_with_the_same_operation_finishes_an_unconfirmed_freeze() {
    let h = Harness::new().await;
    h.per.knobs.lock().unwrap().drop_next = 1;
    let body = json!({"clientOperationId": "freeze-retry-1", "reason": "suspicious"});
    let (status, _) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/freeze", h.card_id),
            Some(body.clone()),
        )
        .await;
    assert_eq!(status, 200);
    assert!(
        !h.per.with_card(&h.policy, |c| c.policy.frozen),
        "first PER freeze vanished"
    );
    let (status, _) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/freeze", h.card_id),
            Some(body.clone()),
        )
        .await;
    assert_eq!(status, 200);
    assert!(
        h.per.with_card(&h.policy, |c| c.policy.frozen),
        "the retry completed the freeze"
    );
    // Fully confirmed now: a third call does nothing new.
    let before = h.program_count("freeze");
    h.owner(
        "POST",
        &format!("/v1/cards/{}/freeze", h.card_id),
        Some(body),
    )
    .await;
    assert_eq!(h.program_count("freeze"), before);
}

// ------------------------------------------------- review fixes (2026-10-04)

impl Harness {
    /// Sends an ASA body as-is (signed), for malformed or drifted payloads.
    async fn asa_body(&self, txn: &str, body: &Value) -> String {
        let raw = serde_json::to_vec(body).unwrap();
        let response = self
            .http
            .post(format!("{}/v1/cards/lithic/asa", self.url))
            .headers(sim::signed_headers(
                &sim::ASA_KEY,
                &format!("asa_{txn}"),
                &raw,
            ))
            .body(raw)
            .send()
            .await
            .unwrap();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        body["result"].as_str().unwrap_or("").to_owned()
    }

    fn payload(&self, txn: &str, amount: u64) -> Value {
        let m = merchant_by_ref("demo-approved").unwrap();
        sim::asa_payload(
            txn,
            &self.card_token,
            amount,
            m.acceptor_id,
            m.descriptor,
            &m.mcc.to_string(),
            "AUTHORIZATION",
        )
    }
}

/// Review F1: an amount, currency or cash amount that doesn't parse
/// declines; it never becomes a $0 account verification.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_asa_amount_that_does_not_parse_declines_never_zero() {
    let h = Harness::new().await;
    h.intent("demo-approved", "2000").await;
    let cases: Vec<(&str, Box<dyn Fn(&mut Value)>)> = vec![
        (
            "string",
            Box::new(|b| b["amounts"]["cardholder"]["amount"] = json!("2000")),
        ),
        (
            "negative",
            Box::new(|b| b["amounts"]["cardholder"]["amount"] = json!(-2000)),
        ),
        (
            "fraction",
            Box::new(|b| b["amounts"]["cardholder"]["amount"] = json!(20.5)),
        ),
        (
            "missing",
            Box::new(|b| {
                b["amounts"]["cardholder"]
                    .as_object_mut()
                    .unwrap()
                    .remove("amount");
            }),
        ),
        (
            "no-currency",
            Box::new(|b| {
                b["amounts"]["cardholder"]
                    .as_object_mut()
                    .unwrap()
                    .remove("currency");
            }),
        ),
        (
            "bad-hold",
            Box::new(|b| b["amounts"]["hold"] = json!({"amount": "9000"})),
        ),
        (
            "no-cash",
            Box::new(|b| {
                b.as_object_mut().unwrap().remove("cash_amount");
            }),
        ),
    ];
    for (name, mutate) in cases {
        let txn = format!("drift-{name}");
        let mut body = h.payload(&txn, 2_000);
        mutate(&mut body);
        assert!(super::asa::parse(&body).is_none(), "{name} parses");
        assert_eq!(h.asa_body(&txn, &body).await, "SUSPECTED_FRAUD", "{name}");
        assert!(
            h.txn(&txn).await.is_null(),
            "{name}: no row, nothing approved"
        );
    }
    assert_eq!(h.program_count("authorize"), 0);
    // A top-level integer amount is still read when `amounts` lacks one.
    let mut body = h.payload("top-level", 2_000);
    body["amounts"]["cardholder"]
        .as_object_mut()
        .unwrap()
        .remove("amount");
    body["amount"] = json!(2_000);
    assert_eq!(super::asa::parse(&body).unwrap().amount_cents, 2_000);
}

/// Review X1: only a plain AUTHORIZATION with an explicit $0 verifies, once
/// per intent.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_zero_dollar_verification_happens_once_per_intent() {
    let h = Harness::new().await;
    h.intent("demo-approved", "2000").await;
    assert_eq!(
        h.asa("zero-1", 0, "demo-approved", "AUTHORIZATION").await.1,
        "APPROVED"
    );
    assert_eq!(
        h.asa("zero-2", 0, "demo-approved", "AUTHORIZATION").await.1,
        "UNAUTHORIZED_MERCHANT",
        "a second $0 on the same intent is a probe"
    );
    assert_eq!(
        h.asa("zero-3", 0, "demo-approved", "FINANCIAL_AUTHORIZATION")
            .await
            .1,
        "UNAUTHORIZED_MERCHANT"
    );
    // The intent is still there for the real purchase.
    assert_eq!(
        h.asa("real-1", 2_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
}

/// Review X7: an intent the runner never redeemed can't approve a charge.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_unredeemed_checkout_intent_never_approves() {
    let h = Harness::new().await;
    let (status, _) = h.intent_unredeemed("demo-approved", "2000").await;
    assert_eq!(status, 200);
    assert_eq!(
        h.asa("orphan-1", 2_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "UNAUTHORIZED_MERCHANT"
    );
    assert_eq!(h.program_count("authorize"), 0);
}

/// Review X1 (compound): drifted ASAs decline, and clearings with no hold are
/// billed only while they fit the budget; the rest goes to review. The owner
/// never owes more than budget + fee(budget) for the period.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn clearings_without_a_hold_never_bill_past_the_budget() {
    let h = Harness::new().await; // budget 5000, max purchase 4000, 50 bps
    h.intent("demo-approved", "4000").await;
    for i in 0..3 {
        let token = format!("drift-{i}");
        let mut body = h.payload(&token, 4_000);
        body["amounts"]["cardholder"]["amount"] = json!("4000");
        assert_eq!(h.asa_body(&token, &body).await, "SUSPECTED_FRAUD");
        // Issuer truth anyway: the network cleared 40.00 with no hold.
        h.sim.authorization(
            &token,
            &h.card_token,
            4_000,
            "DEMO-DATAAPI",
            "APPROVED",
            "AUTHORIZATION",
        );
        h.sim
            .add_event(&token, &format!("{token}-c"), "CLEARING", 4_000, "DEBIT");
        assert_eq!(
            h.deliver(&format!("w-{token}"), h.sim.webhook(&token))
                .await,
            200
        );
    }
    assert_eq!(h.program_count("authorize"), 0);
    let (captured, outstanding, budget) = h.per.with_card(&h.policy, |c| {
        (c.period.captured, c.policy.outstanding, c.policy.budget)
    });
    assert!(captured <= budget, "captured {captured} > budget {budget}");
    assert!(outstanding <= budget + statements::fee_cents(budget, 50));
    let mut over_budget = 0;
    for i in 0..3 {
        let row = h.txn(&format!("drift-{i}")).await;
        assert_eq!(row["needsReview"], true, "{row}");
        if row["exception"] == "over_budget" {
            over_budget += 1;
        }
    }
    assert_eq!(over_budget, 2, "one forced post fits, two are review only");
}

/// Review F2: a refund on a hold never returns more than it captured, even
/// once the Reservation is closed (Axum applies the cap from its row).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refunds_past_what_a_hold_captured_go_to_review() {
    let h = Harness::new().await;
    h.intent("demo-approved", "1000").await;
    assert_eq!(
        h.asa("rf-1", 1_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
    h.sim.authorization(
        "rf-1",
        &h.card_token,
        1_000,
        "DEMO-DATAAPI",
        "APPROVED",
        "AUTHORIZATION",
    );
    h.sim
        .add_event("rf-1", "rf-1-c", "CLEARING", 1_000, "DEBIT");
    h.sim.add_event("rf-1", "rf-1-r1", "RETURN", 600, "CREDIT");
    h.sim.add_event("rf-1", "rf-1-r2", "RETURN", 600, "CREDIT");
    assert_eq!(h.deliver("w-rf-1", h.sim.webhook("rf-1")).await, 200);
    let row = h.txn("rf-1").await;
    assert_eq!(row["refundedCents"], "600", "{row}");
    assert_eq!(row["exception"], "refund_over_capture", "{row}");
    assert_eq!(h.program_count("refund"), 1);
    // 1000 + 5 billed, 600 + 3 credited: 402 left.
    assert_eq!(h.per.with_card(&h.policy, |c| c.policy.outstanding), 402);
}

/// Review F3: an event whose transaction landed but was never confirmed is
/// looked up by signature on the retry, not sent again, so dedupe never
/// depends on the program's event ring still holding its id.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_landed_but_unconfirmed_event_is_looked_up_not_resent() {
    let h = Harness::new().await;
    h.intent("demo-approved", "1000").await;
    assert_eq!(
        h.asa("lu-1", 1_000, "demo-approved", "AUTHORIZATION")
            .await
            .1,
        "APPROVED"
    );
    h.sim.authorization(
        "lu-1",
        &h.card_token,
        1_000,
        "DEMO-DATAAPI",
        "APPROVED",
        "AUTHORIZATION",
    );
    h.sim
        .add_event("lu-1", "lu-1-c", "CLEARING", 1_000, "DEBIT");
    // The capture lands after the 6 s deadline: Axum sees Unknown.
    h.per.knobs.lock().unwrap().confirm_delay = Duration::from_secs(7);
    h.deliver("w-lu-1", h.sim.webhook("lu-1")).await;
    h.per.knobs.lock().unwrap().confirm_delay = Duration::ZERO;
    let row = h.txn("lu-1").await;
    assert!(
        row["pendingEvents"]
            .as_object()
            .is_some_and(|m| m.len() == 1),
        "{row}"
    );
    assert_eq!(h.program_count("capture"), 1);
    // The retry asks PER about that signature and books it once.
    h.deliver("w-lu-1b", h.sim.webhook("lu-1")).await;
    assert_eq!(h.program_count("capture"), 1, "never sent twice");
    let row = h.txn("lu-1").await;
    assert_eq!(row["capturedCents"], "1000", "{row}");
    assert!(
        row["pendingEvents"]
            .as_object()
            .is_none_or(|m| m.is_empty()),
        "{row}"
    );
    assert_eq!(h.per.with_card(&h.policy, |c| c.period.captured), 1_000);
}

/// Review F2: attestation gates approvals unless `report` is asked for.
#[test]
fn attestation_defaults_to_enforce_and_report_is_explicit() {
    assert_eq!(
        super::attestation_mode(None).unwrap(),
        AttestationMode::Enforce
    );
    assert_eq!(
        super::attestation_mode(Some("enforce")).unwrap(),
        AttestationMode::Enforce
    );
    assert_eq!(
        super::attestation_mode(Some("report")).unwrap(),
        AttestationMode::Report
    );
    assert!(super::attestation_mode(Some("off")).is_err());
}

/// Review F4: the connector refuses to start off Devnet.
#[test]
fn the_connector_refuses_any_cluster_but_devnet() {
    assert!(CardsConnector::from_env_cluster_check("mainnet-beta").is_err());
    assert!(CardsConnector::from_env_cluster_check("devnet").is_ok());
}

#[path = "tests_activation.rs"]
mod activation_tests;
#[path = "tests_private_repay.rs"]
mod private_repay_tests;
#[path = "tests_statements.rs"]
mod statements_tests;

/// Live Devnet 2026-10-06: an allowed purchase timed out (`ambiguous`), the
/// issuer declined, then the merchant force-posted the clearing anyway. The
/// row must read as the late capture it is, not as a reversal.
async fn ambiguous_then_force_posted(h: &Harness, token: &str, flaky: bool) -> (Value, Value) {
    h.intent("demo-approved", "100").await;
    h.per.knobs.lock().unwrap().confirm_delay = Duration::from_millis(2_600);
    assert_eq!(
        h.asa(token, 100, "demo-approved", "AUTHORIZATION").await.1,
        "SUSPECTED_FRAUD"
    );
    h.per.knobs.lock().unwrap().confirm_delay = Duration::ZERO;
    assert_eq!(h.txn(token).await["state"], "ambiguous");
    h.sim.authorization(
        token,
        &h.card_token,
        100,
        "DEMO-DATAAPI",
        "SUSPECTED_FRAUD",
        "AUTHORIZATION",
    );
    h.sim
        .add_event(token, &format!("{token}-c"), "CLEARING", 100, "DEBIT");
    if flaky {
        // Resolution reads the Reservation twice (decide, then money); the
        // re-read after the capture fails, as a slow TEE read or a close by
        // a concurrent webhook pass would make it.
        let reservation = program::reservation_pda(
            &h.policy,
            &program::auth_id_hash(h.cards.config.issuer_code, token),
        );
        h.per.knobs.lock().unwrap().flaky_reads = Some((reservation, 2));
    }
    assert_eq!(
        h.deliver(&format!("w-{token}"), h.sim.webhook(token)).await,
        200
    );
    h.per.knobs.lock().unwrap().flaky_reads = None;
    let record = h.txn(token).await;
    let (status, page) = h
        .owner(
            "GET",
            &format!("/v1/cards/{}/activity?limit=10", h.card_id),
            None,
        )
        .await;
    assert_eq!(status, 200, "{page}");
    let row = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["rowId"] == format!("asa:{token}"))
        .unwrap()
        .clone();
    (record, row)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn clearing_after_an_ambiguous_decline_reads_as_a_late_capture() {
    let h = Harness::new().await;
    let (record, row) = ambiguous_then_force_posted(&h, "late-1", false).await;
    assert_eq!(record["state"], "reversed", "{record}");
    assert_eq!(record["capturedCents"], "100");
    assert_eq!(record["flags"]["lateCapture"], true, "{record}");
    assert_eq!(
        (
            row["kind"].as_str(),
            row["lifecycle"].as_str(),
            row["amountCents"].as_str()
        ),
        (Some("capture"), Some("late_capture"), Some("100"))
    );
    assert_eq!(h.program_count("capture"), 1, "booked once on PER");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn late_capture_flag_survives_a_failed_reservation_re_read() {
    let h = Harness::new().await;
    let (record, row) = ambiguous_then_force_posted(&h, "late-2", true).await;
    assert_eq!(record["state"], "reversed", "{record}");
    assert_eq!(record["capturedCents"], "100", "{record}");
    // Before the fix the flag came only from the PER re-read: missing here,
    // and the row read `reversal / reversed` (live Devnet 2026-10-06).
    assert_eq!(record["flags"]["lateCapture"], true, "{record}");
    assert_eq!(
        (row["kind"].as_str(), row["lifecycle"].as_str()),
        (Some("capture"), Some("late_capture"))
    );
}

#[test]
fn released_holds_with_captured_money_project_as_late_captures() {
    use super::routes::transaction_kind;
    // Rows stored before Axum mirrored the flag: the live $1 row.
    assert_eq!(
        transaction_kind("reversed", &json!({}), "100"),
        ("capture", "late_capture")
    );
    assert_eq!(
        transaction_kind("expired", &json!({}), "100"),
        ("capture", "late_capture")
    );
    assert_eq!(
        transaction_kind("expired", &json!({"lateCapture": true}), "0"),
        ("capture", "late_capture")
    );
    // A plain release stays a reversal.
    assert_eq!(
        transaction_kind("reversed", &json!({}), "0"),
        ("reversal", "reversed")
    );
    assert_eq!(
        transaction_kind("expired", &json!(null), "0"),
        ("reversal", "expired")
    );
    assert_eq!(
        transaction_kind("captured", &json!({}), "100"),
        ("capture", "captured")
    );
    assert_eq!(
        transaction_kind("captured", &json!({"lateCapture": true}), "100"),
        ("capture", "late_capture")
    );
    assert_eq!(
        transaction_kind("reserved", &json!({}), "0"),
        ("authorization", "reserved")
    );
    assert_eq!(
        transaction_kind("pending", &json!({}), "0"),
        ("authorization", "pending")
    );
}
