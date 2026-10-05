//! card-sim, Rust side: a Lithic-shaped sandbox double for CI. It issues
//! cards, keeps transaction truth (`GET /v1/transactions/{token}`), records
//! every control call, and, like Lithic, calls our ASA endpoint with a signed
//! `card_authorization.approval_request` on `simulate/authorize`. Scenario
//! files in `scripts/card-sim/scenarios/` drive it (the same files the Node
//! replayer `scripts/card-sim/card-sim.mjs` posts to a live endpoint).

use crate::connectors::inbox::StandardWebhooks;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub const ASA_KEY: [u8; 24] = [11; 24];
pub const EVENTS_KEY: [u8; 24] = [22; 24];

pub fn asa_secret() -> String {
    use base64::Engine;
    format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(ASA_KEY)
    )
}

pub fn events_secret() -> String {
    use base64::Engine;
    format!(
        "whsec_{}",
        base64::engine::general_purpose::STANDARD.encode(EVENTS_KEY)
    )
}

pub fn signed_headers(key: &[u8], id: &str, raw: &[u8]) -> HeaderMap {
    let ts = (super::now_ms() / 1000) as i64;
    let mut headers = HeaderMap::new();
    headers.insert("webhook-id", HeaderValue::from_str(id).unwrap());
    headers.insert(
        "webhook-timestamp",
        HeaderValue::from_str(&ts.to_string()).unwrap(),
    );
    headers.insert(
        "webhook-signature",
        HeaderValue::from_str(&format!("v1,{}", StandardWebhooks::sign(key, id, ts, raw))).unwrap(),
    );
    headers.insert("content-type", HeaderValue::from_static("application/json"));
    headers
}

#[derive(Debug, Clone, Default)]
pub struct SimCard {
    pub pan: String,
    pub state: String,
    pub spend_limit: u64,
}

#[derive(Default)]
pub struct SimState {
    pub cards: HashMap<String, SimCard>,
    pub transactions: HashMap<String, Value>,
    pub calls: Vec<(String, String, Value)>,
    pub rules: Vec<Value>,
    pub asa_url: Option<String>,
    pub asa_results: HashMap<String, String>,
    /// Failure knobs: rule creation, `PATCH state=PAUSED`, card reads and
    /// rule retirement answer 500 while set.
    pub fail_rules: bool,
    pub fail_pause: bool,
    pub fail_get: bool,
    pub fail_retire: bool,
    counter: u64,
}

#[derive(Clone)]
pub struct LithicSim {
    pub state: Arc<Mutex<SimState>>,
    pub url: String,
}

fn uuid(n: u64, tag: u8) -> String {
    format!("{:08x}-0000-4000-8{:03x}-{:012x}", n as u32, tag, n)
}

pub fn asa_payload(
    token: &str,
    card_token: &str,
    amount: u64,
    acceptor_id: &str,
    descriptor: &str,
    mcc: &str,
    status: &str,
) -> Value {
    json!({
        "token": token,
        "status": status,
        "amounts": {"cardholder": {"amount": amount, "currency": "USD", "conversion_rate": "1.0"}, "merchant": {"amount": amount, "currency": "USD"}, "hold": null, "settlement": null},
        "acquirer_fee": 0,
        "cash_amount": 0,
        "merchant": {"acceptor_id": acceptor_id, "acquiring_institution_id": "191231", "mcc": mcc, "descriptor": descriptor, "city": "NEW YORK", "state": "NY", "country": "USA"},
        "card": {"token": card_token, "last_four": "1111", "memo": "sim", "spend_limit": 0, "spend_limit_duration": "TRANSACTION", "state": "OPEN", "type": "VIRTUAL"},
        "transaction_initiator": "CARDHOLDER",
        "avs": {"address": "", "zipcode": ""},
        "name_validation": null,
        "service_location": null,
        "created": "2026-10-04T00:00:00Z",
    })
}

impl LithicSim {
    pub async fn start() -> Self {
        let state = Arc::new(Mutex::new(SimState::default()));
        let app = Router::new()
            .route("/v1/cards", post(create_card))
            .route("/v1/cards/{token}", get(get_card).patch(patch_card))
            .route(
                "/v1/cards/{token}/embed",
                post(|| async { Json(json!({"session":"sim-embed-session"})) }),
            )
            .route("/v2/auth_rules", post(create_rule))
            .route(
                "/v2/auth_rules/{token}/promote",
                post(|| async { Json(json!({})) }),
            )
            .route("/v2/auth_rules/{token}", patch(patch_rule))
            .route("/v1/transactions", get(list_transactions))
            .route("/v1/transactions/{token}", get(get_transaction))
            .route("/v1/simulate/authorize", post(simulate_authorize))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self { state, url }
    }

