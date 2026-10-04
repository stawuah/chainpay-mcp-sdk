//! Private statement repayment (MagicBlock Private Payments, contracts.md
//! §7.3). Same harness as the statement tests; the fake base RPC also serves
//! the partner account's finalized history, built from a real Devnet
//! settlement transaction (`testdata/magicblock_settlement_devnet.json`).

use super::statements_tests::{Payment, seed};
use super::*;
use crate::connectors::card_issuer::private_repay::{self, METHOD};

const SPL_TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const FIXTURE: &str = include_str!("testdata/magicblock_settlement_devnet.json");
/// Another account (not the configured partner): the wrong recipient.
const OTHER_ACCOUNT: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/// Owner wallet of `PARTNER_TOKEN_ACCOUNT` on Devnet.
const PARTNER_OWNER: &str = "8X9QgE3rA2rJpM6GrxyQoJfWNghQdqmQM2UoyoYPEd7U";

impl Harness {
    /// The partner token account and the mint, as they sit on Devnet.
    fn partner_on_chain(&self) {
        let mint: solana_address::Address = statements::DEVNET_USDC_MINT.parse().unwrap();
        let mut account = vec![0u8; 165];
        account[..32].copy_from_slice(mint.as_ref());
        account[32..64].copy_from_slice(
            PARTNER_OWNER
                .parse::<solana_address::Address>()
                .unwrap()
                .as_ref(),
        );
        let mut mint_data = vec![0u8; 82];
        mint_data[44] = 6;
        let mut chain = self.chain.lock().unwrap();
        chain.insert(PARTNER_TOKEN_ACCOUNT.into(), (SPL_TOKEN.into(), account));
        chain.insert(mint.to_string(), (SPL_TOKEN.into(), mint_data));
    }

    /// A finalized MagicBlock queue settlement paying `amount` base units to
    /// `destination`, tagged `reference` (the real Devnet tx, re-pointed).
    fn settle(&self, reference: &str, amount: u64, destination: &str) -> String {
        let mut tx: Value = serde_json::from_str(FIXTURE).unwrap();
        for line in tx["meta"]["logMessages"].as_array_mut().unwrap() {
            if line
                .as_str()
                .unwrap()
                .starts_with("Program log: client_ref_id: ")
            {
                *line = json!(format!("Program log: client_ref_id: {reference}"));
            }
        }
        for group in tx["meta"]["innerInstructions"].as_array_mut().unwrap() {
            for ix in group["instructions"].as_array_mut().unwrap() {
                if ix["parsed"]["type"] == "transferChecked" {
                    ix["parsed"]["info"]["destination"] = json!(destination);
                    ix["parsed"]["info"]["tokenAmount"]["amount"] = json!(amount.to_string());
                }
            }
        }
        let mut txs = self.txs.lock().unwrap();
        let n = txs.len() as u8 + 1;
        let sig = bs58::encode([n; 64]).into_string();
        tx["transaction"]["signatures"] = json!([sig]);
        txs.push((sig.clone(), 507_200_000 + n as u64, tx));
        sig
    }

    async fn closed_statement(&self, op: &str) -> Value {
        self.purchase(
            op,
            1_000,
            &[(&format!("{op}-c"), "CLEARING", 1_000, "DEBIT")],
        )
        .await;
        let (status, stmt) = self
            .owner(
                "POST",
                &format!("/v1/cards/{}/statements/close", self.card_id),
                Some(json!({"clientOperationId": format!("close-{op}")})),
            )
            .await;
        assert_eq!(status, 200, "{stmt}");
        stmt
    }

    async fn prepare_private(&self, statement: &Value, op: &str) -> (u16, Value) {
        self.owner(
            "POST",
            &format!(
                "/v1/cards/{}/statements/{}/repayment/private",
                self.card_id,
                statement["statementId"].as_str().unwrap()
            ),
            Some(json!({"clientOperationId": op})),
        )
        .await
    }

