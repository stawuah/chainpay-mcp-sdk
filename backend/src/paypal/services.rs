//! Versioned, deployment-owned service definitions. Inputs cannot set prices or handlers.
use super::{
    domain::{Document, Error, OFFER_VERSION},
    money::Cents,
};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct Service {
    pub id: &'static str,
    pub name: &'static str,
    pub unit_price: Cents,
    pub min_documents: usize,
    pub max_documents: usize,
    pub allowance_units_per_output: u32,
    pub delivery: &'static str,
    pub requires_requirements: bool,
}

pub const COMPARE: &str = "document-compare-v1";
pub const CHECK: &str = "requirements-check-v1";

pub fn catalog() -> Vec<Service> {
    vec![
        Service {
            id: OFFER_VERSION,
            name: "Evidence-linked document summary",
            unit_price: Cents(400),
            min_documents: 1,
            max_documents: 10,
            allowance_units_per_output: 1,
            delivery: "Summary and claims with exact source excerpts per readable document",
            requires_requirements: false,
        },
        Service {
            id: COMPARE,
            name: "Compare two documents",
            unit_price: Cents(800),
            min_documents: 2,
            max_documents: 2,
            allowance_units_per_output: 2,
            delivery: "Comparison of the supplied documents with exact source excerpts",
            requires_requirements: false,
        },
        Service {
            id: CHECK,
            name: "Check supplied requirements",
            unit_price: Cents(400),
            min_documents: 1,
            max_documents: 10,
            allowance_units_per_output: 1,
            delivery: "Assessment against buyer-supplied requirements, with exact source excerpts and explicit missing evidence",
            requires_requirements: true,
        },
    ]
}

pub fn get(id: &str) -> Result<Service, Error> {
    catalog()
        .into_iter()
        .find(|s| s.id == id)
        .ok_or(Error::Invalid("Unknown service version"))
}
impl Service {
    pub fn validate(
        &self,
        documents: &[Document],
        requirements: Option<&str>,
    ) -> Result<(), Error> {
        if documents.len() < self.min_documents || documents.len() > self.max_documents {
            return Err(Error::Invalid(
                "Document count does not match the selected service",
            ));
        }
        if self.requires_requirements {
            if !requirements.is_some_and(|r| !r.trim().is_empty() && r.len() <= 4000) {
                return Err(Error::Invalid("Supply requirements of 1–4000 bytes"));
            }
        } else if requirements.is_some_and(|r| !r.is_empty()) {
            return Err(Error::Invalid("This service does not accept requirements"));
        }
        Ok(())
    }
    pub fn outputs(&self, documents: usize) -> usize {
        if self.id == COMPARE { 1 } else { documents }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paypal::domain::{Principal, Role, Task, UnitState};
    fn buyer() -> Principal {
        Principal {
            id: "buyer".into(),
            workspace: "merchant".into(),
            role: Role::Buyer,
        }
    }
    fn docs() -> Vec<Document> {
        vec![
            Document {
                name: "A".into(),
                text: "First source describes delivery in three working days.".into(),
            },
            Document {
                name: "B".into(),
                text: "Second source describes delivery in seven working days.".into(),
            },
        ]
    }
    #[test]
    fn comparison_is_one_eight_dollar_output_and_refund() {
        let mut task = Task::quote_service(&buyer(), docs(), COMPARE, None).unwrap();
        assert_eq!(task.units.len(), 1);
        assert_eq!(task.amount, Cents(800));
        assert_eq!(task.allowance_units().unwrap(), 2);
        task.captured = true;
        task.capture_id = Some("capture".into());
        task.units[0].state = UnitState::Failed;
        assert_eq!(task.refund_proposal().unwrap().0, Cents(800));
    }
    #[test]
    fn service_constraints_are_enforced_before_checkout() {
        assert!(Task::quote_service(&buyer(), docs()[..1].to_vec(), COMPARE, None).is_err());
        assert!(Task::quote_service(&buyer(), docs(), CHECK, None).is_err());
        assert!(Task::quote_service(&buyer(), docs(), "custom-price", None).is_err());
        let task = Task::quote_service(
            &buyer(),
            docs(),
            CHECK,
            Some("Delivery within five days".into()),
        )
        .unwrap();
        assert_eq!(task.amount, Cents(800));
        assert_eq!(task.units.len(), 2);
    }
    #[test]
    fn old_task_records_remain_readable() {
        let task = Task::quote(&buyer(), docs()).unwrap();
        let mut value = serde_json::to_value(task).unwrap();
        value.as_object_mut().unwrap().remove("requirements");
        let restored: Task = serde_json::from_value(value).unwrap();
        assert_eq!(restored.amount, Cents(800));
        assert!(restored.requirements.is_none());
    }
}
