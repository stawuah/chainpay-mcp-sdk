//! Live end-to-end check of the card connector: Solana Devnet + MagicBlock
//! Devnet TEE + Lithic **sandbox**. Operator tooling, never run in CI.
//!
//! ```text
//! cargo run -p chainpay-backend --example cards_live_sandbox -- setup <public relay url> <secrets out file>
//! cargo run -p chainpay-backend --example cards_live_sandbox -- run <results json>
//! cargo run -p chainpay-backend --example cards_live_sandbox -- teardown
//! cargo run -p chainpay-backend --example cards_live_sandbox -- statement <out json>
//! cargo run -p chainpay-backend --example cards_live_sandbox -- repay <state json> <receipt> <mandate> <label>
//! cargo run -p chainpay-backend --example cards_live_sandbox -- soak <n> <out json> [card id]
//! ```
//!
//! `soak` (final fixes, capacity): one card, `n` $0.10 purchases through the
//! whole path (agent intent → runner redeem → Lithic `simulate/authorize` →
//! ASA → PER `authorize`, then `simulate/clearing` → events webhook → capture
//! → `close_reservation`). Every 25 purchases it reads, as the owner over PER,
//! the policy's lamports (the prefund), its live ephemeral-account count and
//! the AuthGuard's closed count, so the run shows the prefund holding steady.
//!
//! `statement` (workstream E) creates and activates a card, captures one $10
//! purchase through the full checkout path, shows that the period cannot roll
//! early, closes the running statement and writes its digest and amount due
//! (no secrets) to `<out json>` for the Devnet `execute_payment`. `repay`
//! submits a receipt to the repayment route and reads the card's credit
//! exposure back over PER as the owner.
//!
//! Env: LITHIC_SANDBOX_API_KEY, RELAY_URL (local relay), OWNER_KEYPAIR,
//! STRANGER_KEYPAIR, CONVEX_SITE + CHAINPAY_CONVEX_MCP_SECRET (to register a
//! test agent connection, as the MCP server would), CARDS_CHECKOUT_RUNNER_SECRET,
//! CRON_SECRET, LITHIC_ASA_SECRET. Secrets are written only to the file given
//! to `setup` (mode 0600) and are never printed. No PAN is ever printed,
//! stored or returned: the checkout runner and `simulate/return` hold it in
//! memory for one call.

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use chainpay_backend::connectors::card_issuer::{
    lithic::{LithicClient, SANDBOX_URL},
    program::{self, PolicyArgs},
    tee::{DEVNET_TEE_URL, TeeClient, TeeRead, TxOutcome},
};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::{Value, json};
use solana_address::Address;
use std::time::{Duration, Instant};

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn keypair(path: &str) -> SigningKey {
    let bytes: Vec<u8> =
        serde_json::from_str(&std::fs::read_to_string(path).expect("keypair file"))
            .expect("keypair json");
    SigningKey::from_bytes(bytes[..32].try_into().unwrap())
}

fn lithic() -> LithicClient {
    LithicClient::new(SANDBOX_URL, env("LITHIC_SANDBOX_API_KEY"), true).unwrap()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("setup") => setup(&args[2], &args[3]).await,
        Some("run") => run(&args[2]).await,
        Some("teardown") => teardown().await,
        Some("statement") => statement(&args[2]).await,
        Some("repay") => repay(&args[2], &args[3], &args[4], &args[5]).await,
        Some("soak") => soak(args[2].parse().expect("n"), &args[3], args.get(4).cloned()).await,
        Some("private-prepare") => private_prepare(&args[2], &args[3], &args[4]).await,
        Some("private-submit") => private_submit(&args[2], &args[3], &args[4]).await,
        Some("private-verify") => private_verify(&args[2], &args[3], &args[4], &args[5]).await,
        _ => eprintln!(
            "usage: setup <public url> <secrets file> | run <results.json> | teardown | statement <out.json> | repay <state.json> <receipt> <mandate> <label> | private-prepare <state.json> <attempt.json> <label> | private-submit <state.json> <attemptId> <label>"
        ),
    }
}

