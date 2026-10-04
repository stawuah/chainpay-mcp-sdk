//! Workstream E + H integration tests: statements, simulated credit,
//! repayment verification, rollover, recovery, privacy hygiene, telemetry and
//! the frontend asks. Same harness as the connector tests (real router, real
//! connector, Lithic-shaped sim, in-process `card_policy` model) plus a
//! base-layer RPC that serves receipt, mandate and mint accounts.

use super::*;
use crate::connectors::card_issuer::statements::{fee_cents, statement_digest};

const CHAINPAY_PROGRAM: &str = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
const SPL_TOKEN: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const RECEIPT_DISC: [u8; 8] = [168, 198, 209, 4, 60, 235, 126, 109];
const MANDATE_DISC: [u8; 8] = [139, 106, 43, 122, 82, 211, 96, 162];

fn addr(bytes: [u8; 32]) -> solana_address::Address {
    solana_address::Address::from(bytes)
}

impl Harness {
    /// Approve an authorization for `amount` and deliver its issuer events.
    pub(super) async fn purchase(
        &self,
        txn: &str,
        amount: u64,
        events: &[(&str, &str, u64, &str)],
    ) {
        let (status, body) = self.intent("demo-approved", &amount.to_string()).await;
        assert_eq!(status, 200, "{body}");
        let (_, result) = self
            .asa(txn, amount, "demo-approved", "AUTHORIZATION")
            .await;
        assert_eq!(result, "APPROVED");
        self.sim.authorization(
            txn,
            &self.card_token,
            amount,
            "DEMO-DATAAPI",
            "APPROVED",
            "AUTHORIZATION",
        );
        for (id, kind, cents, polarity) in events {
            self.sim.add_event(txn, id, kind, *cents, polarity);
        }
        if !events.is_empty() {
            assert_eq!(
                self.deliver(&format!("w-{txn}-{}", events.len()), self.sim.webhook(txn))
                    .await,
                200
            );
        }
    }

    async fn close_now(&self, op: &str) -> (u16, Value) {
        self.owner(
            "POST",
            &format!("/v1/cards/{}/statements/close", self.card_id),
            Some(json!({"clientOperationId": op})),
        )
        .await
    }

    async fn cron(&self) -> Value {
        let (status, body) = self
            .call("POST", "/internal/cron/cards/reconcile", Some(CRON), None)
            .await;
        assert_eq!(status, 200, "{body}");
        body
    }

    async fn statement_list(&self) -> Value {
        let (status, body) = self
            .owner(
                "GET",
                &format!("/v1/cards/{}/statements", self.card_id),
                None,
            )
            .await;
        assert_eq!(status, 200, "{body}");
        body
    }

    pub(super) fn outstanding(&self) -> u64 {
        self.per.with_card(&self.policy, |c| c.policy.outstanding)
    }

    fn owner_addr(&self) -> solana_address::Address {
        self.owner.parse().unwrap()
    }

