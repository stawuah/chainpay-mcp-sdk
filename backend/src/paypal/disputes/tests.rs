use super::*;
use crate::paypal::catalog::ItemInput;

fn purchase() -> Task {
    let p = Principal {
        id: "agent".into(),
        workspace: "workspace".into(),
        role: Role::Agent,
    };
    let a = Allowance::fixture("buyer", "ask_first");
    let mut t = Task::quote_purchase(
        &p,
        &a,
        "grocer",
        &[ItemInput {
            id: "oat-milk".into(),
            qty: 2,
        }],
    )
    .unwrap();
    t.captured = true;
    t.capture_id = Some("CAPTURE".into());
    t.units[0].state = UnitState::Delivered;
    t.units[0].result = Some(json!({"fulfilled_at":1_700_000_000u64}));
    t.units[1].state = UnitState::Failed;
    let c = t.purchase.as_mut().unwrap();
    c.policy.allowed = true;
    c.approval = Some("approved".into());
    c.approved_by = Some("buyer".into());
    t
}
fn provider_dispute(capture: &str) -> Value {
    json!({"dispute_id":"PP-D-1","create_time":"2026-10-20T10:00:00.000Z","update_time":"2026-10-21T10:00:00.000Z",
        "status":"WAITING_FOR_SELLER_RESPONSE","reason":"MERCHANDISE_OR_SERVICE_NOT_RECEIVED","dispute_life_cycle_stage":"INQUIRY",
        "seller_response_due_date":"2026-10-30T10:00:00.000Z",
        "dispute_amount":{"currency_code":"USD","value":"7.80"},
        "disputed_transactions":[{"seller_transaction_id":capture}]})
}

#[test]
fn provider_dispute_must_name_this_capture() {
    let task = purchase();
    let d = from_provider(&task, &provider_dispute("CAPTURE")).unwrap();
    assert_eq!(d.amount, Cents(780));
    assert_eq!(d.created_at, 1_792_490_400);
    assert_eq!(d.seller_response_due, Some(1_793_354_400));
    assert_eq!(d.evidence, "none");
    assert!(from_provider(&task, &provider_dispute("OTHER")).is_err());
    let mut wrong_currency = provider_dispute("CAPTURE");
    wrong_currency["dispute_amount"]["currency_code"] = "EUR".into();
    assert!(from_provider(&task, &wrong_currency).is_err());
    let mut unpaid = task.clone();
    unpaid.capture_id = None;
    assert!(from_provider(&unpaid, &provider_dispute("CAPTURE")).is_err());
}

#[test]
fn evidence_pack_is_deterministic_and_only_uses_stored_records() {
    let mut task = purchase();
    task.share_token = Some("tok".into());
    let d = from_provider(&task, &provider_dispute("CAPTURE")).unwrap();
    let a = Allowance::fixture("buyer", "ask_first");
    let pack = evidence_pack(&task, &d, Some(&a), "https://paypal.example.com");
    assert_eq!(pack["dispute_id"], "PP-D-1");
    assert_eq!(pack["capture_id"], "CAPTURE");
    assert_eq!(pack["allowance"]["name"], "Groceries");
    assert_eq!(pack["allowance"]["rule"], "allowance-rules-v1");
    assert_eq!(pack["approval"]["approved_by"], "buyer");
    assert_eq!(pack["delivery"][0]["state"], "delivered");
    assert_eq!(pack["delivery"][0]["delivered_at"], 1_700_000_000u64);
    assert_eq!(pack["delivery"][1]["state"], "failed");
    assert_eq!(pack["refunds"].as_array().unwrap().len(), 0);
    assert_eq!(
        pack["public_receipt_url"],
        "https://paypal.example.com/paypal/receipt/tok"
    );
    let notes = pack["notes"].as_str().unwrap();
    assert!(notes.contains("Groceries"));
    assert!(notes.contains("1 were marked delivered and 1 failed"));
    assert!(notes.chars().count() <= 2000);
    assert_eq!(pack["digest"].as_str().unwrap().len(), 64);
    let again = evidence_pack(&task, &d, Some(&a), "https://paypal.example.com");
    assert_eq!(again, pack);
    // Anything the pack says changes its digest.
    task.units[1].state = UnitState::Delivered;
    let changed = evidence_pack(&task, &d, Some(&a), "https://paypal.example.com");
    assert_ne!(changed["digest"], pack["digest"]);
    // The private inputs never leak through the public receipt digest path.
    assert!(!pack.to_string().contains("quote_digest"));
}

#[test]
fn ordinary_checkout_dispute_does_not_invent_allowance_authorization() {
    let mut task = purchase();
    task.purchase = None;
    let d = from_provider(&task, &provider_dispute("CAPTURE")).unwrap();
    let pack = evidence_pack(&task, &d, None, "https://paypal.example.com");
    let notes = pack["notes"].as_str().unwrap();
    assert!(!notes.contains("allowance"));
    assert!(!notes.contains("pre-approved"));
    assert!(notes.contains("captured as CAPTURE"));
}
