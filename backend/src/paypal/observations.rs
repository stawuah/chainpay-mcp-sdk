//! Provider observations are accepted only when their immutable terms match.
use super::{
    domain::{Error, Task},
    money::Cents,
};
use serde_json::{Value, json};

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or(Error::Invalid("Incomplete provider observation"))
}
fn amount(value: &Value, expected: Cents) -> Result<(), Error> {
    if text(value, "currency_code")? != "USD"
        || Cents::parse(text(value, "value")?).map_err(Error::Invalid)? != expected
    {
        return Err(Error::Conflict);
    }
    Ok(())
}

pub fn order(task: &mut Task, value: Value) -> Result<(), Error> {
    if task.subscription_funding.is_some() {
        return Err(Error::Conflict);
    }
    let order_id = text(&value, "id")?.to_string();
    if task.order.is_none() || task.order_id.as_ref().is_some_and(|old| *old != order_id) {
        return Err(Error::Conflict);
    }
    let units = value["purchase_units"]
        .as_array()
        .filter(|v| v.len() == 1)
        .ok_or(Error::Conflict)?;
    if text(&units[0], "custom_id")? != task.id {
        return Err(Error::Conflict);
    }
    amount(&units[0]["amount"], task.amount)?;
    task.order_id = Some(order_id);
    if let Some(links) = value["links"].as_array() {
        for link in links {
            if matches!(link["rel"].as_str(), Some("payer-action" | "approve")) {
                let href = text(link, "href")?;
                let url = url::Url::parse(href).map_err(|_| Error::Conflict)?;
                if url.scheme() != "https"
                    || url.host_str() != Some("www.sandbox.paypal.com")
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.port().is_some()
                {
                    return Err(Error::Conflict);
                }
                task.approval_url = Some(href.into());
            }
        }
    }
    if let Some(captures) = units[0]["payments"]["captures"].as_array() {
        if captures.len() != 1 {
            return Err(Error::Conflict);
        }
        let capture = &captures[0];
        amount(&capture["amount"], task.amount)?;
        let capture_id = text(capture, "id")?.to_string();
        if task
            .capture_id
            .as_ref()
            .is_some_and(|old| *old != capture_id)
        {
            return Err(Error::Conflict);
        }
        task.capture_id = Some(capture_id);
        // A refund we approved ourselves shows up here too (PayPal reports the
        // capture as PARTIALLY_REFUNDED after every webhook-driven reconcile), so
        // only flag review when the provider's status goes beyond what this task
        // has reserved: any refund with none reserved, or a full refund when the
        // reserved refunds do not cover the whole capture.
        let reserved = task.reserved_refunds();
        let unexplained_refund = match capture["status"].as_str() {
            Some("PARTIALLY_REFUNDED") => reserved == 0,
            Some("REFUNDED") => reserved < task.amount.0,
            _ => false,
        };
        if matches!(
            capture["status"].as_str(),
            Some("DECLINED" | "FAILED" | "DENIED" | "REVERSED")
        ) || unexplained_refund
        {
            task.payment_review = Some("Provider reports a payment change outside this task's approved operations; merchant review required".into());
        }
        if text(capture, "status")? == "COMPLETED" {
            task.captured = true;
            if let Some(op) = &mut task.capture {
                op.observe(capture.clone());
            }
        }
    }
    // Monotonic financial facts are separate from the latest provider response.
    task.order.as_mut().unwrap().observe(value);
    Ok(())
}

pub fn refund(task: &mut Task, value: Value) -> Result<(), Error> {
    if task.refund.is_none() {
        return Err(Error::Conflict);
    }
    amount(&value["amount"], task.refund_amount)?;
    let id = text(&value, "id")?.to_string();
    if task
        .refunds
        .iter()
        .any(|r| r.provider_id.as_deref() == Some(id.as_str()))
        || task.refund_id.as_ref().is_some_and(|old| *old != id)
    {
        return Err(Error::Conflict);
    }
    let status = text(&value, "status")?;
    task.refund_id = Some(id);
    if status == "COMPLETED" {
        task.refund_confirmed = true;
        task.refund.as_mut().unwrap().observe(value);
    }
    Ok(())
}