    pub fn set_asa_url(&self, url: &str) {
        self.state.lock().unwrap().asa_url = Some(url.to_owned());
    }

    pub fn card_state(&self, token: &str) -> SimCard {
        self.state.lock().unwrap().cards[token].clone()
    }

    pub fn calls(&self) -> Vec<(String, String, Value)> {
        self.state.lock().unwrap().calls.clone()
    }

    /// Record or replace issuer truth for a transaction.
    pub fn put_transaction(&self, truth: Value) {
        let token = truth["token"].as_str().unwrap().to_owned();
        self.state.lock().unwrap().transactions.insert(token, truth);
    }

    pub fn transaction(&self, token: &str) -> Option<Value> {
        self.state.lock().unwrap().transactions.get(token).cloned()
    }

    /// Start truth for an authorization the issuer approved or declined.
    pub fn authorization(
        &self,
        token: &str,
        card_token: &str,
        amount: u64,
        acceptor: &str,
        result: &str,
        kind: &str,
    ) {
        self.put_transaction(json!({
            "token": token,
            "card_token": card_token,
            "status": if result == "APPROVED" { "PENDING" } else { "DECLINED" },
            "result": result,
            "merchant": {"acceptor_id": acceptor, "descriptor": "SIM", "mcc": "5734", "city": "NEW YORK", "country": "USA"},
            "events": [{"token": format!("{token}-auth"), "type": kind, "amount": amount, "amounts": {"cardholder": {"amount": amount, "currency": "USD"}}, "result": result, "effective_polarity": "DEBIT", "created": "2026-10-04T00:00:00.000Z"}],
        }));
    }

    /// Append a transaction event (issuer order = insertion order).
    pub fn add_event(
        &self,
        token: &str,
        event_token: &str,
        kind: &str,
        amount: u64,
        polarity: &str,
    ) {
        let mut state = self.state.lock().unwrap();
        state.counter += 1;
        let created = format!(
            "2026-10-04T00:00:{:02}.{:03}Z",
            1 + state.counter / 1000,
            state.counter % 1000
        );
        let truth = state.transactions.get_mut(token).expect("transaction");
        let status = match kind {
            "CLEARING" | "RETURN" => "SETTLED",
            "AUTHORIZATION_REVERSAL" => "VOIDED",
            "AUTHORIZATION_EXPIRY" => "EXPIRED",
            _ => "PENDING",
        };
        truth["status"] = json!(status);
        truth["events"].as_array_mut().unwrap().push(json!({
            "token": event_token, "type": kind, "amount": amount,
            "amounts": {"cardholder": {"amount": amount, "currency": "USD"}},
            "result": "APPROVED", "effective_polarity": polarity, "created": created,
        }));
    }

    /// `card_transaction.updated` webhook body for the current truth.
    pub fn webhook(&self, token: &str) -> Vec<u8> {
        let mut truth = self.transaction(token).expect("transaction");
        truth["event_type"] = json!("card_transaction.updated");
        serde_json::to_vec(&truth).unwrap()
    }
}

type Shared = State<Arc<Mutex<SimState>>>;

fn log(state: &Arc<Mutex<SimState>>, method: &str, path: &str, mut body: Value) {
    if let Some(obj) = body.as_object_mut() {
        if obj.contains_key("pan") {
            obj.insert("pan".into(), json!("[redacted-by-sim]"));
        }
    }
    state
        .lock()
        .unwrap()
        .calls
        .push((method.into(), path.into(), body));
}

async fn create_card(State(state): Shared, Json(body): Json<Value>) -> Json<Value> {
    log(&state, "POST", "/v1/cards", body.clone());
    let mut s = state.lock().unwrap();
    s.counter += 1;
    let token = uuid(s.counter, 1);
    let pan = format!("4111{:012}", 100_000_000_000u64 + s.counter);
    let card = SimCard {
        pan: pan.clone(),
        state: body["state"].as_str().unwrap_or("OPEN").into(),
        spend_limit: 0,
    };
    s.cards.insert(token.clone(), card.clone());
    Json(json!({"token": token, "last_four": &pan[12..], "state": card.state, "type": "VIRTUAL"}))
}

async fn get_card(State(state): Shared, Path(token): Path<String>) -> Response {
    let s = state.lock().unwrap();
    if s.fail_get {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({}))).into_response();
    }
    match s.cards.get(&token) {
        Some(card) => Json(json!({"token": token, "last_four": &card.pan[12..], "state": card.state, "pan": card.pan, "cvv": "123", "spend_limit": card.spend_limit})).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({}))).into_response(),
    }
}