    async fn submit_private(&self, statement: &Value, attempt: &str) -> (u16, Value) {
        self.owner(
            "POST",
            &format!(
                "/v1/cards/{}/statements/{}/repayment",
                self.card_id,
                statement["statementId"].as_str().unwrap()
            ),
            Some(json!({"method": METHOD, "attemptId": attempt, "cluster": "devnet"})),
        )
        .await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn private_repayment_discharges_only_after_settlement_and_partner_confirm() {
    let h = Harness::new().await;
    h.partner_on_chain();
    // Noise already in the partner's history before the attempt exists.
    h.settle("1", 5, PARTNER_TOKEN_ACCOUNT);
    let stmt = h.closed_statement("pv-1").await;
    let due: u64 = stmt["amountDueCents"].as_str().unwrap().parse().unwrap();
    assert_eq!(stmt["payPrivately"]["method"], METHOD, "{stmt}");
    assert_eq!(stmt["payPrivately"]["payerVerified"], false);

    let (status, attempt) = h.prepare_private(&stmt, "pp-0001").await;
    assert_eq!(status, 200, "{attempt}");
    let reference = attempt["clientRefId"].as_str().unwrap().to_owned();
    assert!(reference.len() <= 12 && reference.bytes().all(|b| b.is_ascii_digit()));
    assert_eq!(attempt["amountBaseUnits"], (due * 10_000).to_string());
    assert_eq!(attempt["recipientWallet"], PARTNER_OWNER.to_string());
    assert_eq!(attempt["recipientTokenAccount"], PARTNER_TOKEN_ACCOUNT);
    assert_eq!(attempt["transfer"]["visibility"], "private");
    assert_eq!(attempt["transfer"]["split"], 1);
    assert_eq!(attempt["verification"]["notVerifiable"], json!(["payer"]));
    assert_eq!(attempt["apiCluster"], "devnet-private");
    // Get-or-create: a different operation id returns the same open attempt.
    let (_, again) = h.prepare_private(&stmt, "pp-0002").await;
    assert_eq!(again["attemptId"], attempt["attemptId"]);
    assert_eq!(again["clientRefId"], attempt["clientRefId"]);

    // Nothing settled yet: retryable, no state change.
    let (status, pending) = h.submit_private(&stmt, "p1").await;
    assert_eq!(status, 409, "{pending}");
    assert_eq!(pending["code"], "settlement_pending");
    assert_eq!(pending["retryable"], true);
    // A payout with someone else's reference never counts.
    h.settle("999", due * 10_000, PARTNER_TOKEN_ACCOUNT);
    assert_eq!(h.submit_private(&stmt, "p1").await.0, 409);
    assert_eq!(h.outstanding(), due);

    let sig = h.settle(&reference, due * 10_000, PARTNER_TOKEN_ACCOUNT);
    let (status, paid) = h.submit_private(&stmt, "p1").await;
    assert_eq!(status, 200, "{paid}");
    assert_eq!(paid["state"], "discharged", "{paid}");
    let s = &paid["statement"];
    assert_eq!(s["repayment"]["method"], METHOD);
    assert_eq!(s["repayment"]["payerVerified"], false);
    assert_eq!(s["repayment"]["settlementSignatures"], json!([sig]));
    assert_eq!(
        s["repayment"]["amountBaseUnits"],
        (due * 10_000).to_string()
    );
    assert_eq!(s["partner"]["simulated"], true);
    let states: Vec<&str> = s["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["state"].as_str().unwrap())
        .collect();
    assert_eq!(
        states,
        vec![
            "closed",
            "repayment_observed",
            "partner_confirmed",
            "discharged"
        ]
    );
    assert_eq!(h.outstanding(), 0);

    // Idempotent: the same attempt again reports the same discharge, and no
    // new attempt can be opened on a repaid statement.
    let (status, again) = h.submit_private(&stmt, "p1").await;
    assert_eq!(status, 200);
    assert_eq!(again["state"], "discharged");
    assert_eq!(h.prepare_private(&stmt, "pp-0003").await.0, 409);
    assert_eq!(
        h.submit_private(&stmt, "p2").await.1["code"],
        "already_repaid"
    );

    // The partner ledger booked the settlement, not a receipt.
    let digest = stmt["digest"].as_str().unwrap();
    let entry = h
        .store
        .get_card_record(CardKind::CardStatements, &format!("partner:{digest}"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.record["method"], METHOD);
    let evidence = entry.record["evidence"].as_str().unwrap();
    assert!(
        evidence.starts_with("settlement:") && !evidence.contains(&sig),
        "{evidence}"
    );
    assert!(entry.record["receiptPda"].is_null());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_amount_or_recipient_never_closes_and_needs_a_fresh_reference() {
    let h = Harness::new().await;
    h.partner_on_chain();
    let stmt = h.closed_statement("pv-2").await;
    let due: u64 = stmt["amountDueCents"].as_str().unwrap().parse().unwrap();
    let (_, first) = h.prepare_private(&stmt, "pp-0101").await;
    let r1 = first["clientRefId"].as_str().unwrap().to_owned();
    // Half the amount, right reference.
    h.settle(&r1, due * 5_000, PARTNER_TOKEN_ACCOUNT);
    let (status, wrong) = h.submit_private(&stmt, "p1").await;
    assert_eq!(status, 200, "{wrong}");
    assert_eq!(wrong["state"], "repayment_mismatch");
    assert_eq!(wrong["mismatch"], json!(["amount"]));
    assert_eq!(h.outstanding(), due, "a short payment books nothing on PER");
    // The spent attempt is dead; a new one carries a new reference.
    assert_eq!(
        h.submit_private(&stmt, "p1").await.1["code"],
        "attempt_spent"
    );
    let (_, second) = h.prepare_private(&stmt, "pp-0102").await;
    assert_eq!(second["attemptId"], "p2");
    let r2 = second["clientRefId"].as_str().unwrap().to_owned();
    assert_ne!(r1, r2);
    // Right amount and reference, but paid to another account in the same tx
    // history: refused as the wrong recipient.
    let mut tx: Value = serde_json::from_str(FIXTURE).unwrap();
    for line in tx["meta"]["logMessages"].as_array_mut().unwrap() {
        if line
            .as_str()
            .unwrap()
            .starts_with("Program log: client_ref_id: ")
        {
            *line = json!(format!("Program log: client_ref_id: {r2}"));
        }
    }
    for group in tx["meta"]["innerInstructions"].as_array_mut().unwrap() {
        for ix in group["instructions"].as_array_mut().unwrap() {
            if ix["parsed"]["type"] == "transferChecked" {
                ix["parsed"]["info"]["destination"] = json!(OTHER_ACCOUNT);
                ix["parsed"]["info"]["tokenAmount"]["amount"] = json!((due * 10_000).to_string());
            }
        }
    }
    h.txs
        .lock()
        .unwrap()
        .push((bs58::encode([77u8; 64]).into_string(), 507_300_000, tx));
    let (_, wrong) = h.submit_private(&stmt, "p2").await;
    assert_eq!(wrong["mismatch"], json!(["recipient"]), "{wrong}");
    assert_eq!(h.outstanding(), due);
    // Third attempt, exact: discharged.
    let (_, third) = h.prepare_private(&stmt, "pp-0103").await;
    h.settle(
        third["clientRefId"].as_str().unwrap(),
        due * 10_000,
        PARTNER_TOKEN_ACCOUNT,
    );
    let (_, paid) = h.submit_private(&stmt, "p3").await;
    assert_eq!(paid["state"], "discharged", "{paid}");
    assert_eq!(h.outstanding(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cron_finishes_a_private_payment_whose_owner_went_away() {
    let h = Harness::new().await;
    h.partner_on_chain();
    let stmt = h.closed_statement("pv-3").await;
    let due: u64 = stmt["amountDueCents"].as_str().unwrap().parse().unwrap();
    let (_, attempt) = h.prepare_private(&stmt, "pp-0201").await;
    h.settle(
        attempt["clientRefId"].as_str().unwrap(),
        due * 10_000,
        PARTNER_TOKEN_ACCOUNT,
    );
    let (status, _) = h
        .call("POST", "/internal/cron/cards/reconcile", Some(CRON), None)
        .await;
    assert_eq!(status, 200);
    let (_, list) = h
        .owner("GET", &format!("/v1/cards/{}/statements", h.card_id), None)
        .await;
    assert_eq!(list["statements"][0]["state"], "discharged", "{list}");
    assert_eq!(h.outstanding(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn private_details_stay_out_of_agent_views_logs_and_storage_plaintext_scan() {
    let h = Harness::new().await;
    h.partner_on_chain();
    let stmt = h.closed_statement("pv-4").await;
    let due: u64 = stmt["amountDueCents"].as_str().unwrap().parse().unwrap();
    // Agents can neither prepare nor submit a private repayment.
    let path = format!(
        "/v1/cards/{}/statements/{}/repayment/private",
        h.card_id,
        stmt["statementId"].as_str().unwrap()
    );
    let (status, _) = h
        .call(
            "POST",
            &path,
            Some(AGENT_TOKEN),
            Some(json!({"clientOperationId": "agent-1"})),
        )
        .await;
    assert_eq!(status, 403);
    let (_, attempt) = h.prepare_private(&stmt, "pp-0301").await;
    let reference = attempt["clientRefId"].as_str().unwrap().to_owned();
    let sig = h.settle(&reference, due * 10_000, PARTNER_TOKEN_ACCOUNT);
    let (_, paid) = h.submit_private(&stmt, "p1").await;
    assert_eq!(paid["state"], "discharged", "{paid}");
    let (status, agent) = h
        .call(
            "GET",
            &format!("/v1/cards/{}/statements", h.card_id),
            Some(AGENT_TOKEN),
            None,
        )
        .await;
    assert_eq!(status, 200, "{agent}");
    let (_, agent_one) = h
        .call(
            "GET",
            &format!(
                "/v1/cards/{}/statements/{}",
                h.card_id,
                stmt["statementId"].as_str().unwrap()
            ),
            Some(AGENT_TOKEN),
            None,
        )
        .await;
    let partner_wallet = PARTNER_OWNER.to_string();
    for view in [agent.to_string(), agent_one.to_string()] {
        assert!(view.contains(METHOD), "agent still sees the method: {view}");
        for needle in [&reference, &sig, &partner_wallet] {
            assert!(
                !view.contains(needle.as_str()),
                "agent view leaked {needle}"
            );
        }
    }
    // Logs never carry the reference, settlement signature or partner wallet.
    let logs: Vec<String> = captured_logs().lock().unwrap().clone();
    for line in &logs {
        for needle in [&reference, &sig, &partner_wallet] {
            assert!(
                !line.contains(needle.as_str()),
                "log leaked {needle}: {line}"
            );
        }
    }
    // Storage: the private-repayment fields are plain ids and amounts, never
    // a token or a card-number-shaped run; the MagicBlock bearer token never
    // reaches Axum at all, so no row mentions one.
    // Convex rows (keys, index columns, bodies) never name the reference or
    // the public settlement: both are sealed, claims and ledger evidence are
    // keyed digests. The owner still sees them (opened server-side).
    for row in h.store.all_card_records().await {
        let text = format!("{} {:?} {}", row.key, row.index, row.record);
        assert!(!text.to_ascii_lowercase().contains("bearer"), "{}", row.key);
        assert!(!text.contains("authToken"), "{}", row.key);
        for needle in [&reference, &sig] {
            assert!(
                !text.contains(needle.as_str()),
                "convex row {} leaked {needle}",
                row.key
            );
        }
    }
    let (_, owner_view) = h
        .owner("GET", &format!("/v1/cards/{}/statements", h.card_id), None)
        .await;
    let owner_text = owner_view.to_string();
    assert!(
        owner_text.contains(&reference) && owner_text.contains(&sig),
        "owner sees both"
    );
    h.assert_no_pan().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn client_ref_ids_are_short_distinct_and_never_card_shaped() {
    let h = Harness::new().await;
    let cards = &h.cards;
    let mut seen = std::collections::HashSet::new();
    for seq in 1..=200 {
        let r = private_repay::client_ref_id(cards, &"ab".repeat(32), seq);
        assert!(!r.is_empty() && r.len() <= 12 && r != "0", "{r}");
        assert!(seen.insert(r));
    }
    // Different digest, same seq: different reference.
    assert_ne!(
        private_repay::client_ref_id(cards, &"ab".repeat(32), 1),
        private_repay::client_ref_id(cards, &"cd".repeat(32), 1)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_attempt_is_retired_so_a_fresh_one_can_open() {
    let h = Harness::new().await;
    h.partner_on_chain();
    let stmt = h.closed_statement("pv-5").await;
    let (_, first) = h.prepare_private(&stmt, "pp-0401").await;
    assert_eq!(first["attemptId"], "p1");
    // The stored expectation drifts (as if the amount or config changed).
    let key = format!("stmt:{}", stmt["statementId"].as_str().unwrap());
    let row = h
        .store
        .get_card_record(CardKind::CardStatements, &key)
        .await
        .unwrap()
        .unwrap();
    let mut record = row.record.clone();
    record["privateRepayment"]["attempts"][0]["amountBaseUnits"] = json!("1");
    h.store
        .put_card_record(
            CardKind::CardStatements,
            &key,
            row.index.clone(),
            record,
            Some(row.rev()),
            1,
        )
        .await
        .unwrap();
    let (status, stale) = h.submit_private(&stmt, "p1").await;
    assert_eq!(status, 409, "{stale}");
    assert_eq!(stale["code"], "attempt_stale");
    let (_, second) = h.prepare_private(&stmt, "pp-0402").await;
    assert_eq!(second["attemptId"], "p2", "{second}");
    assert_ne!(second["clientRefId"], first["clientRefId"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_partner_account_that_is_not_the_wallets_ata_is_refused_before_paying() {
    let h = Harness::new().await;
    h.partner_on_chain();
    // Same account, but owned by a wallet whose ATA is something else.
    h.chain
        .lock()
        .unwrap()
        .get_mut(PARTNER_TOKEN_ACCOUNT)
        .unwrap()
        .1[32..64]
        .copy_from_slice(&[7u8; 32]);
    let stmt = h.closed_statement("pv-6").await;
    let (status, body) = h.prepare_private(&stmt, "pp-0501").await;
    assert_eq!(status, 503, "{body}");
    assert_eq!(body["code"], "repayment_unconfigured");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_private_payout_after_a_transparent_repayment_is_flagged_not_lost() {
    let h = Harness::new().await;
    h.partner_on_chain();
    let stmt = h.closed_statement("pv-7").await;
    let due: u64 = stmt["amountDueCents"].as_str().unwrap().parse().unwrap();
    let (_, attempt) = h.prepare_private(&stmt, "pp-0601").await;
    // The owner pays the regular way instead.
    let (receipt, mandate) = h.pay(
        &stmt,
        Payment {
            mandate_seed: seed(9),
            ..Default::default()
        },
    );
    let (_, paid) = h.repay(&stmt, &receipt, &mandate, "devnet").await;
    assert_eq!(paid["state"], "discharged", "{paid}");
    // ...and the private transfer they had already sent lands later.
    h.settle(
        attempt["clientRefId"].as_str().unwrap(),
        due * 10_000,
        PARTNER_TOKEN_ACCOUNT,
    );
    let (status, _) = h
        .call("POST", "/internal/cron/cards/reconcile", Some(CRON), None)
        .await;
    assert_eq!(status, 200);
    let (_, list) = h
        .owner("GET", &format!("/v1/cards/{}/statements", h.card_id), None)
        .await;
    let s = &list["statements"][0];
    assert_eq!(s["state"], "discharged");
    assert_eq!(s["privateRepayment"][0]["state"], "unapplied_payout", "{s}");
    assert_eq!(
        s["privateRepayment"][0]["unappliedBaseUnits"],
        (due * 10_000).to_string()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_transparent_body_carrying_its_own_method_label_stays_transparent() {
    let h = Harness::new().await;
    h.partner_on_chain();
    let stmt = h.closed_statement("pv-8").await;
    let (status, body) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/statements/{}/repayment", h.card_id, stmt["statementId"].as_str().unwrap()),
            Some(json!({"method": "chainpay_execute_payment", "receiptPda": PARTNER_TOKEN_ACCOUNT, "mandatePda": PARTNER_TOKEN_ACCOUNT, "cluster": "devnet"})),
        )
        .await;
    // Routed to the transparent receipt verifier (which rejects this bogus
    // receipt on its own terms), never the private parser.
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "repayment_mismatch");
    assert!(
        body["mismatch"]
            .as_array()
            .unwrap()
            .contains(&json!("receipt"))
    );
}