pub fn receipt(task: &Task, public: bool) -> Value {
    let units: Vec<Value> = task.units.iter().enumerate().map(|(i,u)| {
        let decision = task.resolution.iter().rev().find(|e|e.intent.binding.unit==i && e.intent.binding.revision==u.revision && e.intent.binding.output_hash==u.output_hash && matches!(e.intent.action,super::resolution::Action::Accept|super::resolution::Action::Challenge));
        let mut view = json!({"buyer_review":decision.map(|e|&e.intent.action),"index":i,"state":u.state,"input_hash":u.input_hash,"output_hash":u.output_hash,"revision":u.revision,"source":"merchant work record"});
        if !public { view["name"] = if task.offer_version == super::services::COMPARE { task.documents.iter().map(|d| d.name.as_str()).collect::<Vec<_>>().join(" ↔ ") } else { task.documents[i].name.clone() }.into(); view["result"] = json!(u.result); view["reason"] = json!(u.reason); }
        view
    }).collect();
    let mut view = json!({
        "id":task.id,"sandbox":true,"currency":"USD","offer_version":task.offer_version,
        "service_name":super::services::get(&task.offer_version).ok().map(|s| s.name),
        "created_at":task.created_at,"approved_at":task.approved_at,
        "allowance_units":task.allowance_units().ok(),
        "gross":task.amount.decimal(),"captured":task.captured,"payment_review":task.payment_review,
        "refund":Cents(task.confirmed_refunds()).decimal(),"refund_confirmed":task.confirmed_refunds()>0,
        "refund_pending":task.refunds.iter().any(|r|r.operation.is_some() && !r.confirmed),
        "reserved_refunds":Cents(task.reserved_refunds()).decimal(),"confirmed_refunds":Cents(task.confirmed_refunds()).decimal(),
        "funding_method":if task.subscription_funding.is_some(){"subscription_allowance"}else{"paypal_order"},
        "subscription_funding":task.subscription_funding.as_ref().map(|f|json!({"subscription_id":f.subscription_id,"payment_id":f.payment_id,"units":f.units,"period_start":f.period_start,"period_end":f.period_end})),"funded":task.verified_funded(),
        "net":task.net().map(Cents::decimal),"units":units,
        "order_id":task.order_id,"capture_id":task.capture_id,"refund_id":task.refund_id,
        "payment_source":"PayPal sandbox API observation",
        "delivery_source":"Merchant processing record; not buyer acceptance",
        "order_state":task.order.as_ref().map(|o| &o.state),
        "capture_state":task.capture.as_ref().map(|o| &o.state),
        "refund_state":task.refund.as_ref().map(|o| &o.state),
    });
    if !public {
        view["requirements"] = json!(task.requirements);
        view["resolution"] = json!(task.resolution);
        view["legacy_refund_units"] = json!(task.legacy_refund_units);
        view["revisions"] = json!(task.units.iter().map(|u| &u.history).collect::<Vec<_>>());
        view["refunds"] = json!(task.refunds.iter().map(|r|json!({"request_id":r.request_id,"bindings":r.bindings,"reason":r.reason,"amount":r.amount.decimal(),"digest":r.digest,"proposed_by":r.proposed_by,"proposed_at":r.proposed_at,"approval_request_id":r.approval_request_id,"provider_id":r.provider_id,"confirmed":r.confirmed,"state":r.operation.as_ref().map(|o|&o.state)})).collect::<Vec<_>>());
        view["quote_digest"] = task.quote_digest.clone().into();
        view["quote_expires_at"] = task.quote_expires_at.into();
        view["approval_url"] = json!(task.approval_url);
        view["share_token"] = json!(task.share_token);
    }
    view
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paypal::domain::{Document, Principal, Role};
    fn task() -> Task {
        let p = Principal {
            id: "buyer".into(),
            workspace: "workspace".into(),
            role: Role::Buyer,
        };
        let mut t = Task::quote(
            &p,
            vec![Document {
                name: "private name".into(),
                text: "private input".into(),
            }],
        )
        .unwrap();
        t.start_checkout(&p, &t.quote_digest.clone()).unwrap();
        t
    }
    fn observation(t: &Task) -> Value {
        json!({"id":"ORDER","status":"COMPLETED","purchase_units":[{"custom_id":t.id,"amount":{"currency_code":"USD","value":"4.00"},"payments":{"captures":[{"id":"CAPTURE","status":"COMPLETED","amount":{"currency_code":"USD","value":"4.00"}}]}}]})
    }
    #[test]
    fn only_matching_capture_permits_delivery_and_late_events_do_not_regress_it() {
        let mut t = task();
        let mut bad = observation(&t);
        bad["purchase_units"][0]["custom_id"] = "other".into();
        assert!(order(&mut t, bad).is_err());
        assert!(!t.captured);
        let mut bad = observation(&t);
        bad["purchase_units"][0]["payments"]["captures"][0]["amount"]["value"] = "0.01".into();
        assert!(order(&mut t, bad).is_err());
        assert!(!t.captured);
        let good = observation(&t);
        order(&mut t, good.clone()).unwrap();
        assert!(t.captured);
        let mut late = good;
        late["purchase_units"][0]
            .as_object_mut()
            .unwrap()
            .remove("payments");
        late["status"] = "APPROVED".into();
        order(&mut t, late).unwrap();
        assert!(t.captured);
    }
    #[test]
    fn external_refund_preserves_history_but_blocks_cost_and_further_refunds() {
        let mut t = task();
        let good = observation(&t);
        order(&mut t, good.clone()).unwrap();
        assert!(t.net().is_some());
        let mut changed = good.clone();
        changed["purchase_units"][0]["payments"]["captures"][0]["status"] =
            "PARTIALLY_REFUNDED".into();
        order(&mut t, changed).unwrap();
        assert!(t.captured);
        assert!(t.payment_review.is_some());
        assert!(t.net().is_none());
        assert!(t.refund_proposal().is_err());
        order(&mut t, good).unwrap();
        assert!(
            t.net().is_none(),
            "Late completion must not erase exception"
        );
        assert!(crate::paypal::analytics::projection(&[t])["known_net_cost"].is_null());
    }
    #[test]
    fn requirements_are_private_and_visible_before_approval() {
        let p = Principal {
            id: "buyer".into(),
            workspace: "workspace".into(),
            role: Role::Buyer,
        };
        let task = Task::quote_service(
            &p,
            vec![Document {
                name: "private name".into(),
                text: "private document".into(),
            }],
            super::super::services::CHECK,
            Some("SECRET exact buyer requirements".into()),
        )
        .unwrap();
        let private = receipt(&task, false);
        assert_eq!(private["requirements"], "SECRET exact buyer requirements");
        assert_eq!(private["offer_version"], super::super::services::CHECK);
        assert_eq!(private["service_name"], "Check supplied requirements");
        assert_eq!(private["captured"], false);
        let public = receipt(&task, true);
        assert!(public.get("requirements").is_none());
        assert!(!public.to_string().contains("SECRET"));
    }
    #[test]
    fn public_projection_never_includes_inputs_outputs_or_approval_capabilities() {
        let mut t = task();
        t.share_token = Some("private-token".into());
        t.units[0].result = Some(json!({"secret":"private output"}));
        let output = receipt(&t, true).to_string();
        for secret in [
            "private name",
            "private input",
            "private output",
            "private-token",
            &t.quote_digest,
        ] {
            assert!(!output.contains(secret));
        }
    }
    #[test]
    fn refund_observations_reject_duplicate_replacement_and_mismatched_references_atomically() {
        use crate::paypal::{
            domain::Operation,
            resolution::{Binding, Refund},
        };
        let mut original = task();
        original.captured = true;
        original.amount = Cents(1200);
        original.refund = Some(Operation::begin().unwrap());
        original.refund_id = Some("legacy".into());
        original.refund_amount = Cents(400);
        for (index, id) in ["ledger-one", "ledger-two"].iter().enumerate() {
            original.refunds.push(Refund {
                request_id: format!("proposal-{index}"),
                bindings: vec![Binding {
                    unit: index,
                    revision: 0,
                    output_hash: Some("hash".into()),
                }],
                reason: "review".into(),
                amount: Cents(400),
                digest: format!("digest-{index}"),
                proposed_by: "merchant".into(),
                proposed_at: 1,
                approval_request_id: Some(format!("approval-{index}")),
                operation: Some(Operation::begin().unwrap()),
                provider_id: Some((*id).into()),
                confirmed: false,
            });
        }
        for (legacy, id, reference, amount, status) in [
            (false, "legacy", None, "4.00", Some("COMPLETED")),
            (false, "ledger-two", None, "4.00", Some("COMPLETED")),
            (false, "replacement", None, "4.00", Some("COMPLETED")),
            (
                false,
                "ledger-one",
                Some("wrong-reference"),
                "4.00",
                Some("COMPLETED"),
            ),
            (false, "ledger-one", None, "0.01", Some("COMPLETED")),
            (false, "ledger-one", None, "4.00", None),
            (true, "ledger-one", None, "4.00", Some("COMPLETED")),
            (true, "replacement", None, "4.00", Some("COMPLETED")),
            (true, "legacy", None, "4.00", None),
        ] {
            let mut t = original.clone();
            let before = serde_json::to_value(&t).unwrap();
            let mut value = json!({"id":id,"amount":{"currency_code":"USD","value":amount}});
            if let Some(reference) = reference {
                value["invoice_id"] = json!(reference);
            }
            if let Some(status) = status {
                value["status"] = json!(status);
            }
            let result = if legacy {
                refund(&mut t, value)
            } else {
                ledger_refund(&mut t, 0, value)
            };
            assert!(result.is_err(), "case {legacy} {id} {reference:?} {amount}");
            assert_eq!(serde_json::to_value(&t).unwrap(), before);
            assert_eq!(t.confirmed_refunds(), 0);
            assert_eq!(t.reserved_refunds(), 1200);
        }
    }
}

/// Bind one provider resource to one approved local refund; no replacement dispatch.
pub fn ledger_refund(task: &mut Task, index: usize, value: Value) -> Result<(), Error> {
    let id = text(&value, "id")?.to_string();
    if task.refund_id.as_deref() == Some(&id)
        || task
            .refunds
            .iter()
            .enumerate()
            .any(|(i, r)| i != index && r.provider_id.as_deref() == Some(&id))
    {
        return Err(Error::Conflict);
    }
    let r = task.refunds.get_mut(index).ok_or(Error::Conflict)?;
    if r.operation.is_none() || r.provider_id.as_ref().is_some_and(|old| old != &id) {
        return Err(Error::Conflict);
    }
    if value
        .get("invoice_id")
        .is_some_and(|id| id.as_str() != r.operation.as_ref().map(|o| o.key.as_str()))
    {
        return Err(Error::Conflict);
    }
    amount(&value["amount"], r.amount)?;
    let status = text(&value, "status")?;
    r.provider_id = Some(id);
    if status == "COMPLETED" {
        r.confirmed = true;
        r.operation.as_mut().unwrap().observe(value);
    } else {
        r.operation.as_mut().unwrap().unknown();
    }
    Ok(())
}