async fn setup(public_url: &str, secrets_path: &str) {
    let l = lithic();
    let base = public_url.trim_end_matches('/');
    let enroll = l
        .admin(
            reqwest::Method::POST,
            "/v1/responder_endpoints",
            Some(json!({"type":"AUTH_STREAM_ACCESS","url":format!("{base}/v1/cards/lithic/asa")})),
        )
        .await;
    println!(
        "enroll ASA responder: {}",
        if enroll.is_ok() { "ok" } else { "failed" }
    );
    let asa = l
        .admin(reqwest::Method::GET, "/v1/auth_stream/secret", None)
        .await
        .expect("asa secret");
    let subscription = l
        .admin(
            reqwest::Method::POST,
            "/v1/event_subscriptions",
            Some(json!({
                "url": format!("{base}/v1/cards/lithic/events"),
                "description": "chainpay cards connector (sandbox tunnel)",
                "disabled": false,
                "event_types": ["card_transaction.updated", "card.updated", "card.created", "dispute.updated", "dispute_transaction.created", "dispute_transaction.updated"],
            })),
        )
        .await
        .expect("event subscription");
    let token = subscription["token"]
        .as_str()
        .expect("subscription token")
        .to_owned();
    let events = l
        .admin(
            reqwest::Method::GET,
            &format!("/v1/event_subscriptions/{token}/secret"),
            None,
        )
        .await
        .expect("events secret");
    let body = format!(
        "LITHIC_ASA_SECRET='{}'\nLITHIC_EVENTS_SECRET='{}'\nLITHIC_EVENT_SUBSCRIPTION='{}'\n",
        asa["secret"].as_str().unwrap_or(""),
        events["secret"].as_str().unwrap_or(""),
        token
    );
    std::fs::write(secrets_path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(secrets_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    println!("event subscription created; secrets written to the given file (not printed)");
}

async fn teardown() {
    let l = lithic();
    let unenroll = l
        .admin(
            reqwest::Method::DELETE,
            "/v1/responder_endpoints?type=AUTH_STREAM_ACCESS",
            None,
        )
        .await;
    println!(
        "unenroll ASA responder: {}",
        if unenroll.is_ok() { "ok" } else { "failed" }
    );
    if let Ok(token) = std::env::var("LITHIC_EVENT_SUBSCRIPTION") {
        let disable = l
            .admin(
                reqwest::Method::PATCH,
                &format!("/v1/event_subscriptions/{token}"),
                Some(json!({"disabled": true, "url": "https://example.invalid/disabled"})),
            )
            .await;
        println!(
            "disable event subscription: {}",
            if disable.is_ok() { "ok" } else { "failed" }
        );
    }
}

struct Relay {
    http: reqwest::Client,
    url: String,
    session: String,
    agent: String,
}

impl Relay {
    async fn call(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: Option<Value>,
    ) -> (u16, Value) {
        let mut request = self
            .http
            .request(method.parse().unwrap(), format!("{}{path}", self.url))
            .bearer_auth(token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        (status, response.json().await.unwrap_or(Value::Null))
    }
    async fn owner(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        self.call(method, path, &self.session.clone(), body).await
    }
}

async fn login(http: &reqwest::Client, url: &str, owner: &SigningKey) -> String {
    let wallet = bs58::encode(owner.verifying_key().to_bytes()).into_string();
    let origin = "http://localhost:5173";
    let challenge: Value = http
        .get(format!("{url}/v1/auth/challenge?wallet={wallet}"))
        .header("Origin", origin)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let signature = B64.encode(
        owner
            .sign(challenge["message"].as_str().unwrap().as_bytes())
            .to_bytes(),
    );
    let session: Value = http
        .post(format!("{url}/v1/auth/session"))
        .header("Origin", origin)
        .json(&json!({"challenge_id": challenge["challenge_id"], "signature": signature}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    session["token"].as_str().expect("session token").to_owned()
}

async fn register_agent(owner: &str, card_id: &str) -> String {
    let mut raw = [0u8; 32];
    getrandom::fill(&mut raw).unwrap();
    let token = program::hex(&raw);
    use sha2::Digest;
    let hash = program::hex(&sha2::Sha256::digest(token.as_bytes()));
    let scope = json!({"version":1,"mandates":[],"tools":["request_card_checkout","get_card_activity","get_statement"],"agents":{},"cards":[card_id]});
    let record = json!({"id": format!("conn-{}", &hash[..12]), "tokenHash": hash, "wallet": owner, "agentName": "live sandbox agent", "scope": scope.to_string(), "connectedAt": "2026-10-04T00:00:00Z", "lastSeenAt": null, "totalCalls": 0, "toolsCalled": [], "revokedAt": null});
    let response = reqwest::Client::new()
        .post(format!(
            "{}/internal/storage/v1",
            env("CONVEX_SITE").trim_end_matches('/')
        ))
        .bearer_auth(env("CHAINPAY_CONVEX_MCP_SECRET"))
        .json(&json!({"operation":"mcp.register","args":{"record":record}}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success(), "agent registration failed");
    token
}

async fn devnet_send(http: &reqwest::Client, tx_b64: &str, owner: &SigningKey) -> String {
    let mut tx: solana_transaction::versioned::VersionedTransaction =
        wincode::deserialize(&B64.decode(tx_b64).unwrap()).unwrap();
    program::sign_transaction(&mut tx, &[owner]).unwrap();
    let wire = B64.encode(program::serialize_transaction(&tx));
    let rpc = "https://api.devnet.solana.com";
    let sent: Value = http
        .post(rpc)
        .json(&json!({"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":[wire,{"encoding":"base64","preflightCommitment":"confirmed"}]}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let signature = sent["result"]
        .as_str()
        .unwrap_or_else(|| panic!("send failed: {}", sent["error"]))
        .to_owned();
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(800)).await;
        let status: Value = http
            .post(rpc)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"getSignatureStatuses","params":[[signature]]}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let s = &status["result"]["value"][0];
        if !s.is_null()
            && matches!(
                s["confirmationStatus"].as_str(),
                Some("confirmed" | "finalized")
            )
        {
            assert!(s["err"].is_null(), "base tx failed: {}", s["err"]);
            return signature;
        }
    }
    panic!("base tx not confirmed");
}

fn outcome(o: &TxOutcome) -> Value {
    match o {
        TxOutcome::Confirmed { signature } => json!({"ok": true, "sig": signature}),
        TxOutcome::ProgramError { signature, code } => {
            json!({"ok": false, "error": program::error_name(*code), "sig": signature})
        }
        TxOutcome::Failed { reason, .. } => json!({"ok": false, "error": reason}),
        TxOutcome::Unknown { .. } => json!({"ok": false, "error": "unknown"}),
    }
}

async fn activity_row(relay: &Relay, card_id: &str, token: &str) -> Value {
    let (_, page) = relay
        .owner(
            "GET",
            &format!("/v1/cards/{card_id}/activity?limit=100"),
            None,
        )
        .await;
    page["rows"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|r| r["rowId"] == format!("asa:{token}"))
                .cloned()
        })
        .unwrap_or(Value::Null)
}

async fn wait_row(
    relay: &Relay,
    card_id: &str,
    token: &str,
    pred: impl Fn(&Value) -> bool,
    secs: u64,
) -> Value {
    let started = Instant::now();
    loop {
        let row = activity_row(relay, card_id, token).await;
        if pred(&row) || started.elapsed() > Duration::from_secs(secs) {
            return row;
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
}

fn summary(row: &Value) -> Value {
    json!({"kind": row["kind"], "lifecycle": row["lifecycle"], "amountCents": row["amountCents"], "capturedCents": row["capturedCents"], "reservedCents": row["reservedCents"], "refundedCents": row["refundedCents"], "declineReason": row["declineReason"], "exception": row["exception"], "needsReview": row["needsReview"]})
}

/// Sandbox simulate calls can be refused right after an authorization lands;
/// retry a few times.
async fn simulate(l: &LithicClient, path: &str, body: Value) -> bool {
    for _ in 0..4 {
        if l.simulate(path, body.clone()).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    false
}

async fn issuer(l: &LithicClient, token: &str) -> Value {
    let mut t = Value::Null;
    for _ in 0..6 {
        if let Ok(found) = l.get_transaction(token).await {
            t = found;
            break;
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    json!({"status": t["status"], "result": t["result"], "events": t["events"].as_array().map(|e| e.iter().map(|e| json!({"type": e["type"], "result": e["result"], "amount": e["amount"]})).collect::<Vec<_>>())})
}

async fn checkout(
    relay: &Relay,
    card_id: &str,
    op: &str,
    merchant: &str,
    cents: &str,
) -> (u16, Value) {
    relay
        .call("POST", &format!("/v1/cards/{card_id}/checkout-intents"), &relay.agent.clone(), Some(json!({"clientOperationId": op, "merchantRef": merchant, "amountCents": cents, "currency": "USD"})))
        .await
}

async fn redeem(relay: &Relay, capability: &str) -> (u16, Value, u128) {
    let started = Instant::now();
    let (status, body) = relay
        .call(
            "POST",
            "/v1/cards/checkout/redeem",
            &env("CARDS_CHECKOUT_RUNNER_SECRET"),
            Some(json!({"capability": capability})),
        )
        .await;
    (status, body, started.elapsed().as_millis())
}

async fn run(out_path: &str) {
    let http = reqwest::Client::new();
    let url = env("RELAY_URL");
    let owner = keypair(&env("OWNER_KEYPAIR"));
    let owner_pk = Address::from(owner.verifying_key().to_bytes());
    let l = lithic();
    let mut out = json!({"ranAt": chainpay_backend::connectors::card_issuer::rfc3339(chainpay_backend::connectors::card_issuer::now_ms()), "network": "solana-devnet + magicblock-devnet-tee + lithic-sandbox"});
    let session = login(&http, &url, &owner).await;
    let mut relay = Relay {
        http: http.clone(),
        url: url.clone(),
        session,
        agent: String::new(),
    };
    let op = |name: &str| {
        format!(
            "live-{name}-{}",
            chainpay_backend::connectors::card_issuer::now_ms()
        )
    };

    // 1. prepare: Lithic VIRTUAL card created PAUSED + unsigned base txs.
    let (status, prepared) = relay
        .owner(
            "POST",
            "/v1/cards/prepare",
            Some(json!({"clientOperationId": op("prepare"), "label": "Live sandbox card"})),
        )
        .await;
    assert_eq!(status, 200, "prepare: {prepared}");
    let card_id = prepared["cardId"].as_str().unwrap().to_owned();
    let authorizer: Address = prepared["authorizer"].as_str().unwrap().parse().unwrap();
    let policy: Address = prepared["accounts"]["policy"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let period: Address = prepared["accounts"]["period"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    out["card"] = json!({"cardId": card_id, "accounts": prepared["accounts"], "authorizer": authorizer.to_string()});
    let init = devnet_send(&http, prepared["initTx"].as_str().unwrap(), &owner).await;
    let topup = devnet_send(&http, prepared["escrowTopUpTx"].as_str().unwrap(), &owner).await;
    let delegate = devnet_send(&http, prepared["delegateTx"].as_str().unwrap(), &owner).await;
    out["base"] = json!({"initCard": init, "escrowTopUp": topup, "delegateCard": delegate});
    tokio::time::sleep(Duration::from_secs(4)).await;

    // 2. owner signs init_permission + set_policy on PER with their own token.
    let owner_tee = TeeClient::new(DEVNET_TEE_URL, owner.clone()).unwrap();
    let deadline = || Instant::now() + Duration::from_secs(25);
    let perm = owner_tee
        .submit(
            vec![program::init_permission(
                &owner_pk,
                &policy,
                &period,
                &authorizer,
            )],
            deadline(),
        )
        .await;
    let args = PolicyArgs {
        budget_cents: 5_000,
        max_purchase_cents: 4_000,
        max_purchases_per_period: 0,
        period_seconds: 30 * 86_400,
        merchant_id_hashes: vec![program::merchant_id_hash("DEMO-DATAAPI")],
        mccs: vec![],
        expires_at: 0,
        recurring_allowed: false,
        fee_bps: 50,
        authorizer: authorizer.to_bytes(),
    };
    let set = owner_tee
        .submit(
            vec![program::set_policy(&owner_pk, &policy, &period, &args)],
            deadline(),
        )
        .await;
    out["per"] = json!({"initPermission": outcome(&perm), "setPolicy": outcome(&set), "policy": {"budgetCents": "5000", "maxPurchaseCents": "4000", "merchants": ["demo-approved"], "feeBps": 50}});

    // 3. activate: mirror limits to Lithic, then OPEN.
    let (status, view) = relay
        .owner(
            "POST",
            &format!("/v1/cards/{card_id}/activate"),
            Some(json!({"clientOperationId": op("activate"), "expectedPolicyVersion": 1})),
        )
        .await;
    out["activate"] = json!({"status": status, "issuerState": view["issuerState"], "mirror": view["mirror"], "error": view["code"], "detail": view["detail"]});
    assert_eq!(status, 200, "activate: {view}");
    let owner_wallet = owner_pk.to_string();
    relay.agent = register_agent(&owner_wallet, &card_id).await;

    // 4. checkouts: open $20 and $40 intents first, plus a $10 one for the void.
    let (s20, c20) = checkout(&relay, &card_id, &op("c20"), "demo-approved", "2000").await;
    let (s40, c40) = checkout(&relay, &card_id, &op("c40"), "demo-approved", "4000").await;
    let (s_off, c_off) = checkout(&relay, &card_id, &op("coff"), "demo-unapproved", "1000").await;
    out["intents"] = json!({"20": s20, "40": s40, "unapprovedMerchant": {"status": s_off, "code": c_off["code"], "detail": c_off["detail"]}});

    // 5. authorize $20 → approved; $40 → declined over budget.
    let (_, r20, ms20) = redeem(&relay, c20["capability"].as_str().unwrap()).await;
    let t20 = r20["lithicToken"].as_str().unwrap().to_owned();
    let row20 = wait_row(&relay, &card_id, &t20, |r| r["lifecycle"] == "reserved", 10).await;
    out["authorize20"] =
        json!({"redeemMs": ms20, "chainpay": summary(&row20), "issuer": issuer(&l, &t20).await});
    let (_, r40, ms40) = redeem(&relay, c40["capability"].as_str().unwrap()).await;
    let t40 = r40["lithicToken"].as_str().unwrap().to_owned();
    let row40 = wait_row(&relay, &card_id, &t40, |r| !r.is_null(), 10).await;
    out["authorize40"] =
        json!({"redeemMs": ms40, "chainpay": summary(&row40), "issuer": issuer(&l, &t40).await});
    let (again, _, _) = redeem(&relay, c20["capability"].as_str().unwrap()).await;
    out["capabilityReuse"] = json!({"status": again});

    // 6. duplicate ASA delivery for the approved token (Lithic retry shape).
    let dup = duplicate_asa(&http, &url, &t20, &l, 2_000).await;
    out["duplicateAsa"] = dup;

    // 7. authorization advice ($20 → $25), partial clearing $15, final clearing $10.
    let advice = simulate(
        &l,
        "/v1/simulate/authorization_advice",
        json!({"token": t20, "amount": 2_500}),
    )
    .await;
    let row = wait_row(&relay, &card_id, &t20, |r| r["reservedCents"] == "2500", 30).await;
    out["advice"] = json!({"simulated": advice, "chainpay": summary(&row)});
    let partial = simulate(
        &l,
        "/v1/simulate/clearing",
        json!({"token": t20, "amount": 1_500}),
    )
    .await;
    let row = wait_row(
        &relay,
        &card_id,
        &t20,
        |r| r["lifecycle"] == "partially_captured",
        30,
    )
    .await;
    out["partialClearing"] = json!({"simulated": partial, "chainpay": summary(&row)});
    let rest = simulate(
        &l,
        "/v1/simulate/clearing",
        json!({"token": t20, "amount": 1_000}),
    )
    .await;
    let row = wait_row(&relay, &card_id, &t20, |r| r["lifecycle"] == "captured", 30).await;
    out["clearing"] =
        json!({"simulated": rest, "chainpay": summary(&row), "issuer": issuer(&l, &t20).await});

    // 8. void: a fresh $10 authorization, reversed in full.
    let (_, c10) = checkout(&relay, &card_id, &op("c10"), "demo-approved", "1000").await;
    let (_, r10, _) = redeem(&relay, c10["capability"].as_str().unwrap_or("")).await;
    let t10 = r10["lithicToken"].as_str().unwrap_or("").to_owned();
    wait_row(&relay, &card_id, &t10, |r| r["lifecycle"] == "reserved", 10).await;
    let void = simulate(
        &l,
        "/v1/simulate/void",
        json!({"token": t10, "amount": 1_000, "type": "AUTHORIZATION_REVERSAL"}),
    )
    .await;
    let row = wait_row(&relay, &card_id, &t10, |r| r["lifecycle"] == "reversed", 30).await;
    out["void"] =
        json!({"simulated": void, "chainpay": summary(&row), "issuer": issuer(&l, &t10).await});

    // 9. return: $5 credit (PAN held in memory for this one call only).
    let card_token = issuer_card_token(&l, &t20).await;
    let ret = l
        .with_pan(&card_token, |pan| {
            let l2 = l.clone();
            async move { l2.simulate_return(&pan, 500, "DATA API CREDITS").await }
        })
        .await;
    let tret = ret.as_ref().map(|t| t.clone()).unwrap_or_default();
    let row = wait_row(&relay, &card_id, &tret, |r| r["kind"] == "refund", 30).await;
    out["return"] = json!({"simulated": ret.is_ok(), "chainpay": summary(&row), "issuer": issuer(&l, &tret).await});

    // 10. freeze → Lithic PAUSED → issuer declines before ASA.
    let (_, c_frozen) = checkout(&relay, &card_id, &op("cfz"), "demo-approved", "500").await;
    let (fs, freeze) = relay
        .owner(
            "POST",
            &format!("/v1/cards/{card_id}/freeze"),
            Some(json!({"clientOperationId": op("freeze"), "reason": "live sandbox freeze test"})),
        )
        .await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (_, view) = relay
        .owner("GET", &format!("/v1/cards/{card_id}"), None)
        .await;
    let issued = l
        .get_card(&card_token)
        .await
        .map(|c| c.state)
        .unwrap_or_default();
    let (rs, rf, _) = redeem(&relay, c_frozen["capability"].as_str().unwrap_or("")).await;
    let tf = rf["lithicToken"].as_str().unwrap_or("").to_owned();
    tokio::time::sleep(Duration::from_secs(2)).await;
    let (after_freeze, refused) =
        checkout(&relay, &card_id, &op("cfz2"), "demo-approved", "500").await;
    out["freeze"] = json!({
        "status": fs, "response": freeze, "cardView": {"freeze": view["freeze"], "issuerState": view["issuerState"]},
        "lithicCardState": issued,
        "authorizeWhileFrozen": {"redeemStatus": rs, "issuer": issuer(&l, &tf).await, "chainpay": summary(&activity_row(&relay, &card_id, &tf).await)},
        "newCheckoutWhileFrozen": {"status": after_freeze, "detail": refused["detail"]},
    });

    // 11. reconciliation pass and privacy reads.
    let (cs, cron) = relay
        .call(
            "POST",
            "/internal/cron/cards/reconcile",
            &env("CRON_SECRET"),
            None,
        )
        .await;
    out["reconcile"] = json!({"status": cs, "report": cron});
    let stranger = TeeClient::new(DEVNET_TEE_URL, keypair(&env("STRANGER_KEYPAIR"))).unwrap();
    let read = |r: TeeRead| match r {
        TeeRead::Visible { .. } => "visible",
        TeeRead::NotVisible { .. } => "null",
        TeeRead::RpcError(_) => "rpc_error",
    };
    out["privacy"] = json!({
        "policyAsOwner": read(owner_tee.read_account(&policy, Duration::from_secs(10)).await),
        "policyAsStranger": read(stranger.read_account(&policy, Duration::from_secs(10)).await),
    });
    let (_, activity) = relay
        .owner(
            "GET",
            &format!("/v1/cards/{card_id}/activity?limit=50"),
            None,
        )
        .await;
    out["activityKinds"] = json!(activity["rows"].as_array().map(|rows| {
        rows.iter()
            .map(|r| json!([r["kind"], r["lifecycle"]]))
            .collect::<Vec<_>>()
    }));
    std::fs::write(out_path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}

async fn issuer_card_token(l: &LithicClient, txn: &str) -> String {
    l.get_transaction(txn).await.unwrap()["card_token"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Re-send an ASA request for an already-decided token, signed with the
/// enrolled ASA secret, exactly as Lithic does on a connection retry.
async fn duplicate_asa(
    http: &reqwest::Client,
    url: &str,
    token: &str,
    l: &LithicClient,
    amount: u64,
) -> Value {
    use hmac::{Hmac, Mac};
    let card_token = issuer_card_token(l, token).await;
    let body = json!({
        "token": token, "status": "AUTHORIZATION",
        "amounts": {"cardholder": {"amount": amount, "currency": "USD", "conversion_rate": "1.0"}, "merchant": {"amount": amount, "currency": "USD"}, "hold": null, "settlement": null},
        "acquirer_fee": 0, "cash_amount": 0,
        "merchant": {"acceptor_id": "DEMO-DATAAPI", "mcc": "5734", "descriptor": "DATA API CREDITS", "city": "", "state": "", "country": "USA"},
        "card": {"token": card_token}, "transaction_initiator": "CARDHOLDER",
    });
    let raw = serde_json::to_vec(&body).unwrap();
    let ts = (chainpay_backend::connectors::card_issuer::now_ms() / 1000).to_string();
    let id = format!("dup_{token}");
    let secret = env("LITHIC_ASA_SECRET");
    let key = B64.decode(secret.trim_start_matches("whsec_")).unwrap();
    let mut mac = Hmac::<sha2_010::Sha256>::new_from_slice(&key).unwrap();
    mac.update(format!("{id}.{ts}.").as_bytes());
    mac.update(&raw);
    let sig = B64.encode(mac.finalize().into_bytes());
    let started = Instant::now();
    let response = http
        .post(format!("{url}/v1/cards/lithic/asa"))
        .header("webhook-id", id)
        .header("webhook-timestamp", ts)
        .header("webhook-signature", format!("v1,{sig}"))
        .body(raw)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let result: Value = response.json().await.unwrap_or(Value::Null);
    json!({"status": status, "result": result["result"], "ms": started.elapsed().as_millis()})
}

// ------------------------------------------------- workstream E: statements

async fn new_card(
    relay: &mut Relay,
    owner: &SigningKey,
    label: &str,
) -> (String, Address, Address, Value) {
    let http = relay.http.clone();
    let owner_pk = Address::from(owner.verifying_key().to_bytes());
    let op = |name: &str| {
        format!(
            "live-{name}-{}",
            chainpay_backend::connectors::card_issuer::now_ms()
        )
    };
    let (status, prepared) = relay
        .owner(
            "POST",
            "/v1/cards/prepare",
            Some(json!({"clientOperationId": op("prepare"), "label": label})),
        )
        .await;
    assert_eq!(status, 200, "prepare: {prepared}");
    let card_id = prepared["cardId"].as_str().unwrap().to_owned();
    let authorizer: Address = prepared["authorizer"].as_str().unwrap().parse().unwrap();
    let policy: Address = prepared["accounts"]["policy"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let period: Address = prepared["accounts"]["period"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let init = devnet_send(&http, prepared["initTx"].as_str().unwrap(), owner).await;
    let topup = devnet_send(&http, prepared["escrowTopUpTx"].as_str().unwrap(), owner).await;
    let delegate = devnet_send(&http, prepared["delegateTx"].as_str().unwrap(), owner).await;
    tokio::time::sleep(Duration::from_secs(4)).await;
    let owner_tee = TeeClient::new(DEVNET_TEE_URL, owner.clone()).unwrap();
    let deadline = || Instant::now() + Duration::from_secs(25);
    let perm = owner_tee
        .submit(
            vec![program::init_permission(
                &owner_pk,
                &policy,
                &period,
                &authorizer,
            )],
            deadline(),
        )
        .await;
    let args = PolicyArgs {
        budget_cents: 5_000,
        max_purchase_cents: 4_000,
        max_purchases_per_period: 0,
        period_seconds: 30 * 86_400,
        merchant_id_hashes: vec![program::merchant_id_hash("DEMO-DATAAPI")],
        mccs: vec![],
        expires_at: 0,
        recurring_allowed: false,
        fee_bps: 50,
        authorizer: authorizer.to_bytes(),
    };
    let set = owner_tee
        .submit(
            vec![program::set_policy(&owner_pk, &policy, &period, &args)],
            deadline(),
        )
        .await;
    let (status, view) = relay
        .owner(
            "POST",
            &format!("/v1/cards/{card_id}/activate"),
            Some(json!({"clientOperationId": op("activate"), "expectedPolicyVersion": 1})),
        )
        .await;
    assert_eq!(status, 200, "activate: {view}");
    relay.agent = register_agent(&owner_pk.to_string(), &card_id).await;
    let setup = json!({
        "cardId": card_id,
        "accounts": prepared["accounts"],
        "authorizer": authorizer.to_string(),
        "base": {"initCard": init, "escrowTopUp": topup, "delegateCard": delegate},
        "per": {"initPermission": outcome(&perm), "setPolicy": outcome(&set)},
        "policy": {"budgetCents": "5000", "maxPurchaseCents": "4000", "merchants": ["demo-approved"], "feeBps": 50, "periodDays": 30},
        "activate": {"issuerState": view["issuerState"], "mirror": view["mirror"]["state"]},
    });
    (card_id, policy, period, setup)
}

async fn statement(out_path: &str) {
    let http = reqwest::Client::new();
    let url = env("RELAY_URL");
    let owner = keypair(&env("OWNER_KEYPAIR"));
    let l = lithic();
    let session = login(&http, &url, &owner).await;
    let mut relay = Relay {
        http: http.clone(),
        url: url.clone(),
        session,
        agent: String::new(),
    };
    let mut out = json!({"ranAt": chainpay_backend::connectors::card_issuer::rfc3339(chainpay_backend::connectors::card_issuer::now_ms()), "network": "solana-devnet + magicblock-devnet-tee + lithic-sandbox"});
    let (card_id, policy, _period, setup) = new_card(&mut relay, &owner, "Statement card").await;
    out["card"] = setup;
    let op = |name: &str| {
        format!(
            "live-{name}-{}",
            chainpay_backend::connectors::card_issuer::now_ms()
        )
    };

    // One $10 purchase through the contract path, cleared in full.
    let (s10, c10) = checkout(&relay, &card_id, &op("c10"), "demo-approved", "1000").await;
    assert_eq!(s10, 200, "checkout: {c10}");
    let (_, r10, ms) = redeem(&relay, c10["capability"].as_str().unwrap()).await;
    let t10 = r10["lithicToken"].as_str().unwrap().to_owned();
    let row = wait_row(&relay, &card_id, &t10, |r| r["lifecycle"] == "reserved", 15).await;
    out["authorize"] = json!({"redeemMs": ms, "chainpay": summary(&row)});
    let cleared = simulate(
        &l,
        "/v1/simulate/clearing",
        json!({"token": t10, "amount": 1_000}),
    )
    .await;
    let row = wait_row(&relay, &card_id, &t10, |r| r["lifecycle"] == "captured", 45).await;
    out["clearing"] =
        json!({"simulated": cleared, "chainpay": summary(&row), "issuer": issuer(&l, &t10).await});

    // The period cannot roll early: the cron leaves it open (PER PeriodNotEnded
    // guard is never even reached because period_end is in the future).
    let (cs, cron) = relay
        .call(
            "POST",
            "/internal/cron/cards/reconcile",
            &env("CRON_SECRET"),
            None,
        )
        .await;
    out["cronBeforePeriodEnd"] = json!({"status": cs, "report": cron});
    let owner_tee = TeeClient::new(DEVNET_TEE_URL, owner.clone()).unwrap();
    let authorizer_roll =
        TeeClient::new(DEVNET_TEE_URL, keypair(&env("AUTHORIZER_KEYPAIR"))).unwrap();
    let period_pda: Address = out["card"]["accounts"]["period"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let early = authorizer_roll
        .submit(
            vec![program::roll_period(
                &authorizer_roll.authorizer,
                &policy,
                &period_pda,
                &[],
            )],
            Instant::now() + Duration::from_secs(25),
        )
        .await;
    out["rollPeriodEarly"] = outcome(&early);

    // Running statement, then the owner closes it now (interim close).
    let (_, open) = relay
        .owner("GET", &format!("/v1/cards/{card_id}/statements"), None)
        .await;
    out["openStatement"] = json!({"lineCount": open["open"]["lineCount"], "runningTotalCents": open["open"]["runningTotalCents"]});
    let (status, stmt) = relay
        .owner(
            "POST",
            &format!("/v1/cards/{card_id}/statements/close"),
            Some(json!({"clientOperationId": op("close")})),
        )
        .await;
    assert_eq!(status, 200, "close: {stmt}");
    out["statement"] = json!({
        "statementId": stmt["statementId"], "state": stmt["state"], "closeKind": stmt["closeKind"],
        "purchasesCents": stmt["purchasesCents"], "feeCents": stmt["feeCents"], "totalCents": stmt["totalCents"],
        "amountDueCents": stmt["amountDueCents"], "dueAt": stmt["dueAt"], "digest": stmt["digest"],
        "lines": stmt["lines"], "payWith": stmt["payWith"], "label": stmt["label"],
    });
    let exposure = match owner_tee
        .read_account(&policy, Duration::from_secs(10))
        .await
    {
        TeeRead::Visible { data, .. } => program::decode_policy(&data)
            .map(|p| p.statement_outstanding_cents.to_string())
            .unwrap_or_default(),
        _ => "not_visible".into(),
    };
    out["perExposureCents"] = json!(exposure);
    std::fs::write(out_path, serde_json::to_string_pretty(&out).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}

async fn repay(state_path: &str, receipt: &str, mandate: &str, label: &str) {
    let http = reqwest::Client::new();
    let url = env("RELAY_URL");
    let owner = keypair(&env("OWNER_KEYPAIR"));
    let session = login(&http, &url, &owner).await;
    let relay = Relay {
        http,
        url,
        session,
        agent: String::new(),
    };
    let mut state: Value =
        serde_json::from_str(&std::fs::read_to_string(state_path).unwrap()).unwrap();
    let card_id = state["card"]["cardId"].as_str().unwrap().to_owned();
    let statement_id = state["statement"]["statementId"]
        .as_str()
        .unwrap()
        .to_owned();
    let started = Instant::now();
    let (status, body) = relay
        .owner(
            "POST",
            &format!("/v1/cards/{card_id}/statements/{statement_id}/repayment"),
            Some(json!({"receiptPda": receipt, "mandatePda": mandate, "cluster": "devnet"})),
        )
        .await;
    let policy: Address = state["card"]["accounts"]["policy"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let owner_tee = TeeClient::new(DEVNET_TEE_URL, owner.clone()).unwrap();
    let digest: [u8; 32] = program::unhex(state["statement"]["digest"].as_str().unwrap()).unwrap();
    let per = match owner_tee
        .read_account(&policy, Duration::from_secs(10))
        .await
    {
        TeeRead::Visible { data, .. } => {
            let p = program::decode_policy(&data).unwrap();
            json!({"statementOutstandingCents": p.statement_outstanding_cents.to_string(), "repaymentRecorded": p.repayment_recorded(&digest)})
        }
        _ => json!("not_visible"),
    };
    let s = &body["statement"];
    state[label] = json!({
        "receiptPda": receipt, "mandatePda": mandate, "status": status, "ms": started.elapsed().as_millis(),
        "state": body["state"], "mismatch": body["mismatch"], "code": body["code"],
        "statementState": s["state"], "repayment": s["repayment"], "partner": s["partner"],
        "history": s["history"], "amountDueCents": s["amountDueCents"], "per": per,
    });
    std::fs::write(state_path, serde_json::to_string_pretty(&state).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&state[label]).unwrap());
}

/// Private repayment (MagicBlock Private Payments): get or create the open
/// attempt and write it for `scripts/pay-card-statement-private.mjs`.
async fn private_prepare(state_path: &str, attempt_path: &str, label: &str) {
    let http = reqwest::Client::new();
    let url = env("RELAY_URL");
    let owner = keypair(&env("OWNER_KEYPAIR"));
    let session = login(&http, &url, &owner).await;
    let relay = Relay {
        http,
        url,
        session,
        agent: String::new(),
    };
    let mut state: Value =
        serde_json::from_str(&std::fs::read_to_string(state_path).unwrap()).unwrap();
    let card_id = state["card"]["cardId"].as_str().unwrap().to_owned();
    let statement_id = state["statement"]["statementId"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_, before) = relay
        .owner(
            "GET",
            &format!("/v1/cards/{card_id}/statements/{statement_id}"),
            None,
        )
        .await;
    let (status, attempt) = relay
        .owner(
            "POST",
            &format!("/v1/cards/{card_id}/statements/{statement_id}/repayment/private"),
            Some(json!({"clientOperationId": format!("live-private-{label}")})),
        )
        .await;
    assert_eq!(status, 200, "prepare: {attempt}");
    std::fs::write(
        attempt_path,
        serde_json::to_string_pretty(&attempt).unwrap(),
    )
    .unwrap();
    state[format!("{label}Prepare")] =
        json!({"payPrivately": before["payPrivately"], "attempt": attempt});
    std::fs::write(state_path, serde_json::to_string_pretty(&state).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&attempt).unwrap());
}

/// Ask Axum to verify the attempt's settlement, polling past
/// `settlement_pending` for up to 120 s, then read PER as the owner.
async fn private_submit(state_path: &str, attempt_id: &str, label: &str) {
    let http = reqwest::Client::new();
    let url = env("RELAY_URL");
    let owner = keypair(&env("OWNER_KEYPAIR"));
    let session = login(&http, &url, &owner).await;
    let relay = Relay {
        http,
        url,
        session,
        agent: String::new(),
    };
    let mut state: Value =
        serde_json::from_str(&std::fs::read_to_string(state_path).unwrap()).unwrap();
    let card_id = state["card"]["cardId"].as_str().unwrap().to_owned();
    let statement_id = state["statement"]["statementId"]
        .as_str()
        .unwrap()
        .to_owned();
    let started = Instant::now();
    let mut polls = 0;
    let (status, body) = loop {
        polls += 1;
        let (status, body) = relay
            .owner(
                "POST",
                &format!("/v1/cards/{card_id}/statements/{statement_id}/repayment"),
                Some(json!({"method": "magicblock_private_payments", "attemptId": attempt_id, "cluster": "devnet"})),
            )
            .await;
        if status == 409
            && body["code"] == "settlement_pending"
            && started.elapsed() < Duration::from_secs(120)
        {
            tokio::time::sleep(Duration::from_secs(4)).await;
            continue;
        }
        break (status, body);
    };
    let policy: Address = state["card"]["accounts"]["policy"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    let owner_tee = TeeClient::new(DEVNET_TEE_URL, owner.clone()).unwrap();
    let digest: [u8; 32] = program::unhex(state["statement"]["digest"].as_str().unwrap()).unwrap();
    let per = match owner_tee
        .read_account(&policy, Duration::from_secs(10))
        .await
    {
        TeeRead::Visible { data, .. } => {
            let p = program::decode_policy(&data).unwrap();
            json!({"statementOutstandingCents": p.statement_outstanding_cents.to_string(), "repaymentRecorded": p.repayment_recorded(&digest)})
        }
        _ => json!("not_visible"),
    };
    let s = &body["statement"];
    state[label] = json!({
        "attemptId": attempt_id, "status": status, "polls": polls, "ms": started.elapsed().as_millis(),
        "state": body["state"], "mismatch": body["mismatch"], "code": body["code"],
        "statementState": s["state"], "repayment": s["repayment"], "privateRepayment": s["privateRepayment"],
        "partner": s["partner"], "discharge": s["discharge"], "history": s["history"],
        "amountDueCents": s["amountDueCents"], "per": per,
    });
    std::fs::write(state_path, serde_json::to_string_pretty(&state).unwrap()).unwrap();
    println!("{}", serde_json::to_string_pretty(&state[label]).unwrap());
}

/// Read-only: run Axum's settlement scan + match (the exact code the route
/// uses) against live Devnet for a reference, without the relay or Lithic.
/// `cursor` = a partner signature older than the payout ("-" for none).
async fn private_verify(partner: &str, cursor: &str, reference: &str, base_units: &str) {
    use chainpay_backend::connectors::card_issuer::private_repay;
    let rpc =
        chainpay_backend::rpc::RpcClient::new(chainpay_backend::rpc::RpcConfig::default()).unwrap();
    let base = chainpay_backend::connectors::card_issuer::statements::BaseChain {
        rpc,
        chainpay_program: "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4".into(),
        cluster: "devnet",
    };
    let cursor = (cursor != "-").then_some(cursor);
    let want: u64 = base_units.parse().unwrap();
    let mint = chainpay_backend::connectors::card_issuer::statements::DEVNET_USDC_MINT;
    let out = match private_repay::scan(&base, partner, cursor, reference).await {
        private_repay::Scan::Found(found, slot) => {
            let verdict = private_repay::check(&found, want, mint, partner);
            json!({"found": found.iter().map(|(sig, s)| json!({"signature": sig, "amount": s.amount.to_string(), "mint": s.mint, "destination": s.destination, "clientRefId": s.client_ref_id})).collect::<Vec<_>>(), "slot": slot, "verdict": match verdict { Ok((sig, amount)) => json!({"verified": sig, "amountBaseUnits": amount.to_string()}), Err(m) => json!({"mismatch": m}) }})
        }
        private_repay::Scan::Pending { advance } => json!({"pending": true, "advance": advance}),
        private_repay::Scan::Unavailable => json!({"unavailable": true}),
    };
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}

// ------------------------------------------------ final fixes: capacity soak

/// Owner read over PER: (lamports, data) of one account.
async fn per_account(tee: &TeeClient, address: &Address) -> Option<(u64, Vec<u8>)> {
    let body = tee
        .rpc(
            "getAccountInfo",
            json!([address.to_string(), {"encoding":"base64","commitment":"confirmed"}]),
            Duration::from_secs(8),
        )
        .await
        .ok()?;
    let value = &body["result"]["value"];
    let lamports = value["lamports"].as_u64()?;
    let data = B64.decode(value["data"][0].as_str()?).ok()?;
    Some((lamports, data))
}

/// Prefund lamports, live ephemeral accounts (CardPolicy's trailing u16) and
/// AuthGuard closed count (u64 at offset 40), read as the owner.
async fn capacity_probe(tee: &TeeClient, policy: &Address) -> Value {
    let (lamports, ephemeral) = match per_account(tee, policy).await {
        Some((lamports, data)) if data.len() >= 2 => (
            json!(lamports),
            json!(u16::from_le_bytes([
                data[data.len() - 2],
                data[data.len() - 1]
            ])),
        ),
        _ => (Value::Null, Value::Null),
    };
    let closed = per_account(tee, &program::auth_guard_pda(policy))
        .await
        .filter(|(_, data)| data.len() >= 48)
        .map(|(_, data)| u64::from_le_bytes(data[40..48].try_into().unwrap()));
    json!({"policyLamports": lamports, "ephemeralAccounts": ephemeral, "guardClosedCount": closed})
}

async fn soak(n: usize, out_path: &str, existing: Option<String>) {
    let http = reqwest::Client::new();
    let url = env("RELAY_URL");
    let owner = keypair(&env("OWNER_KEYPAIR"));
    let owner_pk = Address::from(owner.verifying_key().to_bytes());
    let l = lithic();
    let session = login(&http, &url, &owner).await;
    let mut relay = Relay {
        http: http.clone(),
        url: url.clone(),
        session,
        agent: String::new(),
    };
    let (card_id, policy, setup) = match existing {
        Some(card_id) => {
            let (_, view) = relay
                .owner("GET", &format!("/v1/cards/{card_id}"), None)
                .await;
            let accounts = CardAccountsView::from(&view);
            relay.agent = register_agent(&owner_pk.to_string(), &card_id).await;
            (card_id, accounts.policy, json!({"reused": true}))
        }
        None => {
            let (card_id, policy, _period, setup) =
                new_card(&mut relay, &owner, "Capacity soak").await;
            (card_id, policy, setup)
        }
    };
    let tee = TeeClient::new(DEVNET_TEE_URL, owner.clone()).unwrap();
    let started_at = chainpay_backend::connectors::card_issuer::rfc3339(
        chainpay_backend::connectors::card_issuer::now_ms(),
    );
    let mut out = json!({
        "ranAt": started_at,
        "network": "solana-devnet + magicblock-devnet-tee + lithic-sandbox",
        "cardId": card_id,
        "setup": setup,
        "prefundLamports": program::PREFUND_LAMPORTS,
        "probes": [],
        "purchases": [],
    });
    let save =
        |out: &Value| std::fs::write(out_path, serde_json::to_vec_pretty(out).unwrap()).unwrap();
    out["probes"]
        .as_array_mut()
        .unwrap()
        .push(json!({"after": 0, "at": capacity_probe(&tee, &policy).await}));
    let mut approved = 0usize;
    let mut cleared = 0usize;
    let mut tokens: Vec<String> = Vec::new();
    for i in 0..n {
        let op = format!(
            "soak-{i}-{}",
            chainpay_backend::connectors::card_issuer::now_ms()
        );
        let intent_started = Instant::now();
        let (status, intent) = checkout(&relay, &card_id, &op, "demo-approved", "10").await;
        let intent_ms = intent_started.elapsed().as_millis();
        if status != 200 {
            out["purchases"].as_array_mut().unwrap().push(
                json!({"i": i, "stage": "intent", "status": status, "code": intent["code"], "intentMs": intent_ms}),
            );
            println!("{i} intent {status} {}", intent["code"]);
            save(&out);
            continue;
        }
        let mut redeemed = (0u16, Value::Null, 0u128);
        for _ in 0..5 {
            redeemed = redeem(&relay, intent["capability"].as_str().unwrap()).await;
            if redeemed.0 != 429 && redeemed.0 != 503 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1200)).await;
        }
        let (rs, body, redeem_ms) = redeemed;
        let token = body["lithicToken"].as_str().unwrap_or_default().to_owned();
        let result = if token.is_empty() {
            Value::Null
        } else {
            issuer(&l, &token).await["result"].clone()
        };
        let ok = result == "APPROVED";
        let mut cleared_ok = false;
        if ok {
            approved += 1;
            tokens.push(token.clone());
            cleared_ok = simulate(
                &l,
                "/v1/simulate/clearing",
                json!({"token": token, "amount": 10}),
            )
            .await;
            if cleared_ok {
                cleared += 1;
            }
        }
        out["purchases"].as_array_mut().unwrap().push(json!({
            "i": i, "stage": "redeem", "status": rs, "result": result,
            "intentMs": intent_ms, "redeemMs": redeem_ms, "cleared": cleared_ok,
        }));
        if (i + 1) % 25 == 0 {
            let probe = capacity_probe(&tee, &policy).await;
            println!("{} approved {approved} cleared {cleared} {probe}", i + 1);
            out["probes"]
                .as_array_mut()
                .unwrap()
                .push(json!({"after": i + 1, "at": probe}));
        }
        save(&out);
    }
    // Let the last clearing webhooks land, then let the cron sweep anything left.
    tokio::time::sleep(Duration::from_secs(20)).await;
    let _ = relay
        .call(
            "POST",
            "/internal/cron/cards/reconcile",
            &env("CRON_SECRET"),
            None,
        )
        .await;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let (_, metrics) = relay
        .call(
            "GET",
            "/internal/ops/cards/metrics",
            &env("CRON_SECRET"),
            None,
        )
        .await;
    let last = capacity_probe(&tee, &policy).await;
    // Replays of closed authorizations: Lithic retrying an ASA for a token we
    // already decided. The first token's auth id has left the guard ring once
    // more than 256 holds closed; the last one is still in it. Both must get
    // the stored decision from Axum and never a new hold.
    let mut replays = Vec::new();
    for token in [tokens.first(), tokens.last()].into_iter().flatten() {
        replays.push(duplicate_asa(&http, &url, token, &l, 10).await);
    }
    let after_replays = capacity_probe(&tee, &policy).await;
    out["final"] = json!({"approved": approved, "cleared": cleared, "attempts": n, "at": last, "replays": replays, "afterReplays": after_replays, "opsMetrics": metrics});
    println!(
        "done: approved {approved}/{n}, cleared {cleared}, final {last}, replays {replays:?}, after replays {after_replays}"
    );
    save(&out);
}

struct CardAccountsView {
    policy: Address,
}

impl From<&Value> for CardAccountsView {
    fn from(view: &Value) -> Self {
        let policy = view["accounts"]["policy"]
            .as_str()
            .or_else(|| view["policyPda"].as_str())
            .expect("card view has the policy account")
            .parse()
            .unwrap();
        Self { policy }
    }
}
