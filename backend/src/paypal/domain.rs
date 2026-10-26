use super::money::Cents;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2_010::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub const UNIT_CENTS: u64 = 400;
pub const OFFER_VERSION: &str = "document-extract-v1";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("Conflicting request or approval; use the original task")]
    Conflict,
    #[error("Task not found")]
    NotFound,
    #[error("This role cannot perform that action")]
    Forbidden,
    #[error("Storage unavailable")]
    Storage(#[from] sqlx::Error),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Buyer,
    Merchant,
    Agent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Principal {
    pub id: String,
    pub workspace: String,
    pub role: Role,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub name: String,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Dispatching,
    Observed,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Operation {
    pub key: String,
    pub started_at: u64,
    pub state: OperationState,
    pub observation: Option<Value>,
}

impl Operation {
    pub fn begin() -> Result<Self, Error> {
        Ok(Self {
            key: random_id()?,
            started_at: now(),
            state: OperationState::Dispatching,
            observation: None,
        })
    }
    pub fn observe(&mut self, value: Value) {
        self.state = OperationState::Observed;
        self.observation = Some(value);
    }
    pub fn unknown(&mut self) {
        if self.state != OperationState::Observed {
            self.state = OperationState::Unknown;
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UnitState {
    Pending,
    Processing,
    Delivered,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Unit {
    #[serde(default)]
    pub revision: u32,
    #[serde(default)]
    pub attempt: Option<String>,
    #[serde(default)]
    pub history: Vec<super::resolution::Revision>,
    pub input_hash: String,
    pub state: UnitState,
    pub started_at: Option<u64>,
    pub result: Option<Value>,
    pub output_hash: Option<String>,
    pub reason: Option<String>,
    #[serde(default)]
    pub price: Option<Cents>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Task {
    #[serde(default)]
    pub resolution: Vec<super::resolution::Event>,
    #[serde(default)]
    pub refunds: Vec<super::resolution::Refund>,
    #[serde(default)]
    pub legacy_refund_units: Option<Vec<usize>>,
    #[serde(default)]
    pub purchase: Option<super::catalog::Purchase>,
    #[serde(default)]
    pub dispute: Option<super::disputes::DisputeMark>,
    pub id: String,
    pub workspace: String,
    pub principal: String,
    pub created_at: u64,
    pub offer_version: String,
    #[serde(default)]
    pub requirements: Option<String>,
    pub documents: Vec<Document>,
    pub units: Vec<Unit>,
    pub amount: Cents,
    pub quote_digest: String,
    pub quote_expires_at: u64,
    pub approved_at: Option<u64>,
    pub order: Option<Operation>,
    pub order_id: Option<String>,
    pub approval_url: Option<String>,
    pub capture: Option<Operation>,
    pub capture_id: Option<String>,
    pub captured: bool,
    #[serde(default)]
    pub subscription_funding: Option<super::subscriptions::Funding>,
    #[serde(default)]
    pub payment_review: Option<String>,
    pub refund: Option<Operation>,
    pub refund_id: Option<String>,
    pub refund_amount: Cents,
    pub refund_confirmed: bool,
    pub share_token: Option<String>,
}

impl Task {
    pub fn quote(principal: &Principal, documents: Vec<Document>) -> Result<Self, Error> {
        Self::quote_service(principal, documents, OFFER_VERSION, None)
    }
    pub fn quote_service(
        principal: &Principal,
        documents: Vec<Document>,
        service_id: &str,
        requirements: Option<String>,
    ) -> Result<Self, Error> {
        let service = super::services::get(service_id)?;
        service.validate(&documents, requirements.as_deref())?;
        if !matches!(principal.role, Role::Buyer | Role::Agent) {
            return Err(Error::Forbidden);
        }
        super::services::validate_inputs(&documents)?;
        let id = random_id()?;
        let created_at = now();
        let amount = Cents(service.outputs(documents.len()) as u64 * service.unit_price.0);
        let units: Vec<Unit> = documents
            .iter()
            .map(|d| Unit {
                revision: 0,
                attempt: None,
                history: vec![],
                input_hash: hash(d.text.as_bytes()),
                state: UnitState::Pending,
                started_at: None,
                result: None,
                output_hash: None,
                reason: None,
                price: None,
            })
            .collect();
        let units = if service_id == super::services::COMPARE {
            let mut unit = units[0].clone();
            unit.input_hash = hash(&serde_json::to_vec(&documents).unwrap());
            vec![unit]
        } else {
            units
        };
        let quote_digest = hash(
            serde_json::to_vec(&(
                service.id,
                &requirements,
                &id,
                &units.iter().map(|u| &u.input_hash).collect::<Vec<_>>(),
                amount,
                created_at + 1800,
            ))
            .unwrap()
            .as_slice(),
        );
        Ok(Self {
            resolution: vec![],
            refunds: vec![],
            legacy_refund_units: None,
            purchase: None,
            dispute: None,
            id,
            workspace: principal.workspace.clone(),
            principal: principal.id.clone(),
            created_at,
            offer_version: service.id.into(),
            requirements,
            documents,
            units,
            amount,
            quote_digest,
            quote_expires_at: created_at + 1800,
            approved_at: None,
            order: None,
            order_id: None,
            approval_url: None,
            capture: None,
            capture_id: None,
            captured: false,
            subscription_funding: None,
            payment_review: None,
            refund: None,
            refund_id: None,
            refund_amount: Cents(0),
            refund_confirmed: false,
            share_token: None,
        })
    }

    pub fn output_price(&self) -> Result<Cents, Error> {
        let count = self.units.len() as u64;
        if count == 0 || self.amount.0 == 0 || self.amount.0 % count != 0 {
            return Err(Error::Invalid(
                "Historical output allocation requires review",
            ));
        }
        Ok(Cents(self.amount.0 / count))
    }
    /// Catalog units carry their own price; document units share the task amount evenly.
    pub fn unit_price(&self, index: usize) -> Result<Cents, Error> {
        match self.units.get(index).and_then(|u| u.price) {
            Some(price) => Ok(price),
            None => self.output_price(),
        }
    }
    pub fn allowance_units(&self) -> Result<u32, Error> {
        Ok(self.units.len() as u32
            * super::services::get(&self.offer_version)?.allowance_units_per_output)
    }
    pub fn verified_funded(&self) -> bool {
        self.payment_review.is_none() && (self.subscription_funding.is_some() || self.captured)
    }
    pub fn can_read(&self, p: &Principal) -> bool {
        self.workspace == p.workspace
            && (p.role == Role::Merchant
                || self.principal == p.id
                || (p.role == Role::Buyer
                    && self
                        .subscription_funding
                        .as_ref()
                        .is_some_and(|f| f.buyer == p.id))
                || (p.role == Role::Buyer
                    && self.purchase.as_ref().is_some_and(|c| c.buyer == p.id)))
    }
    pub fn buyer(&self, p: &Principal) -> Result<(), Error> {
        if p.role != Role::Buyer || !self.can_read(p) {
            Err(Error::Forbidden)
        } else {
            Ok(())
        }
    }
    pub fn merchant(&self, p: &Principal) -> Result<(), Error> {
        if p.role != Role::Merchant || !self.can_read(p) {
            Err(Error::Forbidden)
        } else {
            Ok(())
        }
    }
    pub fn start_checkout(&mut self, p: &Principal, digest: &str) -> Result<Option<String>, Error> {
        self.buyer(p)?;
        // Catalog purchases are paid through the allowance only, never PayPal checkout.
        if self.subscription_funding.is_some() || self.purchase.is_some() {
            return Err(Error::Conflict);
        }
        if digest != self.quote_digest {
            return Err(Error::Conflict);
        }
        if self.order.is_some() {
            return Ok(None);
        }
        if now() > self.quote_expires_at {
            return Err(Error::Invalid("Quote expired; no payment submitted"));
        }
        self.approved_at = Some(now());
        let op = Operation::begin()?;
        let key = op.key.clone();
        self.order = Some(op);
        Ok(Some(key))
    }
    /// Claims the vault charge for a catalog purchase. The policy verdict was
    /// written inside the allowance transaction; an ask_first purchase, or an
    /// ask_above one over its threshold, also needs the buyer's approval first.
    pub fn start_vault_charge(&mut self, p: &Principal) -> Result<Option<String>, Error> {
        if !matches!(p.role, Role::Buyer | Role::Agent) || !self.can_read(p) {
            return Err(Error::Forbidden);
        }
        let purchase = self.purchase.as_ref().ok_or(Error::Conflict)?;
        if !matches!(
            purchase.mode.as_str(),
            "agent_pays" | "ask_first" | "ask_above"
        ) || !purchase.policy.allowed
            || ((purchase.mode == "ask_first" || purchase.approval.is_some())
                && purchase.approval.as_deref() != Some("approved"))
        {
            return Err(Error::Conflict);
        }
        if self.order.is_some() {
            return Ok(None);
        }
        self.approved_at = Some(now());
        let op = Operation::begin()?;
        let key = op.key.clone();
        self.order = Some(op);
        Ok(Some(key))
    }
    pub fn refund_proposal(&self) -> Result<(Cents, String), Error> {
        if self.subscription_funding.is_some()
            || !self.refunds.is_empty()
            || self.payment_review.is_some()
            || !self.captured
            || self.capture_id.is_none()
            || self.units.iter().any(|u| {
                matches!(
                    u.state,
                    UnitState::Pending | UnitState::Processing | UnitState::Unknown
                )
            })
        {
            return Err(Error::Invalid(
                "Refund requires captured payment and resolved work outcomes",
            ));
        }
        let failed: Vec<_> = self
            .units
            .iter()
            .enumerate()
            .filter(|(_, u)| u.state == UnitState::Failed)
            .map(|(i, u)| (i, &u.input_hash))
            .collect();
        let mut amount = Cents(0);
        for (i, _) in &failed {
            amount = Cents(amount.0 + self.unit_price(*i)?.0);
        }
        if amount.0 == 0 {
            return Err(Error::Invalid("No failed units to refund"));
        }
        let digest =
            hash(&serde_json::to_vec(&(&self.id, &self.capture_id, failed, amount)).unwrap());
        Ok((amount, digest))
    }
    pub fn approve_refund(&mut self, p: &Principal, digest: &str) -> Result<Option<String>, Error> {
        self.merchant(p)?;
        let (amount, expected) = self.refund_proposal()?;
        if digest != expected {
            return Err(Error::Conflict);
        }
        if self.refund.is_some() {
            return Ok(None);
        }
        let op = Operation::begin()?;
        let key = op.key.clone();
        self.legacy_refund_units = Some(
            self.units
                .iter()
                .enumerate()
                .filter(|(_, u)| u.state == UnitState::Failed)
                .map(|(i, _)| i)
                .collect(),
        );
        self.refund_amount = amount;
        self.refund = Some(op);
        Ok(Some(key))
    }
    pub fn net(&self) -> Option<Cents> {
        if self.payment_review.is_some() || !self.captured {
            return None;
        }
        self.amount
            .0
            .checked_sub(self.confirmed_refunds())
            .map(Cents)
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn random_id() -> Result<String, Error> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Error::Invalid("Secure randomness unavailable"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn buyer() -> Principal {
        Principal {
            id: "buyer".into(),
            workspace: "workspace".into(),
            role: Role::Buyer,
        }
    }
    #[test]
    fn agent_cannot_approve_and_changed_quote_cannot_dispatch() {
        let p = buyer();
        let mut task = Task::quote(
            &p,
            vec![Document {
                name: "doc".into(),
                text: "input".into(),
            }],
        )
        .unwrap();
        let digest = task.quote_digest.clone();
        let mut agent = p.clone();
        agent.role = Role::Agent;
        assert!(task.start_checkout(&agent, &digest).is_err());
        assert!(task.start_checkout(&p, "changed").is_err());
        assert!(task.start_checkout(&p, &digest).unwrap().is_some());
        assert!(task.start_checkout(&p, &digest).unwrap().is_none());
    }
    #[test]
    fn failed_units_bind_refund_and_unknown_does_not_reduce_cost() {
        let p = buyer();
        let mut task = Task::quote(
            &p,
            vec![
                Document {
                    name: "a".into(),
                    text: "a".into(),
                },
                Document {
                    name: "b".into(),
                    text: "b".into(),
                },
            ],
        )
        .unwrap();
        task.captured = true;
        task.capture_id = Some("capture".into());
        task.units[0].state = UnitState::Delivered;
        assert!(task.refund_proposal().is_err());
        task.units[1].state = UnitState::Failed;
        let (amount, digest) = task.refund_proposal().unwrap();
        assert_eq!(amount, Cents(400));
        assert!(task.approve_refund(&p, &digest).is_err());
        let mut merchant = p;
        merchant.role = Role::Merchant;
        assert!(task.approve_refund(&merchant, &digest).unwrap().is_some());
        assert!(task.approve_refund(&merchant, &digest).unwrap().is_none());
        task.refund.as_mut().unwrap().unknown();
        assert_eq!(task.net(), Some(Cents(800)));
        task.refund_confirmed = true;
        assert_eq!(task.net(), Some(Cents(400)));
        merchant.workspace = "other".into();
        assert!(!task.can_read(&merchant));
    }
}
