use super::{
    domain::{Task, UnitState},
    money::Cents,
    observations,
};
use serde_json::{Value, json};

pub fn projection(tasks: &[Task]) -> Value {
    let captured = tasks
        .iter()
        .filter(|t| t.captured)
        .map(|t| t.amount.0)
        .sum::<u64>();
    let refunded = tasks
        .iter()
        .filter(|t| t.refund_confirmed)
        .map(|t| t.refund_amount.0)
        .sum::<u64>();
    let delivered = tasks
        .iter()
        .flat_map(|t| &t.units)
        .filter(|u| u.state == UnitState::Delivered)
        .count();
    let failed = tasks
        .iter()
        .flat_map(|t| &t.units)
        .filter(|u| u.state == UnitState::Failed)
        .count();
    let unresolved = tasks
        .iter()
        .filter(|t| {
            t.payment_review.is_some()
                || [t.order.as_ref(), t.capture.as_ref(), t.refund.as_ref()]
                    .iter()
                    .flatten()
                    .any(|o| o.state != super::domain::OperationState::Observed)
        })
        .count();
    let known_net = captured
        .checked_sub(refunded)
        .filter(|_| tasks.iter().all(|task| task.payment_review.is_none()));
    json!({"currency":"USD","captured":Cents(captured).decimal(),"confirmed_refunds":Cents(refunded).decimal(),"known_net_cost":known_net.map(|cents| Cents(cents).decimal()),"delivered_units":delivered,"failed_units":failed,"unresolved_tasks":unresolved,"task_count":tasks.len(),"prepaid_units_allocated":tasks.iter().filter_map(|t|t.subscription_funding.as_ref()).map(|f|f.units as u64).sum::<u64>(),"cash_scope":"Orders task cash only; subscription cash appears on subscription payment references, never per-task captures", "scope":"Latest 100 tasks accessible to this principal; not lifetime totals","tasks":tasks.iter().map(|t| observations::receipt(t,true)).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paypal::domain::{Document, Operation, Principal, Role};
    #[test]
    fn analytics_excludes_uncaptured_quotes_and_unconfirmed_refunds() {
        let p = Principal {
            id: "p".into(),
            workspace: "w".into(),
            role: Role::Buyer,
        };
        let quote = Task::quote(
            &p,
            vec![Document {
                name: "doc".into(),
                text: "text".into(),
            }],
        )
        .unwrap();
        let mut captured = quote.clone();
        captured.captured = true;
        captured.refund_amount = Cents(400);
        captured.refund = Some(Operation::begin().unwrap());
        let view = projection(&[quote.clone(), captured.clone()]);
        assert_eq!(view["captured"], "4.00");
        assert_eq!(view["confirmed_refunds"], "0.00");
        assert_eq!(view["known_net_cost"], "4.00");
        assert_eq!(view["unresolved_tasks"], 1);
        captured.refund_confirmed = true;
        assert_eq!(projection(&[quote, captured])["known_net_cost"], "0.00");
    }

    #[test]
    fn known_net_is_absent_when_confirmed_refunds_exceed_counted_captures() {
        let principal = Principal {
            id: "p".into(),
            workspace: "w".into(),
            role: Role::Buyer,
        };
        let mut refunded = Task::quote(
            &principal,
            vec![Document {
                name: "doc".into(),
                text: "text".into(),
            }],
        )
        .unwrap();
        refunded.captured = false;
        refunded.refund_confirmed = true;
        refunded.refund_amount = Cents(400);
        assert!(projection(&[refunded])["known_net_cost"].is_null());
    }
    #[test]
    fn allocation_total_is_cumulative_after_consumption_and_restoration() {
        let p = Principal {
            id: "buyer".into(),
            workspace: "workspace".into(),
            role: Role::Buyer,
        };
        let mut t = Task::quote(
            &p,
            vec![
                Document {
                    name: "a".into(),
                    text: "source".into(),
                },
                Document {
                    name: "b".into(),
                    text: "source".into(),
                },
            ],
        )
        .unwrap();
        t.subscription_funding = Some(crate::paypal::subscriptions::Funding {
            subscription_id: "s".into(),
            buyer: p.id,
            period_start: 1,
            period_end: 2,
            payment_id: "sale".into(),
            units: 2,
            delegation_id: None,
        });
        t.units[0].state = UnitState::Delivered;
        t.units[1].state = UnitState::Failed;
        let v = projection(&[t]);
        assert_eq!(v["prepaid_units_allocated"], 2);
        assert!(v.get("prepaid_units_reserved").is_none());
        assert_eq!(v["captured"], "0.00");
    }
}
