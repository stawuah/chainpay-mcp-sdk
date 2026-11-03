//! Append-only, revision-bound human decisions. All mutations run under Store::update.
use super::{
    domain::{self, Error, Operation, Principal, Role, Task, UnitState},
    money::Cents,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Revision {
    pub revision: u32,
    pub output_hash: Option<String>,
    pub result: Option<Value>,
    pub state: UnitState,
    pub reason: Option<String>,
    pub archived_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub unit: usize,
    pub revision: u32,
    pub output_hash: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Accept,
    Challenge,
    Rework,
    ProposeRefund,
    ApproveRefund,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Intent {
    pub request_id: String,
    pub binding: Binding,
    pub action: Action,
    pub reason: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Event {
    pub actor: String,
    pub role: Role,
    pub timestamp: u64,
    pub intent: Intent,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Refund {
    pub request_id: String,
    pub bindings: Vec<Binding>,
    pub reason: String,
    pub amount: Cents,
    pub digest: String,
    pub proposed_by: String,
    pub proposed_at: u64,
    pub approval_request_id: Option<String>,
    pub operation: Option<Operation>,
    pub provider_id: Option<String>,
    pub confirmed: bool,
}
fn request_id(id: &str) -> Result<(), Error> {
    if !(16..=64).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(Error::Invalid(
            "Use a stable request ID of 16–64 characters",
        ));
    }
    Ok(())
}
impl Task {
    fn binding(&self, b: &Binding) -> Result<(), Error> {
        let u = self.units.get(b.unit).ok_or(Error::Conflict)?;
        if u.revision != b.revision || u.output_hash != b.output_hash {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub fn confirmed_refunds(&self) -> u64 {
        (if self.refund_confirmed {
            self.refund_amount.0
        } else {
            0
        }) + self
            .refunds
            .iter()
            .filter(|r| r.confirmed)
            .map(|r| r.amount.0)
            .sum::<u64>()
    }
    pub fn reserved_refunds(&self) -> u64 {
        (if self.refund.is_some() || self.refund_confirmed {
            self.refund_amount.0
        } else {
            0
        }) + self
            .refunds
            .iter()
            .filter(|r| r.operation.is_some())
            .map(|r| r.amount.0)
            .sum::<u64>()
    }
    pub fn preserve_legacy_refund(&mut self) -> Result<(), Error> {
        if (self.refund.is_some() || self.refund_confirmed) && self.legacy_refund_units.is_none() {
            let failed: Vec<_> = self
                .units
                .iter()
                .enumerate()
                .filter(|(_, u)| u.state == UnitState::Failed && u.history.is_empty())
                .map(|(i, _)| i)
                .collect();
            let mut expected = 0;
            for i in &failed {
                expected += self.unit_price(*i)?.0;
            }
            if expected != self.refund_amount.0 {
                return Err(Error::Invalid(
                    "Historical refund unit mapping requires merchant review",
                ));
            }
            self.legacy_refund_units = Some(failed);
        }
        Ok(())
    }
    fn refunded_unit(&self, index: usize) -> bool {
        self.legacy_refund_units
            .as_ref()
            .is_some_and(|v| v.contains(&index))
            || self
                .refunds
                .iter()
                .any(|r| r.operation.is_some() && r.bindings.iter().any(|b| b.unit == index))
    }
    fn replay(&self, p: &Principal, intent: &Intent) -> Result<bool, Error> {
        request_id(&intent.request_id)?;
        if intent.reason.trim().is_empty() || intent.reason.len() > 2000 {
            return Err(Error::Invalid("Supply a reason of 1–2000 bytes"));
        }
        if let Some(e) = self
            .resolution
            .iter()
            .find(|e| e.intent.request_id == intent.request_id)
        {
            if e.actor == p.id
                && e.role == p.role
                && serde_json::to_value(&e.intent).unwrap() == serde_json::to_value(intent).unwrap()
            {
                return Ok(true);
            }
            return Err(Error::Conflict);
        }
        if self.refunds.iter().any(|r| {
            r.request_id == intent.request_id
                || r.approval_request_id.as_deref() == Some(&intent.request_id)
        }) {
            return Err(Error::Conflict);
        }
        if self.resolution.len() >= 512 {
            return Err(Error::Invalid(
                "Resolution decision limit reached; existing approvals and recovery remain available",
            ));
        }
        Ok(false)
    }
    fn append(&mut self, p: &Principal, intent: Intent) {
        self.resolution.push(Event {
            actor: p.id.clone(),
            role: p.role.clone(),
            timestamp: domain::now(),
            intent,
        });
    }
    pub fn decide(&mut self, p: &Principal, intent: Intent) -> Result<(), Error> {
        self.buyer(p)?;
        if !matches!(intent.action, Action::Accept | Action::Challenge) {
            return Err(Error::Forbidden);
        }
        if self.replay(p, &intent)? {
            return Ok(());
        }
        self.binding(&intent.binding)?;
        if self.units[intent.binding.unit].state != UnitState::Delivered
            || intent.binding.output_hash.is_none()
        {
            return Err(Error::Conflict);
        }
        self.append(p, intent);
        Ok(())
    }
    pub fn rework(&mut self, p: &Principal, intent: Intent) -> Result<(), Error> {
        self.merchant(p)?;
        if intent.action != Action::Rework {
            return Err(Error::Forbidden);
        }
        if self.replay(p, &intent)? {
            return Ok(());
        }
        self.binding(&intent.binding)?;
        self.preserve_legacy_refund()?;
        if !self.verified_funded() || self.refunded_unit(intent.binding.unit) {
            return Err(Error::Conflict);
        }
        let u = &self.units[intent.binding.unit];
        let challenged = self
            .resolution
            .iter()
            .rev()
            .find(|e| {
                e.intent.binding == intent.binding
                    && matches!(e.intent.action, Action::Accept | Action::Challenge)
            })
            .is_some_and(|e| e.intent.action == Action::Challenge);
        if u.state != UnitState::Failed && !(u.state == UnitState::Delivered && challenged) {
            return Err(Error::Conflict);
        }
        let u = &mut self.units[intent.binding.unit];
        u.history.push(Revision {
            revision: u.revision,
            output_hash: u.output_hash.clone(),
            result: u.result.clone(),
            state: u.state.clone(),
            reason: u.reason.clone(),
            archived_at: domain::now(),
        });
        u.revision = u.revision.checked_add(1).ok_or(Error::Conflict)?;
        u.attempt = None;
        u.started_at = None;
        u.result = None;
        u.output_hash = None;
        u.reason = None;
        u.state = UnitState::Pending;
        self.append(p, intent);
        Ok(())
    }
    pub fn propose_resolution_refund(
        &mut self,
        p: &Principal,
        id: &str,
        bindings: Vec<Binding>,
        reason: String,
    ) -> Result<(), Error> {
        self.merchant(p)?;
        request_id(id)?;
        if let Some(r) = self.refunds.iter().find(|r| r.request_id == id) {
            return if r.proposed_by == p.id && r.bindings == bindings && r.reason == reason {
                Ok(())
            } else {
                Err(Error::Conflict)
            };
        }
        if self.resolution.iter().any(|e| e.intent.request_id == id)
            || self
                .refunds
                .iter()
                .any(|r| r.approval_request_id.as_deref() == Some(id))
        {
            return Err(Error::Conflict);
        }
        if reason.trim().is_empty()
            || reason.len() > 2000
            || bindings.is_empty()
            || bindings.len() > self.units.len()
        {
            return Err(Error::Invalid(
                "Select affected outputs and supply a reason",
            ));
        }
        if self.refunds.len() >= 128 || self.resolution.len().saturating_add(bindings.len()) > 512 {
            return Err(Error::Invalid(
                "Resolution proposal limit reached; existing approvals and recovery remain available",
            ));
        }
        self.preserve_legacy_refund()?;
        self.validate_refund_bindings(&bindings)?;
        let mut amount = Cents(0);
        for b in &bindings {
            amount = Cents(
                amount
                    .0
                    .checked_add(self.unit_price(b.unit)?.0)
                    .ok_or(Error::Conflict)?,
            );
        }
        let digest = domain::hash(
            &serde_json::to_vec(&(&self.id, &self.capture_id, id, &bindings, &reason, amount))
                .unwrap(),
        );
        for binding in &bindings {
            self.append(
                p,
                Intent {
                    request_id: id.into(),
                    binding: binding.clone(),
                    action: Action::ProposeRefund,
                    reason: reason.clone(),
                },
            );
        }
        self.refunds.push(Refund {
            request_id: id.into(),
            bindings,
            reason,
            amount,
            digest,
            proposed_by: p.id.clone(),
            proposed_at: domain::now(),
            approval_request_id: None,
            operation: None,
            provider_id: None,
            confirmed: false,
        });
        Ok(())
    }
    fn validate_refund_bindings(&self, bindings: &[Binding]) -> Result<(), Error> {
        if self.subscription_funding.is_some()
            || !self.captured
            || self.capture_id.is_none()
            || self.payment_review.is_some()
        {
            return Err(Error::Invalid(
                "Cash refund requires an original verified Orders capture",
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for b in bindings {
            self.binding(b)?;
            if !seen.insert(b.unit) || self.refunded_unit(b.unit) {
                return Err(Error::Conflict);
            }
            let challenged = self
                .resolution
                .iter()
                .rev()
                .find(|e| {
                    e.intent.binding == *b
                        && matches!(e.intent.action, Action::Accept | Action::Challenge)
                })
                .is_some_and(|e| e.intent.action == Action::Challenge);
            if self.units[b.unit].state != UnitState::Failed
                && !(self.units[b.unit].state == UnitState::Delivered && challenged)
            {
                return Err(Error::Conflict);
            }
        }
        Ok(())
    }
    pub fn approve_resolution_refund(
        &mut self,
        p: &Principal,
        id: &str,
        digest: &str,
    ) -> Result<Option<usize>, Error> {
        self.merchant(p)?;
        request_id(id)?;
        let index = self
            .refunds
            .iter()
            .position(|r| r.digest == digest)
            .ok_or(Error::Conflict)?;
        let r = &self.refunds[index];
        if r.operation.is_some() {
            return if r.approval_request_id.as_deref() == Some(id) {
                Ok(None)
            } else {
                Err(Error::Conflict)
            };
        }
        if self.resolution.iter().any(|e| e.intent.request_id == id)
            || self
                .refunds
                .iter()
                .any(|r| r.request_id == id || r.approval_request_id.as_deref() == Some(id))
        {
            return Err(Error::Conflict);
        }
        self.preserve_legacy_refund()?;
        self.validate_refund_bindings(&self.refunds[index].bindings)?;
        if self
            .reserved_refunds()
            .checked_add(self.refunds[index].amount.0)
            .is_none_or(|v| v > self.amount.0)
        {
            return Err(Error::Conflict);
        }
        let r = &mut self.refunds[index];
        r.operation = Some(Operation::begin()?);
        r.approval_request_id = Some(id.into());
        let events = r
            .bindings
            .iter()
            .map(|b| Intent {
                request_id: id.into(),
                binding: b.clone(),
                action: Action::ApproveRefund,
                reason: r.reason.clone(),
            })
            .collect::<Vec<_>>();
        for intent in events {
            self.append(p, intent)
        }
        Ok(Some(index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paypal::{domain::Document, observations};
    use serde_json::json;
    fn fixture() -> (Task, Principal, Principal) {
        let p = Principal {
            id: domain::random_id().unwrap(),
            workspace: domain::random_id().unwrap(),
            role: Role::Buyer,
        };
        let m = Principal {
            role: Role::Merchant,
            ..p.clone()
        };
        let mut t = Task::quote(
            &p,
            vec![
                Document {
                    name: "source".into(),
                    text: "Delivery within three working days after approval.".into()
                };
                2
            ],
        )
        .unwrap();
        t.captured = true;
        t.capture_id = Some("fixture-capture".into());
        for u in &mut t.units {
            u.state = UnitState::Delivered;
            u.output_hash = Some("old".into());
            u.result = Some(json!({"original":"private output"}));
        }
        (t, p, m)
    }
    fn intent(unit: usize, action: Action) -> Intent {
        Intent {
            request_id: domain::random_id().unwrap(),
            binding: Binding {
                unit,
                revision: 0,
                output_hash: Some("old".into()),
            },
            action,
            reason: "Missing evidence".into(),
        }
    }
    #[test]
    fn decisions_bind_identity_revision_and_replay() {
        let (mut t, p, m) = fixture();
        let challenge = intent(0, Action::Challenge);
        let other = Principal {
            workspace: "another".into(),
            ..p.clone()
        };
        assert!(t.decide(&other, challenge.clone()).is_err());
        assert!(t.decide(&m, challenge.clone()).is_err());
        t.decide(&p, challenge.clone()).unwrap();
        t.decide(&p, challenge.clone()).unwrap();
        assert_eq!(t.resolution.len(), 1);
        let mut changed = challenge.clone();
        changed.reason = "changed".into();
        assert!(t.decide(&p, changed).is_err());
        let rework = intent(0, Action::Rework);
        t.rework(&m, rework.clone()).unwrap();
        t.rework(&m, rework).unwrap();
        assert_eq!(t.units[0].history.len(), 1);
        assert_eq!(t.units[0].revision, 1);
        assert!(t.units[0].attempt.is_none());
        assert!(t.decide(&p, intent(0, Action::Accept)).is_err());
        assert_eq!(
            t.units[0].history[0].result.as_ref().unwrap()["original"],
            "private output"
        );
        assert!(
            !observations::receipt(&t, true)
                .to_string()
                .contains("Missing evidence")
        );
        assert!(
            !observations::receipt(&t, true)
                .to_string()
                .contains("private output")
        );
    }
    #[test]
    fn original_money_legacy_and_quota_are_bounded() {
        let (mut t, p, m) = fixture();
        t.offer_version = "removed-catalog-version".into();
        assert_eq!(t.output_price().unwrap(), Cents(400));
        t.units[1].state = UnitState::Failed;
        t.refund = Some(Operation::begin().unwrap());
        t.refund_amount = Cents(400);
        t.preserve_legacy_refund().unwrap();
        assert_eq!(t.legacy_refund_units, Some(vec![1]));
        t.decide(&p, intent(0, Action::Challenge)).unwrap();
        t.propose_resolution_refund(
            &m,
            &domain::random_id().unwrap(),
            vec![intent(0, Action::Challenge).binding],
            "buyer challenge".into(),
        )
        .unwrap();
        let digest = t.refunds[0].digest.clone();
        let id = domain::random_id().unwrap();
        t.approve_resolution_refund(&m, &id, &digest).unwrap();
        assert_eq!(t.reserved_refunds(), 800);
        assert!(
            t.propose_resolution_refund(
                &m,
                &domain::random_id().unwrap(),
                vec![intent(0, Action::Challenge).binding],
                "duplicate".into()
            )
            .is_err()
        );
        observations::ledger_refund(
            &mut t,
            0,
            json!({"id":"R1","amount":{"currency_code":"USD","value":"4.00"},"status":"COMPLETED"}),
        )
        .unwrap();
        t.refund_confirmed = true;
        assert_eq!(t.net(), Some(Cents(0)));
        let (mut quota, p, m) = fixture();
        quota.subscription_funding = Some(super::super::subscriptions::Funding {
            subscription_id: "s".into(),
            buyer: p.id.clone(),
            period_start: 1,
            period_end: 2,
            payment_id: "sale".into(),
            units: 2,
            delegation_id: None,
        });
        quota.decide(&p, intent(0, Action::Challenge)).unwrap();
        assert!(
            quota
                .propose_resolution_refund(
                    &m,
                    &domain::random_id().unwrap(),
                    vec![intent(0, Action::Challenge).binding],
                    "refund".into()
                )
                .is_err()
        );
        assert!(quota.refund_proposal().is_err());
        quota.rework(&m, intent(0, Action::Rework)).unwrap();
        let (mut legacy, _, _) = fixture();
        legacy.refund = Some(Operation::begin().unwrap());
        legacy.refund_amount = Cents(400);
        assert!(legacy.preserve_legacy_refund().is_err());
        let mut old = serde_json::to_value(fixture().0).unwrap();
        for field in ["resolution", "refunds", "legacy_refund_units"] {
            old.as_object_mut().unwrap().remove(field);
        }
        for unit in old["units"].as_array_mut().unwrap() {
            for field in ["revision", "history", "attempt"] {
                unit.as_object_mut().unwrap().remove(field);
            }
        }
        let decoded: Task = serde_json::from_value(old).unwrap();
        assert!(decoded.refunds.is_empty());
        assert_eq!(decoded.units[0].revision, 0);
    }
    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn concurrent_refunds_reserve_once_under_row_lock() {
        let store = super::super::store::Store::connect(
            &std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap(),
        )
        .await
        .unwrap();
        let (mut task, p, m) = fixture();
        task.decide(&p, intent(0, Action::Challenge)).unwrap();
        for _ in 0..2 {
            task.propose_resolution_refund(
                &m,
                &domain::random_id().unwrap(),
                vec![intent(0, Action::Challenge).binding],
                "refund".into(),
            )
            .unwrap();
        }
        store
            .create(&task, &domain::random_id().unwrap(), "concurrent-refunds")
            .await
            .unwrap();
        let a = domain::random_id().unwrap();
        let b = domain::random_id().unwrap();
        let da = task.refunds[0].digest.clone();
        let db = task.refunds[1].digest.clone();
        let (a, b) = tokio::join!(
            store.update(&task.id, &m, |t| t.approve_resolution_refund(&m, &a, &da)),
            store.update(&task.id, &m, |t| t.approve_resolution_refund(&m, &b, &db))
        );
        assert_ne!(a.is_ok(), b.is_ok());
        let t = store.get(&task.id, &m).await.unwrap();
        assert_eq!(t.reserved_refunds(), 400);
        assert_eq!(
            t.refunds.iter().filter(|r| r.operation.is_some()).count(),
            1
        );
    }
    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn actual_routes_free_rework_and_refund_dispatch_once() {
        use crate::paypal::{
            ai::Ai,
            config::Config,
            provider::Provider,
            routes::{self, App},
            store::Store,
        };
        use axum::{
            Json, Router,
            extract::State,
            routing::{get, post},
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let store = Store::connect(&std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let (task, p, m) = fixture();
        store
            .create(&task, &domain::random_id().unwrap(), "routes")
            .await
            .unwrap();
        let buyer = store.issue_access(&p, 600).await.unwrap();
        let merchant = store.issue_access(&m, 600).await.unwrap();
        let counts = Arc::new((AtomicUsize::new(0), AtomicUsize::new(0)));
        let fixture=Router::new()
            .route("/model",post(|State(c):State<Arc<(AtomicUsize,AtomicUsize)>>,Json(body):Json<Value>|async move {
                c.0.fetch_add(1,Ordering::SeqCst);
                let data:Value=serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
                assert_eq!(data["document"]["text"],"Delivery within three working days after approval.");
                let output=json!({"summary":"Reworked delivery review","facts":[{"claim":"Three-day delivery","evidence":"three working days"}]});
                Json(json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}))
            }))
            .route("/v1/oauth2/token",post(||async {Json(json!({"access_token":"fixture","token_type":"Bearer","expires_in":300}))}))
            .route("/v2/payments/captures/fixture-capture/refund",post(|State(c):State<Arc<(AtomicUsize,AtomicUsize)>>,Json(body):Json<Value>|async move {
                c.1.fetch_add(1,Ordering::SeqCst);assert_eq!(body["amount"]["value"],"4.00");
                Json(json!({"id":"fixture-refund","status":"COMPLETED","amount":{"currency_code":"USD","value":"4.00"}}))
            }))
            .route("/v2/payments/refunds/fixture-refund",get(||async {Json(json!({"id":"fixture-refund","status":"COMPLETED","amount":{"currency_code":"USD","value":"4.00"}}))}))
            .with_state(counts.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let provider_server =
            tokio::spawn(async move { axum::serve(listener, fixture).await.unwrap() });
        let config = Config {
            database_url: "unused".into(),
            client_id: "fixture".into(),
            client_secret: "fixture".into(),
            webhook_id: "fixture".into(),
            public_origin: "http://127.0.0.1:5197".into(),
            new_purchases: false,
            subscriptions: false,
            subscription_plan: None,
            allowances: true,
        };
        let app = App {
            ai: Ai::fixture(format!("{base}/model")),
            store: store.clone(),
            provider: Provider::fixture(base, &config),
            config: Arc::new(config),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!(
            "http://{}/v1/paypal/tasks/{}",
            listener.local_addr().unwrap(),
            task.id
        );
        let server =
            tokio::spawn(async move { axum::serve(listener, routes::router(app)).await.unwrap() });
        let client = reqwest::Client::new();
        let challenge = intent(0, Action::Challenge);
        assert_eq!(
            client
                .post(format!("{base}/resolution"))
                .bearer_auth(&buyer)
                .json(&challenge)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        let rework = intent(0, Action::Rework);
        assert_eq!(
            client
                .post(format!("{base}/rework"))
                .bearer_auth(&merchant)
                .json(&rework)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        for _ in 0..2 {
            assert_eq!(
                client
                    .post(format!("{base}/process"))
                    .bearer_auth(&buyer)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                202
            );
        }
        let final_task = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let t = store.get(&task.id, &p).await.unwrap();
                if t.units[0].state == UnitState::Delivered {
                    break t;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(counts.0.load(Ordering::SeqCst), 1);
        assert_eq!(final_task.units[0].revision, 1);
        assert_eq!(
            final_task.units[0].history[0].output_hash.as_deref(),
            Some("old")
        );
        assert_eq!(
            client
                .post(format!("{base}/resolution"))
                .bearer_auth(&buyer)
                .json(&intent(0, Action::Accept))
                .send()
                .await
                .unwrap()
                .status(),
            409
        );
        assert_eq!(
            client
                .post(format!("{base}/resolution"))
                .bearer_auth(&buyer)
                .json(&intent(1, Action::Challenge))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        let proposal = json!({"request_id":domain::random_id().unwrap(),"bindings":[intent(1,Action::Challenge).binding],"reason":"Missing evidence"});
        let response = client
            .post(format!("{base}/resolution-refunds"))
            .bearer_auth(&merchant)
            .json(&proposal)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let response: Value = response.json().await.unwrap();
        let approval = json!({"request_id":domain::random_id().unwrap(),"digest":response["refunds"][0]["digest"]});
        for _ in 0..2 {
            assert_eq!(
                client
                    .post(format!("{base}/resolution-refunds/approve"))
                    .bearer_auth(&merchant)
                    .json(&approval)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                200
            );
        }
        assert_eq!(counts.1.load(Ordering::SeqCst), 1);
        let t = store.get(&task.id, &p).await.unwrap();
        assert_eq!(t.confirmed_refunds(), 400);
        assert_eq!(t.reserved_refunds(), 400);
        assert_eq!(
            client
                .post(format!("{base}/reconcile"))
                .bearer_auth(&buyer)
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(counts.1.load(Ordering::SeqCst), 1);
        server.abort();
        provider_server.abort();
    }

    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn late_worker_cannot_overwrite_new_attempt_in_same_revision() {
        use crate::paypal::{ai::Ai, store::Store};
        use axum::{Json, Router, routing::post};
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let store = Store::connect(&std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let (mut task, p, _) = fixture();
        task.units.truncate(1);
        task.documents.truncate(1);
        task.units[0].state = UnitState::Pending;
        task.units[0].output_hash = None;
        task.units[0].result = None;
        store
            .create(&task, &domain::random_id().unwrap(), "race")
            .await
            .unwrap();
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let calls = Arc::new(AtomicUsize::new(0));
        let enter = entered.clone();
        let resume = release.clone();
        let count = calls.clone();
        let fixture=Router::new().route("/model",post(move ||{let enter=enter.clone();let resume=resume.clone();let n=count.fetch_add(1,Ordering::SeqCst);async move {
            if n==0 {enter.notify_one();resume.notified().await;}
            let output=json!({"summary":if n==0 {"Stale worker"} else {"Current worker"},"facts":[{"claim":"Three days","evidence":"three working days"}]});
            Json(json!({"choices":[{"finish_reason":"stop","message":{"content":output.to_string()}}]}))
        }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ai = Ai::fixture(format!("http://{}/model", listener.local_addr().unwrap()));
        let server = tokio::spawn(async move { axum::serve(listener, fixture).await.unwrap() });
        let runner = ai.clone();
        let st = store.clone();
        let id = task.id.clone();
        let owner = p.clone();
        let old = tokio::spawn(async move { runner.run(&st, &id, &owner).await });
        tokio::time::timeout(std::time::Duration::from_secs(2), entered.notified())
            .await
            .unwrap();
        store
            .update(&task.id, &p, |t| {
                t.units[0].started_at = Some(0);
                Ok(())
            })
            .await
            .unwrap();
        ai.run(&store, &task.id, &p).await.unwrap();
        release.notify_one();
        old.await.unwrap().unwrap();
        let t = store.get(&task.id, &p).await.unwrap();
        assert_eq!(
            t.units[0].result.as_ref().unwrap()["output"]["summary"],
            "Current worker"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
    }
    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn lost_refund_recovers_only_by_verified_original_reference() {
        use crate::paypal::{
            ai::Ai,
            config::Config,
            provider::Provider,
            routes::{self, App},
            store::Store,
        };
        use axum::{
            Json, Router,
            http::StatusCode,
            routing::{get, post},
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let store = Store::connect(&std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let (mut task, p, m) = fixture();
        task.capture_id = Some(domain::random_id().unwrap());
        task.decide(&p, intent(0, Action::Challenge)).unwrap();
        task.propose_resolution_refund(
            &m,
            &domain::random_id().unwrap(),
            vec![intent(0, Action::Challenge).binding],
            "Missing evidence".into(),
        )
        .unwrap();
        store
            .create(&task, &domain::random_id().unwrap(), "lost-response")
            .await
            .unwrap();
        let posted = Arc::new(tokio::sync::Mutex::new(None::<Value>));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let reads = Arc::new(AtomicUsize::new(0));
        let id = domain::random_id().unwrap();
        let saved = posted.clone();
        let sends = dispatches.clone();
        let observed = posted.clone();
        let gets = reads.clone();
        let refund_id = id.clone();
        let fixture=Router::new()
            .route("/v1/oauth2/token",post(||async{Json(json!({"access_token":"fixture","token_type":"Bearer","expires_in":300}))}))
            .route(&format!("/v2/payments/captures/{}/refund",task.capture_id.as_ref().unwrap()),post(move |Json(body):Json<Value>| {let saved=saved.clone();let sends=sends.clone();async move {
                sends.fetch_add(1,Ordering::SeqCst);
                assert_eq!(body["amount"],json!({"currency_code":"USD","value":"4.00"}));
                assert!(body["invoice_id"].as_str().is_some_and(|s|s.len()==32));
                *saved.lock().await=Some(body);
                // The provider accepts the mutation, but its response arrives after the client timeout.
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                Json(json!({"status":"COMPLETED"}))
            }}))
            .route(&format!("/v2/payments/refunds/{id}"),get(move || {let observed=observed.clone();let gets=gets.clone();let id=refund_id.clone();async move {
                if gets.fetch_add(1,Ordering::SeqCst)==0 {return (StatusCode::SERVICE_UNAVAILABLE,Json(json!({})));}
                let body=observed.lock().await.clone().unwrap();
                (StatusCode::OK,Json(json!({"id":id,"invoice_id":body["invoice_id"],"amount":body["amount"],"status":"COMPLETED"})))
            }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider_base = format!("http://{}", listener.local_addr().unwrap());
        let provider_server =
            tokio::spawn(async move { axum::serve(listener, fixture).await.unwrap() });
        let config = Config {
            database_url: "unused".into(),
            client_id: "fixture".into(),
            client_secret: "fixture".into(),
            webhook_id: "fixture".into(),
            public_origin: "http://127.0.0.1:5197".into(),
            new_purchases: false,
            subscriptions: false,
            subscription_plan: None,
            allowances: true,
        };
        let app = App {
            ai: Ai::fixture("http://127.0.0.1:1/unused".into()),
            store: store.clone(),
            provider: Provider::fixture(provider_base, &config),
            config: Arc::new(config),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!(
            "http://{}/v1/paypal/tasks/{}",
            listener.local_addr().unwrap(),
            task.id
        );
        let router = routes::router(app.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let token = store.issue_access(&m, 600).await.unwrap();
        let client = reqwest::Client::new();
        let approval =
            json!({"request_id":domain::random_id().unwrap(),"digest":task.refunds[0].digest});
        for _ in 0..2 {
            assert_eq!(
                client
                    .post(format!("{base}/resolution-refunds/approve"))
                    .bearer_auth(&token)
                    .json(&approval)
                    .send()
                    .await
                    .unwrap()
                    .status(),
                200
            );
        }
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        let pending = store.get(&task.id, &p).await.unwrap();
        assert_eq!(
            pending.refunds[0].operation.as_ref().unwrap().state,
            domain::OperationState::Unknown
        );
        let body = posted.lock().await.clone().unwrap();
        // Signature verification is represented by inbox insertion. Every reference comes
        // from the actual outgoing POST, never an independently manufactured invoice ID.
        let event_id = domain::random_id().unwrap();
        store.insert_event(&json!({"id":event_id,"event_type":"PAYMENT.CAPTURE.REFUNDED","resource":{"id":id,"invoice_id":body["invoice_id"]}})).await.unwrap();
        app.process_events().await.unwrap();
        let pending = store.get(&task.id, &p).await.unwrap();
        assert!(pending.payment_review.is_none());
        assert!(!pending.refunds[0].confirmed);
        assert_eq!(pending.reserved_refunds(), 400);
        assert!(
            store
                .pending_events()
                .await
                .unwrap()
                .iter()
                .any(|e| e["id"] == event_id)
        );
        app.process_events().await.unwrap();
        let restored = store.get(&task.id, &p).await.unwrap();
        assert_eq!(
            restored.refunds[0].provider_id.as_deref(),
            Some(id.as_str())
        );
        assert!(restored.refunds[0].confirmed);
        assert!(restored.payment_review.is_none());
        assert_eq!(restored.reserved_refunds(), 400);
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        assert!(
            !store
                .pending_events()
                .await
                .unwrap()
                .iter()
                .any(|e| e["id"] == event_id)
        );
        let mut changed = restored.clone();
        changed.order = Some(Operation::begin().unwrap());
        let observation = json!({"id":"order","purchase_units":[{"custom_id":changed.id,"amount":{"currency_code":"USD","value":"8.00"},"payments":{"captures":[{"id":changed.capture_id,"amount":{"currency_code":"USD","value":"8.00"},"status":"PARTIALLY_REFUNDED"}]}}]});
        // Our own 4.00 refund explains PARTIALLY_REFUNDED: no review, net stays known.
        observations::order(&mut changed, observation.clone()).unwrap();
        assert!(changed.payment_review.is_none());
        assert_eq!(changed.net(), Some(Cents(400)));
        // The same report on a task that reserved nothing is a change we did not make.
        let mut unexplained = changed.clone();
        unexplained.refunds.clear();
        observations::order(&mut unexplained, observation).unwrap();
        assert!(unexplained.payment_review.is_some());
        assert!(unexplained.net().is_none());
        // A full refund the provider reports is also unexplained when we only reserved part of it.
        let full = json!({"id":"order","purchase_units":[{"custom_id":changed.id,"amount":{"currency_code":"USD","value":"8.00"},"payments":{"captures":[{"id":changed.capture_id,"amount":{"currency_code":"USD","value":"8.00"},"status":"REFUNDED"}]}}]});
        observations::order(&mut changed, full).unwrap();
        assert!(changed.payment_review.is_some());
        server.abort();
        provider_server.abort();
    }

    #[test]
    fn history_caps_preserve_replay_existing_approvals_and_recovery() {
        let (mut task, p, m) = fixture();
        let challenge = intent(0, Action::Challenge);
        task.decide(&p, challenge.clone()).unwrap();
        let request = domain::random_id().unwrap();
        let bindings = vec![challenge.binding.clone()];
        task.propose_resolution_refund(&m, &request, bindings.clone(), "Missing evidence".into())
            .unwrap();
        let digest = task.refunds[0].digest.clone();
        let event = task.resolution[0].clone();
        task.resolution.resize(512, event);
        assert!(
            task.decide(&p, intent(0, Action::Accept))
                .unwrap_err()
                .to_string()
                .contains("limit")
        );
        assert!(
            task.rework(&m, intent(0, Action::Rework))
                .unwrap_err()
                .to_string()
                .contains("limit")
        );
        task.decide(&p, challenge).unwrap();
        task.propose_resolution_refund(&m, &request, bindings.clone(), "Missing evidence".into())
            .unwrap();
        assert!(
            task.propose_resolution_refund(
                &m,
                &domain::random_id().unwrap(),
                bindings,
                "new".into()
            )
            .unwrap_err()
            .to_string()
            .contains("limit")
        );
        let approval = domain::random_id().unwrap();
        assert_eq!(
            task.approve_resolution_refund(&m, &approval, &digest)
                .unwrap(),
            Some(0)
        );
        assert_eq!(
            task.approve_resolution_refund(&m, &approval, &digest)
                .unwrap(),
            None
        );
        observations::ledger_refund(&mut task,0,json!({"id":"refund","status":"COMPLETED","amount":{"currency_code":"USD","value":"4.00"}})).unwrap();
        assert_eq!(task.confirmed_refunds(), 400);
        let (mut proposals, p, m) = fixture();
        proposals.decide(&p, intent(0, Action::Challenge)).unwrap();
        for _ in 0..128 {
            proposals
                .propose_resolution_refund(
                    &m,
                    &domain::random_id().unwrap(),
                    vec![intent(0, Action::Challenge).binding],
                    "review".into(),
                )
                .unwrap();
        }
        assert!(
            proposals
                .propose_resolution_refund(
                    &m,
                    &domain::random_id().unwrap(),
                    vec![intent(0, Action::Challenge).binding],
                    "over cap".into()
                )
                .unwrap_err()
                .to_string()
                .contains("limit")
        );
        let digest = proposals.refunds[0].digest.clone();
        assert!(
            proposals
                .approve_resolution_refund(&m, &domain::random_id().unwrap(), &digest)
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn lost_legacy_refund_recovers_from_webhook_by_invoice_id() {
        use crate::paypal::{
            ai::Ai,
            config::Config,
            provider::Provider,
            routes::{self, App},
            store::Store,
        };
        use axum::{
            Json, Router,
            http::StatusCode,
            routing::{get, post},
        };
        use std::sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        };
        let store = Store::connect(&std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let (mut task, p, m) = fixture();
        task.capture_id = Some(domain::random_id().unwrap());
        // One failed unit makes the legacy proposal worth 4.00.
        task.units[0].state = UnitState::Failed;
        let (amount, digest) = task.refund_proposal().unwrap();
        assert_eq!(amount, Cents(400));
        store
            .create(&task, &domain::random_id().unwrap(), "lost-legacy")
            .await
            .unwrap();
        let posted = Arc::new(tokio::sync::Mutex::new(None::<Value>));
        let dispatches = Arc::new(AtomicUsize::new(0));
        let id = domain::random_id().unwrap();
        let saved = posted.clone();
        let sends = dispatches.clone();
        let observed = posted.clone();
        let refund_id = id.clone();
        let fixture=Router::new()
            .route("/v1/oauth2/token",post(||async{Json(json!({"access_token":"fixture","token_type":"Bearer","expires_in":300}))}))
            .route(&format!("/v2/payments/captures/{}/refund",task.capture_id.as_ref().unwrap()),post(move |Json(body):Json<Value>| {let saved=saved.clone();let sends=sends.clone();async move {
                sends.fetch_add(1,Ordering::SeqCst);
                assert_eq!(body["amount"],json!({"currency_code":"USD","value":"4.00"}));
                // The request key travels as invoice_id, so the webhook can name it.
                assert!(body["invoice_id"].as_str().is_some_and(|s|!s.is_empty()));
                *saved.lock().await=Some(body);
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                Json(json!({"status":"COMPLETED"}))
            }}))
            .route(&format!("/v2/payments/refunds/{id}"),get(move || {let observed=observed.clone();let id=refund_id.clone();async move {
                let body=observed.lock().await.clone().unwrap();
                (StatusCode::OK,Json(json!({"id":id,"invoice_id":body["invoice_id"],"amount":body["amount"],"status":"COMPLETED"})))
            }}));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let provider_base = format!("http://{}", listener.local_addr().unwrap());
        let provider_server =
            tokio::spawn(async move { axum::serve(listener, fixture).await.unwrap() });
        let config = Config {
            database_url: "unused".into(),
            client_id: "fixture".into(),
            client_secret: "fixture".into(),
            webhook_id: "fixture".into(),
            public_origin: "http://127.0.0.1:5197".into(),
            new_purchases: false,
            subscriptions: false,
            subscription_plan: None,
            allowances: true,
        };
        let app = App {
            ai: Ai::fixture("http://127.0.0.1:1/unused".into()),
            store: store.clone(),
            provider: Provider::fixture(provider_base, &config),
            config: Arc::new(config),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!(
            "http://{}/v1/paypal/tasks/{}",
            listener.local_addr().unwrap(),
            task.id
        );
        let router = routes::router(app.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let token = store.issue_access(&m, 600).await.unwrap();
        let client = reqwest::Client::new();
        assert_eq!(
            client
                .post(format!("{base}/refund"))
                .bearer_auth(&token)
                .json(&json!({"digest":digest}))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        let pending = store.get(&task.id, &p).await.unwrap();
        assert_eq!(
            pending.refund.as_ref().unwrap().state,
            domain::OperationState::Unknown
        );
        assert!(pending.refund_id.is_none());
        assert!(!pending.refund_confirmed);
        let body = posted.lock().await.clone().unwrap();
        let event_id = domain::random_id().unwrap();
        store.insert_event(&json!({"id":event_id,"event_type":"PAYMENT.CAPTURE.REFUNDED","resource":{"id":id,"invoice_id":body["invoice_id"]}})).await.unwrap();
        app.process_events().await.unwrap();
        let restored = store.get(&task.id, &p).await.unwrap();
        assert_eq!(restored.refund_id.as_deref(), Some(id.as_str()));
        assert!(restored.refund_confirmed);
        assert!(restored.payment_review.is_none());
        assert_eq!(restored.net(), Some(Cents(400)));
        assert_eq!(dispatches.load(Ordering::SeqCst), 1);
        server.abort();
        provider_server.abort();
    }
}