    /// Put a ChainPay receipt (and its mandate and the mint) on the fake base
    /// layer, exactly as `execute_payment` would leave them.
    pub(super) fn pay(&self, statement: &Value, p: Payment) -> (String, String) {
        let digest: [u8; 32] = program::unhex(statement["digest"].as_str().unwrap()).unwrap();
        let invoice = p.invoice.unwrap_or(digest);
        let mandate = addr(p.mandate_seed);
        let program_id: solana_address::Address = CHAINPAY_PROGRAM.parse().unwrap();
        let receipt = solana_address::Address::find_program_address(
            &[b"receipt", mandate.as_ref(), &invoice],
            &program_id,
        )
        .0;
        let mut data = vec![0u8; crate::receipts::RECEIPT_ACCOUNT_LENGTH];
        data[..8].copy_from_slice(&RECEIPT_DISC);
        data[8..40].copy_from_slice(mandate.as_ref());
        data[40..72].copy_from_slice(&invoice);
        let mint: solana_address::Address = p
            .mint
            .unwrap_or(statements::DEVNET_USDC_MINT)
            .parse()
            .unwrap();
        data[104..136].copy_from_slice(mint.as_ref());
        let recipient: solana_address::Address = p
            .recipient
            .unwrap_or(PARTNER_TOKEN_ACCOUNT)
            .parse()
            .unwrap();
        data[168..200].copy_from_slice(recipient.as_ref());
        let due = statement["amountDueCents"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        let amount = p.base_units.unwrap_or(due * 10_000);
        data[200..208].copy_from_slice(&amount.to_le_bytes());
        let agent = p.agent.unwrap_or_else(|| {
            program::repay_agent(&self.per.with_card(&self.policy, |c| c.policy.binding))
        });
        data[208..240].copy_from_slice(agent.as_ref());
        data[240..248].copy_from_slice(&77u64.to_le_bytes());
        data[280] = 1;
        let mut mandate_data = vec![0u8; 235];
        mandate_data[..8].copy_from_slice(&MANDATE_DISC);
        let payer = p.payer.unwrap_or_else(|| self.owner_addr());
        mandate_data[8..40].copy_from_slice(payer.as_ref());
        let mut mint_data = vec![0u8; 82];
        mint_data[44] = 6;
        let mut chain = self.chain.lock().unwrap();
        if !p.skip_receipt {
            chain.insert(receipt.to_string(), (CHAINPAY_PROGRAM.into(), data));
        }
        chain.insert(mandate.to_string(), (CHAINPAY_PROGRAM.into(), mandate_data));
        chain.insert(mint.to_string(), (SPL_TOKEN.into(), mint_data));
        (receipt.to_string(), mandate.to_string())
    }

    pub(super) async fn repay(
        &self,
        statement: &Value,
        receipt: &str,
        mandate: &str,
        cluster: &str,
    ) -> (u16, Value) {
        self.owner(
            "POST",
            &format!(
                "/v1/cards/{}/statements/{}/repayment",
                self.card_id,
                statement["statementId"].as_str().unwrap()
            ),
            Some(json!({"receiptPda": receipt, "mandatePda": mandate, "cluster": cluster})),
        )
        .await
    }
}

#[derive(Default)]
pub(super) struct Payment {
    pub(super) mandate_seed: [u8; 32],
    pub(super) invoice: Option<[u8; 32]>,
    pub(super) mint: Option<&'static str>,
    pub(super) recipient: Option<&'static str>,
    pub(super) base_units: Option<u64>,
    pub(super) payer: Option<solana_address::Address>,
    /// Receipt `agent`; defaults to the card's repay agent PDA (a payment
    /// made through card_policy `repay_statement`).
    pub(super) agent: Option<solana_address::Address>,
    pub(super) skip_receipt: bool,
}

pub(super) fn seed(n: u8) -> [u8; 32] {
    let mut s = [n; 32];
    s[0] = 200;
    s
}

// ------------------------------------------------------------ billing math

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn statement_bills_captured_purchases_and_posted_refunds_with_exact_fees() {
    let h = Harness::new().await;
    // $20 authorized; $15 + $5 cleared (two captures); $5 returned.
    h.purchase(
        "bill-1",
        2_000,
        &[
            ("bill-1-c1", "CLEARING", 1_500, "DEBIT"),
            ("bill-1-c2", "CLEARING", 500, "DEBIT"),
        ],
    )
    .await;
    h.sim
        .add_event("bill-1", "bill-1-r", "RETURN", 500, "CREDIT");
    assert_eq!(h.deliver("w-bill-1-r", h.sim.webhook("bill-1")).await, 200);
    // A hold that never cleared and a decline: neither is billed.
    h.purchase("bill-2", 700, &[]).await;
    h.asa("bill-3", 900, "demo-unapproved", "AUTHORIZATION")
        .await;
    let (status, open) = h
        .owner("GET", &format!("/v1/cards/{}/statements", h.card_id), None)
        .await;
    assert_eq!(status, 200);
    assert_eq!(open["open"]["lineCount"], 3, "{open}");
    assert!(open["statements"].as_array().unwrap().is_empty());

    let (status, stmt) = h.close_now("close-0001").await;
    assert_eq!(status, 200, "{stmt}");
    let fees = fee_cents(1_500, 50) + fee_cents(500, 50);
    assert_eq!(fees, 7 + 2);
    let expected = 2_000 - 500 + fees as i64 - fee_cents(500, 50) as i64;
    assert_eq!(stmt["purchasesCents"], "2000");
    assert_eq!(stmt["refundsCents"], "500");
    assert_eq!(
        stmt["feeCents"],
        (fees as i64 - fee_cents(500, 50) as i64).to_string()
    );
    assert_eq!(stmt["totalCents"], expected.to_string());
    assert_eq!(stmt["amountDueCents"], expected.to_string());
    assert_eq!(stmt["state"], "closed");
    assert_eq!(stmt["label"], "Simulated credit");
    assert_eq!(stmt["simulatedCredit"], true);
    assert_eq!(stmt["lines"].as_array().unwrap().len(), 3);
    // The statement agrees with the program's own credit exposure.
    assert_eq!(h.outstanding() as i64, expected);
    // Due date = close + 21 days, digest is a 32-byte hex, payment target shown.
    let closed = statements::parse_rfc3339_ms(stmt["closedAt"].as_str().unwrap()).unwrap();
    let due = statements::parse_rfc3339_ms(stmt["dueAt"].as_str().unwrap()).unwrap();
    assert_eq!(due - closed, 21 * 86_400_000);
    assert_eq!(stmt["digest"].as_str().unwrap().len(), 64);
    assert_eq!(stmt["payWith"]["invoiceHash"], stmt["digest"]);
    assert_eq!(
        stmt["payWith"]["recipientTokenAccount"],
        PARTNER_TOKEN_ACCOUNT
    );
    assert_eq!(stmt["payWith"]["amountCents"], expected.to_string());
    // Retried close with the same operation answers with the same statement.
    let (_, again) = h.close_now("close-0001").await;
    assert_eq!(again["statementId"], stmt["statementId"]);
    // Nothing left to close.
    assert_eq!(h.close_now("close-0002").await.0, 409);
    // A later capture lands on the next statement, never the closed one.
    h.sim
        .add_event("bill-2", "bill-2-c", "CLEARING", 700, "DEBIT");
    h.deliver("w-bill-2-c", h.sim.webhook("bill-2")).await;
    let (_, second) = h.close_now("close-0003").await;
    assert_eq!(second["purchasesCents"], "700");
    assert_eq!(second["statementSeq"], 2);
    let list = h.statement_list().await;
    assert_eq!(list["statements"].as_array().unwrap().len(), 2);
    // Statement lines are sealed at rest.
    for row in h.store.all_card_records().await {
        if row.key.starts_with("stmt:") || row.key.starts_with("post:") {
            let field = if row.key.starts_with("stmt:") {
                "lines"
            } else {
                "line"
            };
            assert_eq!(row.record[field]["alg"], "A256GCM", "{}", row.key);
        }
    }
    h.assert_no_pan().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn forced_captures_are_billed_flagged_and_credits_carry_forward() {
    let h = Harness::new().await;
    // A force post (no authorization) is billed as a flagged adjustment.
    h.sim.put_transaction(json!({"token": "fp-1", "card_token": h.card_token, "status": "SETTLED", "result": "APPROVED", "merchant": {"acceptor_id": "DEMO-DATAAPI", "descriptor": "FORCED", "mcc": "5734"}, "events": []}));
    h.sim
        .add_event("fp-1", "fp-1-c", "CLEARING", 1_000, "DEBIT");
    assert_eq!(h.deliver("w-fp-1", h.sim.webhook("fp-1")).await, 200);
    let (_, stmt) = h.close_now("close-fp-1").await;
    let lines = stmt["lines"].as_array().unwrap();
    assert_eq!(lines[0]["kind"], "adjustment_debit");
    assert_eq!(lines[0]["exception"], "forced_capture");
    assert_eq!(lines[0]["needsReview"], true);
    assert_eq!(
        stmt["totalCents"],
        (1_000 + fee_cents(1_000, 50)).to_string()
    );
    assert_eq!(h.outstanding(), 1_000 + fee_cents(1_000, 50));
    // Activity exposes the exception's event reference to the owner only.
    let (_, page) = h
        .owner("GET", &format!("/v1/cards/{}/activity", h.card_id), None)
        .await;
    let row = page["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["rowId"] == "asa:fp-1")
        .unwrap()
        .clone();
    let expected_id = program::hex(&program::event_id_hash(
        program::ISSUER_LITHIC_SANDBOX,
        "fp-1-c",
    ));
    assert_eq!(row["eventIdHash"], expected_id);
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
            .all(|r| r.get("eventIdHash").is_none())
    );

    // A refund-only statement is a credit: nothing due, carried forward.
    h.sim.put_transaction(json!({"token": "ret-1", "card_token": h.card_token, "status": "SETTLED", "result": "APPROVED", "merchant": {"acceptor_id": "DEMO-DATAAPI", "descriptor": "DATA API CREDITS", "mcc": "5734"}, "events": []}));
    h.sim.add_event("ret-1", "ret-1-r", "RETURN", 400, "CREDIT");
    assert_eq!(h.deliver("w-ret-1", h.sim.webhook("ret-1")).await, 200);
    let (_, credit) = h.close_now("close-ret-1").await;
    let credit_total = 400 + fee_cents(400, 50) as i64;
    assert_eq!(credit["totalCents"], (-credit_total).to_string());
    assert_eq!(credit["amountDueCents"], "0");
    assert_eq!(credit["creditForwardCents"], credit_total.to_string());
    assert_eq!(credit["state"], "discharged");
    assert!(credit.get("payWith").is_none() || credit["payWith"].is_null());
    // The next statement applies the credit to the amount due.
    h.purchase("cf-1", 1_000, &[("cf-1-c", "CLEARING", 1_000, "DEBIT")])
        .await;
    let (_, next) = h.close_now("close-cf-1").await;
    assert_eq!(next["carriedCreditCents"], credit_total.to_string());
    assert_eq!(next["amountDueCents"], (1_005 - credit_total).to_string());
}

// --------------------------------------------------------------- repayment

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_mint_network_amount_recipient_reference_or_payer_never_closes_a_statement() {
    let h = Harness::new().await;
    h.purchase("rp-1", 2_000, &[("rp-1-c", "CLEARING", 2_000, "DEBIT")])
        .await;
    let (_, stmt) = h.close_now("close-rp-1").await;
    let due = 2_000 + fee_cents(2_000, 50);
    assert_eq!(stmt["amountDueCents"], due.to_string());
    let before = h.outstanding();

    let other_digest = [9u8; 32];
    let other_mint = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
    let other_recipient = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
    let cases: Vec<(&str, Payment, &str, &[&str])> = vec![
        (
            "amount",
            Payment {
                mandate_seed: seed(1),
                base_units: Some(due * 10_000 - 1),
                ..Default::default()
            },
            "devnet",
            &["amount"],
        ),
        (
            "mint",
            Payment {
                mandate_seed: seed(2),
                mint: Some(other_mint),
                ..Default::default()
            },
            "devnet",
            &["mint"],
        ),
        (
            "recipient",
            Payment {
                mandate_seed: seed(3),
                recipient: Some(other_recipient),
                ..Default::default()
            },
            "devnet",
            &["recipient"],
        ),
        (
            "reference",
            Payment {
                mandate_seed: seed(4),
                invoice: Some(other_digest),
                ..Default::default()
            },
            "devnet",
            &["reference"],
        ),
        (
            "network",
            Payment {
                mandate_seed: seed(5),
                ..Default::default()
            },
            "mainnet-beta",
            &["network"],
        ),
        (
            "payer",
            Payment {
                mandate_seed: seed(6),
                payer: Some(addr([3; 32])),
                ..Default::default()
            },
            "devnet",
            &["payer"],
        ),
        (
            // A direct execute_payment by an ordinary agent, not the card's
            // repay_statement: record_repayment on PER would refuse it.
            "agent",
            Payment {
                mandate_seed: seed(9),
                agent: Some(addr([4; 32])),
                ..Default::default()
            },
            "devnet",
            &["agent"],
        ),
    ];
    for (name, payment, cluster, expected) in cases {
        let (receipt, mandate) = h.pay(&stmt, payment);
        let (status, body) = h.repay(&stmt, &receipt, &mandate, cluster).await;
        assert_eq!(status, 200, "{name}: {body}");
        assert_eq!(body["state"], "repayment_mismatch", "{name}: {body}");
        let reported: Vec<&str> = body["mismatch"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        for field in expected {
            assert!(reported.contains(field), "{name}: {reported:?}");
        }
        // Still payable, PER untouched, no partner booking.
        assert_eq!(
            body["statement"]["amountDueCents"],
            due.to_string(),
            "{name}"
        );
        assert!(body["statement"]["payWith"].is_object(), "{name}");
        assert_eq!(h.outstanding(), before, "{name}");
        assert_eq!(h.program_count("record_repayment"), 0, "{name}");
    }
    assert!(
        h.store
            .all_card_records()
            .await
            .iter()
            .all(|r| !r.key.starts_with("partner:"))
    );
    // A receipt that is not finalized yet changes nothing.
    let (receipt, mandate) = h.pay(
        &stmt,
        Payment {
            mandate_seed: seed(7),
            skip_receipt: true,
            ..Default::default()
        },
    );
    let (status, body) = h.repay(&stmt, &receipt, &mandate, "devnet").await;
    assert_eq!(
        (status, body["code"].as_str()),
        (409, Some("receipt_not_finalized"))
    );
    // Unknown request fields and non-addresses are refused outright.
    let (status, _) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/statements/{}/repayment", h.card_id, stmt["statementId"].as_str().unwrap()),
            Some(json!({"receiptPda": receipt, "mandatePda": mandate, "cluster": "devnet", "override": true})),
        )
        .await;
    assert_eq!(status, 400);
    // Agents can never submit a repayment.
    let (status, _) = h
        .call(
            "POST",
            &format!(
                "/v1/cards/{}/statements/{}/repayment",
                h.card_id,
                stmt["statementId"].as_str().unwrap()
            ),
            Some(AGENT_TOKEN),
            Some(json!({"receiptPda": receipt, "mandatePda": mandate, "cluster": "devnet"})),
        )
        .await;
    assert_eq!(status, 403);

    // The exact receipt discharges it: verified, partner confirmed, PER booked.
    let (receipt, mandate) = h.pay(
        &stmt,
        Payment {
            mandate_seed: seed(8),
            ..Default::default()
        },
    );
    let (status, body) = h.repay(&stmt, &receipt, &mandate, "devnet").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "discharged", "{body}");
    let view = &body["statement"];
    assert_eq!(view["repayment"]["receiptPda"], receipt.as_str());
    assert_eq!(view["repayment"]["commitment"], "finalized");
    assert_eq!(
        view["repayment"]["amountBaseUnits"],
        (due * 10_000).to_string()
    );
    assert_eq!(view["partner"]["simulated"], true);
    assert_eq!(view["partner"]["label"], "Simulated partner ledger");
    let states: Vec<&str> = view["history"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["state"].as_str().unwrap())
        .collect();
    assert_eq!(
        states,
        vec![
            "closed",
            "repayment_mismatch",
            "repayment_mismatch",
            "repayment_mismatch",
            "repayment_mismatch",
            "repayment_mismatch",
            "repayment_mismatch",
            "repayment_mismatch",
            "repayment_observed",
            "partner_confirmed",
            "discharged"
        ]
    );
    assert_eq!(h.outstanding(), before - due);
    assert_eq!(h.program_count("record_repayment"), 1);
    let digest: [u8; 32] = program::unhex(stmt["digest"].as_str().unwrap()).unwrap();
    assert!(
        h.per
            .with_card(&h.policy, |c| c.policy.repayments.contains(&digest))
    );
    // Every chain read for the decision was at finalized commitment.
    assert!(
        h.commitments
            .lock()
            .unwrap()
            .iter()
            .all(|c| c == "finalized")
    );
    // Idempotent for the same receipt; another receipt is refused.
    let (status, again) = h.repay(&stmt, &receipt, &mandate, "devnet").await;
    assert_eq!((status, again["state"].as_str()), (200, Some("discharged")));
    assert_eq!(h.program_count("record_repayment"), 1);
    let (other, other_mandate) = h.pay(
        &stmt,
        Payment {
            mandate_seed: seed(9),
            ..Default::default()
        },
    );
    assert_eq!(
        h.repay(&stmt, &other, &other_mandate, "devnet").await.0,
        409
    );
    h.assert_no_pan().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn discharge_waits_for_the_partner_and_for_per_then_cron_finishes_it() {
    let h = Harness::new().await;
    h.purchase("dw-1", 1_000, &[("dw-1-c", "CLEARING", 1_000, "DEBIT")])
        .await;
    let (_, stmt) = h.close_now("close-dw-1").await;
    let before = h.outstanding();
    let (receipt, mandate) = h.pay(
        &stmt,
        Payment {
            mandate_seed: seed(1),
            ..Default::default()
        },
    );
    // PER unreachable after verification: partner confirms, no discharge yet.
    h.per.knobs.lock().unwrap().outage = true;
    let (status, body) = h.repay(&stmt, &receipt, &mandate, "devnet").await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["state"], "partner_confirmed");
    assert_eq!(h.outstanding(), before);
    h.per.knobs.lock().unwrap().outage = false;
    h.cron().await;
    let list = h.statement_list().await;
    assert_eq!(list["statements"][0]["state"], "discharged");
    assert_eq!(h.outstanding(), before - 1_005);

    // A receipt that is not on chain (yet) leaves the statement payable.
    h.purchase("dw-2", 600, &[("dw-2-c", "CLEARING", 600, "DEBIT")])
        .await;
    let (_, stmt2) = h.close_now("close-dw-2").await;
    let (receipt2, mandate2) = h.pay(
        &stmt2,
        Payment {
            mandate_seed: seed(2),
            ..Default::default()
        },
    );
    h.chain.lock().unwrap().remove(&receipt2);
    let (status, body) = h.repay(&stmt2, &receipt2, &mandate2, "devnet").await;
    assert_eq!(
        (status, body["code"].as_str()),
        (409, Some("receipt_not_finalized"))
    );
    assert_eq!(h.statement_list().await["statements"][0]["state"], "closed");
}

// ---------------------------------------------------------------- rollover

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rollover_closes_the_period_and_never_erases_debt_holds_or_unpaid_statements() {
    let h = Harness::new().await;
    h.purchase("ro-1", 2_000, &[("ro-1-c", "CLEARING", 2_000, "DEBIT")])
        .await;
    h.purchase("ro-2", 1_000, &[]).await; // open $10 hold
    // Before the period ends the cron never rolls.
    h.cron().await;
    assert_eq!(h.program_count("roll_period"), 0);
    let outstanding = h.outstanding();
    assert_eq!(outstanding, 2_010);
    h.per.with_card(&h.policy, |c| {
        c.period.index = 1;
        c.period.end = (now_ms() / 1000) as i64 - 5;
    });
    h.cron().await;
    assert_eq!(h.program_count("roll_period"), 1);
    let (captured, reserved, index) = h.per.with_card(&h.policy, |c| {
        (c.period.captured, c.period.reserved, c.period.index)
    });
    // Allowance reset; the hold and the debt carried over.
    assert_eq!((captured, reserved, index), (0, 1_000, 2));
    assert_eq!(h.outstanding(), outstanding);
    let list = h.statement_list().await;
    let first = list["statements"][0].clone();
    assert_eq!(first["closeKind"], "period_end");
    assert_eq!(first["periodIndex"], 1);
    assert_eq!(first["totalCents"], "2010");
    assert_eq!(first["state"], "closed");
    // A repeated cron pass does not roll or bill twice.
    h.cron().await;
    assert_eq!(h.program_count("roll_period"), 1);
    assert_eq!(
        h.statement_list().await["statements"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // The held purchase clears in the new period: next statement, not the first.
    h.sim
        .add_event("ro-2", "ro-2-c", "CLEARING", 1_000, "DEBIT");
    h.deliver("w-ro-2-c", h.sim.webhook("ro-2")).await;
    h.per
        .with_card(&h.policy, |c| c.period.end = (now_ms() / 1000) as i64 - 5);
    h.cron().await;
    let list = h.statement_list().await;
    let statements = list["statements"].as_array().unwrap();
    assert_eq!(statements.len(), 2);
    assert_eq!(statements[0]["periodIndex"], 2);
    assert_eq!(statements[0]["totalCents"], "1005");
    // The unpaid first statement is still payable, unchanged.
    assert_eq!(statements[1]["state"], "closed");
    assert_eq!(statements[1]["amountDueCents"], "2010");
    assert_eq!(h.outstanding(), 2_010 + 1_005);
    // Paying the older statement clears only its own exposure.
    let (receipt, mandate) = h.pay(
        &statements[1],
        Payment {
            mandate_seed: seed(1),
            ..Default::default()
        },
    );
    let (_, body) = h.repay(&statements[1], &receipt, &mandate, "devnet").await;
    assert_eq!(body["state"], "discharged", "{body}");
    assert_eq!(h.outstanding(), 1_005);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_interrupted_close_resumes_exactly_once() {
    let h = Harness::new().await;
    h.purchase("ic-1", 900, &[("ic-1-c", "CLEARING", 900, "DEBIT")])
        .await;
    // Phase 1 happened (seq reserved, cut fixed) and the process died.
    let cut = rfc3339(now_ms());
    h.cards
        .update_card(&h.card_id, |record| {
            record["billing"] = json!({"nextSeq": 2, "closing": {"seq": 1, "kind": "interim", "periodIndex": 1, "cut": cut}});
        })
        .await
        .unwrap();
    // A posting after the cut must not be pulled into the resumed statement.
    tokio::time::sleep(Duration::from_millis(5)).await;
    h.purchase("ic-2", 300, &[("ic-2-c", "CLEARING", 300, "DEBIT")])
        .await;
    h.cron().await;
    let list = h.statement_list().await;
    let statements = list["statements"].as_array().unwrap();
    assert_eq!(statements.len(), 1);
    assert_eq!(statements[0]["statementSeq"], 1);
    assert_eq!(statements[0]["purchasesCents"], "900");
    assert_eq!(list["open"]["lineCount"], 1);
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    assert!(card.record["billing"]["closing"].is_null());
    let (_, next) = h.close_now("close-ic-2").await;
    assert_eq!(
        (
            next["statementSeq"].as_u64(),
            next["purchasesCents"].as_str()
        ),
        (Some(2), Some("300"))
    );
}

// ---------------------------------------------------------------- recovery

#[allow(deprecated)]
fn decompile(tx_b64: &str) -> Vec<solana_message::Instruction> {
    use base64::Engine;
    let tx: solana_transaction::versioned::VersionedTransaction = wincode::deserialize(
        &base64::engine::general_purpose::STANDARD
            .decode(tx_b64)
            .unwrap(),
    )
    .unwrap();
    let keys = tx.message.static_account_keys().to_vec();
    tx.message
        .instructions()
        .iter()
        .map(|ix| solana_message::Instruction {
            program_id: keys[ix.program_id_index as usize],
            accounts: ix
                .accounts
                .iter()
                .map(|i| {
                    let i = *i as usize;
                    solana_message::AccountMeta {
                        pubkey: keys[i],
                        is_signer: tx.message.is_signer(i),
                        is_writable: tx.message.is_maybe_writable(i, None),
                    }
                })
                .collect(),
            data: ix.data.clone(),
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn lost_private_state_freezes_at_once_and_resumes_only_after_cosigned_restore() {
    let h = Harness::new().await;
    h.purchase("rc-1", 2_000, &[("rc-1-c", "CLEARING", 1_500, "DEBIT")])
        .await;
    // Fresh snapshot of the healthy state.
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    reconcile::snapshot(&h.cards, &card).await.unwrap();
    // After the snapshot: one more capture booked (it must survive the restore).
    h.sim.add_event("rc-1", "rc-1-c2", "CLEARING", 500, "DEBIT");
    h.deliver("w-rc-1-c2", h.sim.webhook("rc-1")).await;
    let before = h
        .per
        .with_card(&h.policy, |c| (c.period.captured, c.policy.outstanding));
    assert_eq!(before, (2_000, 2_000 + 7 + 2));

    // The rollup loses the card: reads null, writes fail.
    h.per.knobs.lock().unwrap().lost = true;
    h.cron().await;
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    assert_eq!(card.record["recovery"]["state"], "recovery_frozen");
    assert_eq!(card.record["recovery"]["reason"], "state_not_visible");
    assert_eq!(
        h.sim.card_state(&h.card_token).state,
        "PAUSED",
        "issuer paused first"
    );
    assert!(h.cards.metrics.get("stale_per_reads") >= 1);
    assert_eq!(h.cards.metrics.get("recovery_detections"), 1);
    // No statement work runs on a lost card.
    assert_eq!(h.program_count("roll_period"), 0);
    // A second pass does not re-detect.
    h.cron().await;
    assert_eq!(h.cards.metrics.get("recovery_detections"), 1);

    // The validator comes back with the card recovery-frozen (state as of an
    // older commit: counters behind).
    h.per.knobs.lock().unwrap().lost = false;
    h.per.with_card(&h.policy, |c| {
        c.policy.recovery = 1;
        c.policy.frozen = true;
        c.period.captured = 0;
        c.policy.outstanding = 0;
    });
    // The card view shows recovery; the restore review never zeroes counters.
    let (status, review) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/recovery/restore", h.card_id),
            Some(json!({"clientOperationId": "restore-0001"})),
        )
        .await;
    assert_eq!(status, 200, "{review}");
    assert_eq!(review["state"], "review_required");
    let restore = &review["reconReport"]["restore"];
    assert_eq!(
        restore["capturedCents"], "2000",
        "snapshot + post-snapshot capture: {restore}"
    );
    assert_eq!(restore["statementOutstandingCents"], "2009");
    assert_eq!(restore["postingsSinceSnapshot"], 1);
    let (_, view) = h
        .owner("GET", &format!("/v1/cards/{}", h.card_id), None)
        .await;
    assert_eq!(view["recovery"]["state"], "recovery_frozen");
    assert_eq!(
        view["recovery"]["report"]["digest"],
        review["reconReportDigest"]
    );
    assert!(
        view["recovery"]["report"]["numbers"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["cents"] == "2009")
    );
    assert!(view["attestation"]["mode"].is_string());
    // Authorizations decline while in recovery.
    h.intent("demo-approved", "500").await;
    let (_, result) = h.asa("rc-2", 500, "demo-approved", "AUTHORIZATION").await;
    assert_ne!(result, "APPROVED");

    // Reviewed digest → co-signed restore for the owner.
    let (status, ready) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/recovery/restore", h.card_id),
            Some(json!({"clientOperationId": "restore-0002", "reconReportDigest": review["reconReportDigest"]})),
        )
        .await;
    assert_eq!(status, 200, "{ready}");
    assert_eq!(ready["state"], "ready_to_sign");
    assert_eq!(ready["restoreArgs"]["capturedCents"], "2000");
    assert_eq!(ready["restoreArgs"]["policy"]["budgetCents"], "5000");
    assert_eq!(
        ready["restoreArgs"]["reconDigest"],
        review["reconReportDigest"]
    );
    assert_eq!(ready["coSignedBy"], h.per.authorizer().to_string());
    // The owner signs and sends it (their own PER session); the model applies it.
    let outcome = h
        .per
        .submit(
            decompile(ready["restoreTx"].as_str().unwrap()),
            std::time::Instant::now() + Duration::from_secs(2),
        )
        .await;
    assert!(
        matches!(outcome, tee::TxOutcome::Confirmed { .. }),
        "{outcome:?}"
    );
    let restored = h.per.with_card(&h.policy, |c| {
        (
            c.period.captured,
            c.policy.outstanding,
            c.policy.recovery,
            c.policy.frozen,
        )
    });
    assert_eq!(
        restored,
        (2_000, 2_009, 2, true),
        "restored from records, never reset"
    );
    // Issuer reconciliation, then the owner's confirm_reconciled.
    let (status, recon) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/recovery/reconcile", h.card_id),
            Some(json!({"clientOperationId": "reconcile-0001"})),
        )
        .await;
    assert_eq!(status, 200, "{recon}");
    assert_eq!(recon["state"], "reconciled_pending_owner_confirm");
    let outcome = h
        .per
        .submit(
            decompile(recon["confirmReconciledTx"].as_str().unwrap()),
            std::time::Instant::now() + Duration::from_secs(2),
        )
        .await;
    assert!(
        matches!(outcome, tee::TxOutcome::Confirmed { .. }),
        "{outcome:?}"
    );
    h.cron().await;
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    assert_eq!(card.record["recovery"]["state"], "restored");
    // Still frozen: nothing resumes until the owner unfreezes.
    assert!(h.per.with_card(&h.policy, |c| c.policy.frozen));
    h.intent("demo-approved", "500").await;
    let (_, result) = h.asa("rc-3", 500, "demo-approved", "AUTHORIZATION").await;
    assert_ne!(result, "APPROVED");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_ledger_that_went_backwards_is_detected_and_recovery_frozen_on_per() {
    let h = Harness::new().await;
    h.purchase("lr-1", 1_000, &[("lr-1-c", "CLEARING", 1_000, "DEBIT")])
        .await;
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    reconcile::snapshot(&h.cards, &card).await.unwrap();
    // Stale state: the ledger is behind the last snapshot.
    h.per.with_card(&h.policy, |c| c.policy.ledger_seq = 0);
    h.cron().await;
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    assert_eq!(card.record["recovery"]["reason"], "ledger_regressed");
    assert_eq!(card.record["recovery"]["perRecoveryFreeze"], "confirmed");
    assert_eq!(h.per.with_card(&h.policy, |c| c.policy.recovery), 1);
    assert_eq!(h.cards.metrics.get("recovery_freezes"), 1);
    // set_policy-style resets are impossible here: restore needs the co-signer.
    let owner = h.owner_addr();
    let period = h.per.with_card(&h.policy, |c| c.period_pda);
    let zeros = program::RestoreArgs {
        policy: program::PolicyArgs {
            budget_cents: 5_000,
            max_purchase_cents: 4_000,
            max_purchases_per_period: 0,
            period_seconds: 86_400,
            merchant_id_hashes: vec![],
            mccs: vec![],
            expires_at: 0,
            recurring_allowed: false,
            fee_bps: 50,
            authorizer: [0; 32],
        },
        period_index: 1,
        captured_cents: 0,
        reserved_cents: 0,
        refunded_cents: 0,
        purchases_count: 0,
        exception_cents: 0,
        statement_outstanding_cents: 0,
        ledger_head: [0; 32],
        ledger_seq: 0,
        recon_digest: [1; 32],
    };
    let stranger = addr([5; 32]);
    let outcome = h
        .per
        .submit(
            vec![program::restore(
                &owner, &stranger, &h.policy, &period, &zeros,
            )],
            std::time::Instant::now() + Duration::from_secs(1),
        )
        .await;
    assert!(
        matches!(outcome, tee::TxOutcome::ProgramError { code: 6000, .. }),
        "{outcome:?}"
    );
}

// ------------------------------------------------------- privacy hygiene

/// Distinctive policy values: if any of these strings shows up in plaintext
/// anywhere ChainPay keeps or emits data, a policy value leaked.
const BUDGET: u64 = 437_219;
const MAX_PURCHASE: u64 = 91_733;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn plaintext_scanner_finds_no_policy_values_or_card_numbers_anywhere() {
    let h = Harness::new().await;
    h.per.with_card(&h.policy, |c| {
        c.policy.budget = BUDGET;
        c.policy.max_purchase = MAX_PURCHASE;
        c.policy.max_count = 37;
        c.policy.mccs = vec![5734];
        c.policy.fee_bps = 73;
    });
    // Exercise every path that touches policy: activation mirror, checkout,
    // ASA, events, snapshot, statement close, repayment, recovery report.
    h.owner(
        "POST",
        &format!("/v1/cards/{}/activate", h.card_id),
        Some(json!({"clientOperationId": "activate-0002", "expectedPolicyVersion": 1})),
    )
    .await;
    h.purchase("pt-1", 2_000, &[("pt-1-c", "CLEARING", 2_000, "DEBIT")])
        .await;
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    reconcile::snapshot(&h.cards, &card).await.unwrap();
    let (_, stmt) = h.close_now("close-pt-1").await;
    let (receipt, mandate) = h.pay(
        &stmt,
        Payment {
            mandate_seed: seed(1),
            ..Default::default()
        },
    );
    let (_, paid) = h.repay(&stmt, &receipt, &mandate, "devnet").await;
    assert_eq!(paid["state"], "discharged", "{paid}");
    h.cron().await;
    h.call(
        "GET",
        &format!("/v1/cards/{}/activity", h.card_id),
        Some(AGENT_TOKEN),
        None,
    )
    .await;
    h.call(
        "GET",
        &format!("/v1/cards/{}/statements", h.card_id),
        Some(AGENT_TOKEN),
        None,
    )
    .await;
    h.call("GET", "/internal/ops/cards/metrics", Some(CRON), None)
        .await;

    let merchant_hash = program::hex(&program::merchant_id_hash("DEMO-DATAAPI"));
    let needles: Vec<String> = vec![
        BUDGET.to_string(),
        MAX_PURCHASE.to_string(),
        merchant_hash.clone(),
        "budgetCents".into(),
        "maxPurchaseCents".into(),
        "merchantIdHashes".into(),
        "maxPurchasesPerPeriod".into(),
        "feeBps".into(),
        "\"mccs\"".into(),
        "\"mcc\"".into(),
        "DEMO-DATAAPI".into(),
    ];
    // 1. Convex rows: every plaintext column and record body (envelopes are
    //    opaque ciphertext), plus operation claims.
    let mut rows: Vec<String> = h
        .store
        .all_card_records()
        .await
        .iter()
        .map(|r| format!("{} {:?} {}", r.key, r.index, r.record))
        .collect();
    rows.extend(
        h.store
            .all_operation_claims()
            .await
            .iter()
            .map(|c| format!("{c:?}")),
    );
    // 2. Logs and traces (every connector log line this process emitted).
    let logs: Vec<String> = captured_logs().lock().unwrap().clone();
    // 3. Agent-facing responses and the ops metrics.
    let responses: Vec<String> = h.responses.lock().unwrap().clone();
    // 4. Public commits: what the program puts on the base layer is a hash
    //    root and counters-free metadata; Axum's checkpoint salts stay sealed.
    for (label, haystack) in [("convex", &rows), ("logs", &logs)] {
        for text in haystack {
            for needle in &needles {
                assert!(
                    !text.contains(needle.as_str()),
                    "{label} leaked {needle}: {}",
                    &text[..text.len().min(300)]
                );
            }
        }
    }
    for text in &responses {
        for needle in [
            BUDGET.to_string(),
            MAX_PURCHASE.to_string(),
            merchant_hash.clone(),
        ] {
            assert!(
                !text.contains(needle.as_str()),
                "response leaked {needle}: {}",
                &text[..text.len().min(300)]
            );
        }
    }
    // Every sensitive field on every row is an envelope.
    for row in h.store.all_card_records().await {
        for field in [
            "issuer",
            "label",
            "provider",
            "raw",
            "secret",
            "snapshot",
            "masterSalt",
            "lines",
            "line",
            "recoveryReport",
        ] {
            // `label` is the card's own name on registry rows; elsewhere it is
            // the fixed public "Simulated ..." label.
            if field == "label" && !row.key.starts_with("card:") {
                continue;
            }
            let value = &row.record[field];
            if !value.is_null() {
                assert_eq!(
                    value["alg"], "A256GCM",
                    "{} {field} must be encrypted",
                    row.key
                );
            }
        }
        // Index columns are opaque: no plaintext merchant hash in a match key.
        if let Some(reference) = &row.index.reference {
            assert!(!reference.contains(&merchant_hash), "{reference}");
        }
    }
    h.assert_no_pan().await;
}

#[test]
fn repository_fixtures_hold_no_card_numbers() {
    fn luhn(digits: &str) -> bool {
        let mut sum = 0;
        for (i, c) in digits.bytes().rev().enumerate() {
            let mut d = (c - b'0') as u32;
            if i % 2 == 1 {
                d *= 2;
                if d > 9 {
                    d -= 9;
                }
            }
            sum += d;
        }
        sum % 10 == 0
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let mut files = Vec::new();
    for dir in [
        "scripts/card-sim",
        "scripts/card-sim/scenarios",
        "backend/examples",
        "backend/src/connectors/card_issuer/testdata",
    ] {
        if let Ok(entries) = std::fs::read_dir(root.join(dir)) {
            files.extend(entries.flatten().map(|e| e.path()).filter(|p| p.is_file()));
        }
    }
    assert!(files.len() > 5, "fixtures not found");
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        let bytes = text.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i].is_ascii_digit() && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric()) {
                let start = i;
                while i < bytes.len() && bytes[i].is_ascii_digit() {
                    i += 1;
                }
                let run = &text[start..i];
                let boundary = i == bytes.len() || !bytes[i].is_ascii_alphanumeric();
                if (13..=19).contains(&run.len()) && boundary {
                    assert!(
                        !luhn(run),
                        "{} holds a card-number-like value",
                        file.display()
                    );
                }
            }
            i += 1;
        }
    }
}

// ---------------------------------------------------- telemetry and asks

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ops_metrics_report_latency_and_gauges_with_opaque_ids_only() {
    let h = Harness::new().await;
    h.purchase("mx-1", 1_000, &[]).await;
    h.asa("mx-2", 900, "demo-unapproved", "AUTHORIZATION").await;
    assert_eq!(
        h.call("GET", "/internal/ops/cards/metrics", None, None)
            .await
            .0,
        401
    );
    assert_eq!(
        h.call(
            "GET",
            "/internal/ops/cards/metrics",
            Some(ORIGIN_FREE_OWNER_TOKEN),
            None
        )
        .await
        .0,
        401
    );
    let (status, body) = h
        .call("GET", "/internal/ops/cards/metrics", Some(CRON), None)
        .await;
    assert_eq!(status, 200, "{body}");
    let process = &body["process"];
    assert!(process["authLatencyMs"]["p50"].is_u64());
    assert!(process["authLatencyMs"]["p99"].is_u64());
    assert_eq!(process["counters"]["asa_decisions"], 2);
    assert_eq!(process["counters"]["asa_approved"], 1);
    for gauge in [
        "unresolvedReservations",
        "unpairedCaptures",
        "repaymentMismatchesOpen",
        "freezesAwaitingIssuerAck",
        "cardsInRecovery",
    ] {
        assert!(body["gauges"][gauge].is_u64(), "{gauge}");
    }
    let text = body.to_string();
    assert!(
        !text.contains(&h.card_id) && !text.contains(&h.card_token) && !text.contains(&h.owner)
    );
    // The cron emits the same counters as one opaque log line.
    h.cron().await;
    let line = captured_logs()
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find(|l| l.starts_with("metrics "))
        .cloned()
        .unwrap();
    assert!(!line.contains(&h.card_id) && line.contains("authLatencyMs"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn owners_get_the_checkpoint_disclosure_key_and_nobody_else_does() {
    let h = Harness::new().await;
    // Activation scheduled checkpoint seq 1 and stored its salt sealed.
    let (status, body) = h
        .owner(
            "GET",
            &format!("/v1/cards/{}/disclosure-salt?seq=1", h.card_id),
            None,
        )
        .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["masterSalt"].as_str().unwrap().len(), 64);
    assert_eq!(body["seq"], "1");
    assert_eq!(body["commitment"]["state"], "pending");
    assert_eq!(
        h.call(
            "GET",
            &format!("/v1/cards/{}/disclosure-salt?seq=1", h.card_id),
            Some(AGENT_TOKEN),
            None
        )
        .await
        .0,
        403
    );
    assert_eq!(
        h.call(
            "GET",
            &format!("/v1/cards/{}/disclosure-salt?seq=1", h.card_id),
            Some(OTHER_TOKEN),
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        h.owner(
            "GET",
            &format!("/v1/cards/{}/disclosure-salt?seq=9", h.card_id),
            None
        )
        .await
        .0,
        404
    );
    assert_eq!(
        h.owner(
            "GET",
            &format!("/v1/cards/{}/disclosure-salt?seq=x", h.card_id),
            None
        )
        .await
        .0,
        400
    );
    // The salt is never stored or logged in the clear.
    let salt = body["masterSalt"].as_str().unwrap().to_owned();
    assert!(
        h.store
            .all_card_records()
            .await
            .iter()
            .all(|r| !r.record.to_string().contains(&salt))
    );
    assert!(
        captured_logs()
            .lock()
            .unwrap()
            .iter()
            .all(|l| !l.contains(&salt))
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn card_setup_transactions_go_through_the_existing_submit_route_exactly_as_prepared() {
    use base64::Engine;
    let h = Harness::new().await;
    let (status, prepared) = h
        .owner(
            "POST",
            "/v1/cards/prepare",
            Some(json!({"clientOperationId": "prepare-0001", "label": "Data API card"})),
        )
        .await;
    assert_eq!(status, 200, "{prepared}");
    let sign = |b64: &str, key: &ed25519_dalek::SigningKey| {
        let mut tx: solana_transaction::versioned::VersionedTransaction = wincode::deserialize(
            &base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap(),
        )
        .unwrap();
        program::sign_transaction(&mut tx, &[key]).unwrap();
        base64::engine::general_purpose::STANDARD.encode(program::serialize_transaction(&tx))
    };
    for (n, field) in ["initTx", "delegateTx", "escrowTopUpTx"].iter().enumerate() {
        let signed = sign(prepared[field].as_str().unwrap(), &h.owner_key);
        let (status, body) = h
            .owner("POST", "/v1/transactions/submit", Some(json!({"signed_transaction": signed, "idempotency_key": format!("card-setup-{n}")})))
            .await;
        assert_eq!(status, 200, "{field}: {body}");
    }
    // Anything else aimed at card_policy is refused: a different prefund...
    let owner = h.owner_addr();
    let card_id: [u8; 32] = program::unhex(prepared["cardId"].as_str().unwrap()).unwrap();
    let tampered = program::unsigned_transaction(
        &owner,
        &[program::init_card(&owner, &card_id, 1, &[0; 32], 1)],
        [1; 32],
    );
    let mut tampered = tampered;
    program::sign_transaction(&mut tampered, &[&h.owner_key]).unwrap();
    let wire =
        base64::engine::general_purpose::STANDARD.encode(program::serialize_transaction(&tampered));
    let (status, _) = h
        .owner(
            "POST",
            "/v1/transactions/submit",
            Some(json!({"signed_transaction": wire, "idempotency_key": "card-setup-bad"})),
        )
        .await;
    assert_eq!(status, 400);
    // ...or another owner's card.
    let (status, _) = h
        .call("POST", "/v1/transactions/submit", Some(OTHER_TOKEN), Some(json!({"signed_transaction": sign(prepared["initTx"].as_str().unwrap(), &h.owner_key), "idempotency_key": "card-setup-x"})))
        .await;
    assert_eq!(status, 400);
}

#[test]
fn digest_matches_a_hand_computed_canonical_form() {
    let t = statements::totals(&[], 0);
    let digest = statement_digest(&statements::DigestInput {
        card_id: "c",
        statement_seq: 1,
        period_index: 1,
        close_kind: "interim",
        closed_at: "a",
        due_at: "b",
        totals: &t,
        line_digests: vec![],
    });
    let canonical = r#"{"amountDueCents":"0","cardId":"c","carriedCreditCents":"0","closeKind":"interim","closedAt":"a","dueAt":"b","feeCents":"0","lineDigests":[],"periodIndex":1,"purchasesCents":"0","refundsCents":"0","statementSeq":1,"totalCents":"0","v":1}"#;
    use sha2::Digest;
    let expected = program::hex(&Sha256::digest(
        format!("chainpay-card-statement:v1\n{canonical}").as_bytes(),
    ));
    assert_eq!(digest, expected);
}

// ---------------------------------------------------- review regressions

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paying_statements_out_of_order_clears_all_exposure() {
    let h = Harness::new().await;
    h.purchase("oo-1", 2_000, &[("oo-1-c", "CLEARING", 2_000, "DEBIT")])
        .await;
    let (_, first) = h.close_now("close-oo-1").await;
    h.purchase("oo-2", 700, &[("oo-2-c", "CLEARING", 700, "DEBIT")])
        .await;
    let (_, second) = h.close_now("close-oo-2").await;
    assert_eq!(h.outstanding(), 2_010 + 703);
    let (r2, m2) = h.pay(
        &second,
        Payment {
            mandate_seed: seed(1),
            ..Default::default()
        },
    );
    assert_eq!(
        h.repay(&second, &r2, &m2, "devnet").await.1["state"],
        "discharged"
    );
    assert_eq!(h.outstanding(), 2_010);
    let (r1, m1) = h.pay(
        &first,
        Payment {
            mandate_seed: seed(2),
            ..Default::default()
        },
    );
    let (_, body) = h.repay(&first, &r1, &m1, "devnet").await;
    assert_eq!(body["state"], "discharged", "{body}");
    assert_eq!(body["statement"]["discharge"]["amountCents"], "2010");
    assert_eq!(h.outstanding(), 0, "no exposure left stranded on PER");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_carried_credit_alone_never_makes_empty_statements() {
    let h = Harness::new().await;
    h.sim.put_transaction(json!({"token": "cc-1", "card_token": h.card_token, "status": "SETTLED", "result": "APPROVED", "merchant": {"acceptor_id": "DEMO-DATAAPI", "descriptor": "DATA API CREDITS", "mcc": "5734"}, "events": []}));
    h.sim.add_event("cc-1", "cc-1-r", "RETURN", 400, "CREDIT");
    assert_eq!(h.deliver("w-cc-1", h.sim.webhook("cc-1")).await, 200);
    let (_, credit) = h.close_now("close-cc-1").await;
    assert_eq!(credit["creditForwardCents"], "402");
    assert_eq!(h.close_now("close-cc-2").await.0, 409);
    h.per.with_card(&h.policy, |c| {
        c.period.index = 1;
        c.period.end = (now_ms() / 1000) as i64 - 5;
    });
    h.cron().await;
    assert_eq!(h.program_count("roll_period"), 1);
    assert_eq!(
        h.statement_list().await["statements"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    assert_eq!(card.record["billing"]["carriedCreditCents"], "402");
    assert_eq!(card.record["billing"]["nextSeq"], 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_restore_that_never_landed_is_not_treated_as_recovered() {
    let h = Harness::new().await;
    h.purchase("nl-1", 1_000, &[("nl-1-c", "CLEARING", 1_000, "DEBIT")])
        .await;
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    reconcile::snapshot(&h.cards, &card).await.unwrap();
    h.per.knobs.lock().unwrap().lost = true;
    h.cron().await;
    h.per.knobs.lock().unwrap().lost = false;
    h.per.with_card(&h.policy, |c| {
        c.policy.recovery = 1;
        c.policy.frozen = true;
    });
    let (_, review) = h
        .owner(
            "POST",
            &format!("/v1/cards/{}/recovery/restore", h.card_id),
            Some(json!({"clientOperationId": "restore-0001"})),
        )
        .await;
    h.owner(
        "POST",
        &format!("/v1/cards/{}/recovery/restore", h.card_id),
        Some(json!({"clientOperationId": "restore-0002", "reconReportDigest": review["reconReportDigest"]})),
    )
    .await;
    // PER comes back at 0 with an older ledger, but the restore was never signed.
    h.per.with_card(&h.policy, |c| {
        c.policy.recovery = 0;
        c.policy.ledger_seq = 0;
    });
    h.cron().await;
    let card = h.cards.card(&h.card_id).await.unwrap().unwrap();
    assert_ne!(card.record["recovery"]["state"], "restored");
    assert!(recovery::in_recovery(&card) || card.record["recovery"]["state"] == "recovery_frozen");
    assert_eq!(
        h.close_now("close-nl-1").await.0,
        409,
        "no statement work while in recovery"
    );
}
