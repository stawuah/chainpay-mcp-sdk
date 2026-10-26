use super::*;

fn actor(role: Role, id: &str) -> Principal {
    Principal {
        id: id.into(),
        workspace: "workspace".into(),
        role,
    }
}
fn usage(spent: u64, today: u32, last: Option<u64>) -> Usage {
    Usage {
        spent: Cents(spent),
        purchases_today: today,
        last_purchase_at: last,
    }
}

#[test]
fn every_rule_has_a_reason_code_and_the_first_failure_wins() {
    let now = domain::now();
    let base = Allowance::fixture("buyer", "agent_pays");
    let agent = actor(Role::Agent, "agent");
    let ok = check(
        &base,
        &agent,
        "grocer",
        Cents(1000),
        &usage(0, 0, None),
        now,
    );
    assert!(ok.allowed);
    assert_eq!(ok.reason_code, None);
    assert_eq!(ok.rule, RULE);
    assert_eq!(ok.checks.len(), 10);
    assert!(ok.checks.iter().all(|c| c.allowed));

    let mut paused = base.clone();
    paused.status = "Paused".into();
    let mut expired = base.clone();
    expired.expires_at = now - 1;
    let mut pinned = base.clone();
    pinned.agent = Some("other-agent".into());
    let mut no_vault = base.clone();
    no_vault.vault.payment_token_id = None;
    let mut cooled = base.clone();
    cooled.cooldown_seconds = 600;
    let mut scoped = base.clone();
    scoped.merchants.push("tours".into());
    scoped.categories = vec!["grocery".into()];
    let cases: Vec<(&Allowance, &Principal, &str, u64, Usage, &str)> = vec![
        (
            &paused,
            &agent,
            "grocer",
            1000,
            usage(0, 0, None),
            "allowance_not_active",
        ),
        (
            &expired,
            &agent,
            "grocer",
            1000,
            usage(0, 0, None),
            "allowance_expired",
        ),
        (
            &pinned,
            &agent,
            "grocer",
            1000,
            usage(0, 0, None),
            "agent_not_allowed",
        ),
        (
            &base,
            &agent,
            "tours",
            1000,
            usage(0, 0, None),
            "merchant_not_allowed",
        ),
        (
            &scoped,
            &agent,
            "tours",
            1000,
            usage(0, 0, None),
            "category_not_allowed",
        ),
        (
            &base,
            &agent,
            "grocer",
            2001,
            usage(0, 0, None),
            "per_purchase_cap",
        ),
        (
            &base,
            &agent,
            "grocer",
            1000,
            usage(4500, 0, None),
            "total_cap",
        ),
        (
            &base,
            &agent,
            "grocer",
            1000,
            usage(0, 5, None),
            "max_per_day",
        ),
        (
            &cooled,
            &agent,
            "grocer",
            1000,
            usage(0, 1, Some(now - 30)),
            "cooldown",
        ),
        (
            &no_vault,
            &agent,
            "grocer",
            1000,
            usage(0, 0, None),
            "vault_not_ready",
        ),
    ];
    for (a, p, merchant, amount, u, code) in cases {
        let policy = check(a, p, merchant, Cents(amount), &u, now);
        assert!(!policy.allowed, "{code}");
        assert_eq!(policy.reason_code.as_deref(), Some(code));
        assert_eq!(
            policy.checks.iter().filter(|c| !c.allowed).count(),
            1,
            "{code}"
        );
    }
    // Paused and expired at once: status is reported first.
    let mut both = paused.clone();
    both.expires_at = now - 1;
    assert_eq!(
        check(&both, &agent, "grocer", Cents(1), &usage(0, 0, None), now)
            .reason_code
            .as_deref(),
        Some("allowance_not_active")
    );
    // The owning buyer is never blocked by the agent pin; exactly at the caps is fine.
    let buyer = actor(Role::Buyer, "buyer");
    let edge = check(
        &pinned,
        &buyer,
        "grocer",
        Cents(2000),
        &usage(3000, 4, Some(now)),
        now,
    );
    assert!(edge.allowed, "{:?}", edge.reason_code);
    let agent_pinned = check(
        &pinned,
        &actor(Role::Agent, "other-agent"),
        "grocer",
        Cents(1),
        &usage(0, 0, None),
        now,
    );
    assert!(agent_pinned.allowed);
    // Another buyer in the workspace cannot spend this one's allowance.
    let other_buyer = check(
        &base,
        &actor(Role::Buyer, "someone-else"),
        "grocer",
        Cents(1),
        &usage(0, 0, None),
        now,
    );
    assert_eq!(
        other_buyer.reason_code.as_deref(),
        Some("agent_not_allowed")
    );
    let cents = serde_json::to_value(&edge).unwrap();
    assert_eq!(cents["checks"][5]["rule"], "per_purchase_cap");
    assert_eq!(cents["checks"][5]["limit_cents"], 2000);
    assert_eq!(cents["checks"][5]["observed_cents"], 2000);
    assert!(cents["checks"][0].get("limit_cents").is_none());
}

