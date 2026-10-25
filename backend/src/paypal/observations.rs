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
    if task.refund_id.as_ref().is_some_and(|old| *old != id) {
        return Err(Error::Conflict);
    }
    task.refund_id = Some(id);
    if text(&value, "status")? == "COMPLETED" {
        task.refund_confirmed = true;
        task.refund.as_mut().unwrap().observe(value);
    }
    Ok(())
}

pub fn receipt(task: &Task, public: bool) -> Value {
    let units: Vec<Value> = task.units.iter().enumerate().map(|(i,u)| {
        let mut view = json!({"index":i,"state":u.state,"input_hash":u.input_hash,"output_hash":u.output_hash,"source":"merchant work record"});
        if !public { view["name"] = task.documents[i].name.clone().into(); view["result"] = json!(u.result); view["reason"] = json!(u.reason); }
        view
    }).collect();
    let mut view = json!({
        "id":task.id,"sandbox":true,"currency":"USD","offer_version":task.offer_version,
        "created_at":task.created_at,"approved_at":task.approved_at,
        "gross":task.amount.decimal(),"captured":task.captured,
        "refund":task.refund_amount.decimal(),"refund_confirmed":task.refund_confirmed,
        "net":task.net().map(Cents::decimal),"units":units,
        "order_id":task.order_id,"capture_id":task.capture_id,"refund_id":task.refund_id,
        "payment_source":"PayPal sandbox API observation",
        "delivery_source":"Merchant processing record; not buyer acceptance",
        "order_state":task.order.as_ref().map(|o| &o.state),
        "capture_state":task.capture.as_ref().map(|o| &o.state),
        "refund_state":task.refund.as_ref().map(|o| &o.state),
    });
    if !public {
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
}