async fn patch_card(
    State(state): Shared,
    Path(token): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    log(&state, "PATCH", &format!("/v1/cards/{token}"), body.clone());
    let mut s = state.lock().unwrap();
    if s.fail_pause && body["state"] == "PAUSED" {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({}))).into_response();
    }
    let Some(card) = s.cards.get_mut(&token) else {
        return (StatusCode::NOT_FOUND, Json(json!({}))).into_response();
    };
    if let Some(next) = body["state"].as_str() {
        card.state = next.into();
    }
    if let Some(limit) = body["spend_limit"].as_u64() {
        card.spend_limit = limit;
    }
    Json(json!({"token": token, "last_four": &card.pan[12..], "state": card.state, "spend_limit": card.spend_limit})).into_response()
}

async fn create_rule(State(state): Shared, Json(body): Json<Value>) -> Response {
    log(&state, "POST", "/v2/auth_rules", body.clone());
    let mut s = state.lock().unwrap();
    if s.fail_rules {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({}))).into_response();
    }
    s.counter += 1;
    s.rules.push(body);
    Json(json!({"token": uuid(s.counter, 2), "current_version": null})).into_response()
}

async fn patch_rule(
    State(state): Shared,
    Path(token): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    log(&state, "PATCH", &format!("/v2/auth_rules/{token}"), body);
    if state.lock().unwrap().fail_retire {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({}))).into_response();
    }
    Json(json!({})).into_response()
}

async fn list_transactions(
    State(state): Shared,
    Query(query): Query<HashMap<String, String>>,
) -> Json<Value> {
    let s = state.lock().unwrap();
    let card = query.get("card_token").cloned().unwrap_or_default();
    let data: Vec<Value> = s
        .transactions
        .values()
        .filter(|t| t["card_token"] == card.as_str())
        .cloned()
        .collect();
    Json(json!({"data": data, "has_more": false}))
}

async fn get_transaction(State(state): Shared, Path(token): Path<String>) -> Response {
    match state.lock().unwrap().transactions.get(&token) {
        Some(t) => Json(t.clone()).into_response(),
        None => (StatusCode::NOT_FOUND, Json(json!({"code":"not_found"}))).into_response(),
    }
}

/// Like Lithic: look up the card by PAN, call our ASA endpoint, record truth.
async fn simulate_authorize(State(state): Shared, Json(body): Json<Value>) -> Response {
    log(&state, "POST", "/v1/simulate/authorize", body.clone());
    let pan = body["pan"].as_str().unwrap_or("").to_owned();
    let (card_token, token, url) = {
        let mut s = state.lock().unwrap();
        let Some(card_token) = s
            .cards
            .iter()
            .find(|(_, c)| c.pan == pan)
            .map(|(t, _)| t.clone())
        else {
            return (StatusCode::BAD_REQUEST, Json(json!({"code":"unknown_pan"}))).into_response();
        };
        s.counter += 1;
        (card_token, uuid(s.counter, 3), s.asa_url.clone())
    };
    let amount = body["amount"].as_u64().unwrap_or(0);
    let acceptor = body["merchant_acceptor_id"]
        .as_str()
        .unwrap_or("")
        .to_owned();
    let mcc = body["mcc"].as_str().unwrap_or("5999").to_owned();
    let descriptor = body["descriptor"].as_str().unwrap_or("").to_owned();
    let card_state = state.lock().unwrap().cards[&card_token].state.clone();
    let result = if card_state != "OPEN" {
        "CARD_PAUSED".to_owned()
    } else if let Some(url) = url {
        let raw = serde_json::to_vec(&asa_payload(
            &token,
            &card_token,
            amount,
            &acceptor,
            &descriptor,
            &mcc,
            "AUTHORIZATION",
        ))
        .unwrap();
        let headers = signed_headers(&ASA_KEY, &format!("asa_{token}"), &raw);
        let response = reqwest::Client::new()
            .post(url)
            .headers(headers)
            .body(raw)
            .send()
            .await;
        match response {
            Ok(r) => r
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v["result"].as_str().map(str::to_owned))
                .unwrap_or("MALFORMED_ASA_RESPONSE".into()),
            Err(_) => "CUSTOMER_ASA_TIMEOUT".into(),
        }
    } else {
        "APPROVED".into()
    };
    let sim = LithicSim {
        state: state.clone(),
        url: String::new(),
    };
    sim.authorization(
        &token,
        &card_token,
        amount,
        &acceptor,
        if result == "APPROVED" {
            "APPROVED"
        } else {
            "DECLINED"
        },
        "AUTHORIZATION",
    );
    state
        .lock()
        .unwrap()
        .asa_results
        .insert(token.clone(), result);
    Json(json!({"token": token, "debugging_request_id": "sim"})).into_response()
}