#[test]
fn vault_status_follows_the_stored_tokens() {
    let mut a = Allowance::fixture("buyer", "ask_first");
    assert_eq!(a.vault.status(), "ready");
    a.vault.payment_token_id = None;
    assert_eq!(a.vault.status(), "none");
    a.vault.approval_url = Some("https://www.sandbox.paypal.com/agreements/approve?x".into());
    assert_eq!(a.vault.status(), "pending_approval");
    assert!(
        approve_link(
            &json!({"links":[{"rel":"approve","href":"https://www.sandbox.paypal.com/x"}]})
        )
        .unwrap()
        .is_some()
    );
    assert!(
        approve_link(&json!({"links":[{"rel":"approve","href":"https://evil.example/x"}]}))
            .is_err()
    );
    assert!(approve_link(&json!({"links":[]})).unwrap().is_none());
}

#[test]
fn categories_scope_by_merchant_kind_and_say_why() {
    let now = domain::now();
    let mut a = Allowance::fixture("buyer", "agent_pays");
    a.merchants = vec!["grocer".into(), "tours".into()];
    let agent = actor(Role::Agent, "agent");
    // No categories: any kind the merchant list allows.
    assert!(check(&a, &agent, "tours", Cents(100), &usage(0, 0, None), now).allowed);
    a.categories = vec!["grocery".into(), "print".into()];
    let ok = check(&a, &agent, "grocer", Cents(100), &usage(0, 0, None), now);
    assert!(ok.allowed);
    let refused = check(&a, &agent, "tours", Cents(100), &usage(0, 0, None), now);
    assert_eq!(refused.reason_code.as_deref(), Some("category_not_allowed"));
    let row = refused
        .checks
        .iter()
        .find(|c| c.rule == "category")
        .unwrap();
    assert!(!row.allowed);
    assert_eq!(
        row.observed.as_deref(),
        Some("booking is not in grocery, print")
    );
}

#[test]
fn ask_above_asks_only_over_the_threshold() {
    let mut a = Allowance::fixture("buyer", "ask_above");
    a.ask_above_cents = Cents(1000);
    assert!(!a.needs_approval(Cents(999)));
    assert!(!a.needs_approval(Cents(1000)));
    assert!(a.needs_approval(Cents(1001)));
    assert!(Allowance::fixture("buyer", "ask_first").needs_approval(Cents(1)));
    assert!(!Allowance::fixture("buyer", "agent_pays").needs_approval(Cents(1_000_000)));
}

#[test]
fn records_written_before_threshold_and_categories_still_decode() {
    let mut old = json!(Allowance::fixture("buyer", "ask_first"));
    for field in ["ask_above_cents", "categories"] {
        old.as_object_mut().unwrap().remove(field);
    }
    old["vault"].as_object_mut().unwrap().remove("delete");
    let a = decode(old).unwrap();
    assert_eq!(a.ask_above_cents, Cents(0));
    assert!(a.categories.is_empty());
    assert!(a.vault.delete.is_none());
}

#[test]
fn confirmed_refunds_carry_their_own_partial_amounts() {
    use crate::paypal::{catalog::ItemInput, resolution::Refund};
    let p = actor(Role::Buyer, "buyer");
    let a = Allowance::fixture("buyer", "agent_pays");
    let items = [ItemInput {
        id: "coffee-beans".into(),
        qty: 1,
    }];
    let mut t = Task::quote_purchase(&p, &a, "grocer", &items).unwrap();
    assert!(confirmed_refunds(&t).is_empty());
    t.refund_id = Some("REFUND-A".into());
    t.refund_amount = Cents(400);
    // Not confirmed yet: nothing to give back.
    assert!(confirmed_refunds(&t).is_empty());
    t.refund_confirmed = true;
    let pending = Refund {
        request_id: "r".into(),
        bindings: vec![],
        reason: "late".into(),
        amount: Cents(250),
        digest: "d".into(),
        proposed_by: "m".into(),
        proposed_at: 0,
        approval_request_id: None,
        operation: Some(Operation::begin().unwrap()),
        provider_id: Some("REFUND-B".into()),
        confirmed: false,
    };
    t.refunds.push(pending.clone());
    let mut done = pending;
    done.provider_id = Some("REFUND-C".into());
    done.amount = Cents(100);
    done.confirmed = true;
    t.refunds.push(done);
    assert_eq!(
        confirmed_refunds(&t),
        vec![
            ("REFUND-A".to_string(), Cents(400)),
            ("REFUND-C".to_string(), Cents(100))
        ]
    );
}
