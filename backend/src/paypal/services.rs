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

/// Shared byte/count constraints for raw quotes and preflight.
pub fn validate_inputs(documents: &[Document]) -> Result<(), Error> {
    if documents.is_empty()
        || documents.len() > 10
        || documents
            .iter()
            .any(|d| d.name.trim().is_empty() || d.name.len() > 120 || d.text.len() > 16_000)
    {
        return Err(Error::Invalid(
            "Use 1–10 named documents, names up to 120 bytes and text up to 16,000 bytes each",
        ));
    }
    Ok(())
}
pub fn readable(text: &str) -> bool {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .take(30)
        .count()
        >= 30
}
#[derive(Serialize)]
pub struct InputIssue {
    pub document_index: usize,
    pub message: &'static str,
}
#[derive(Serialize)]
pub struct Preflight {
    pub ready: bool,
    pub service_id: &'static str,
    pub outputs: usize,
    pub unit_price: String,
    pub amount: String,
    pub currency: &'static str,
    pub issues: Vec<InputIssue>,
}
pub fn preflight(
    id: &str,
    documents: &[Document],
    requirements: Option<&str>,
) -> Result<Preflight, Error> {
    let service = get(id)?;
    service.validate(documents, requirements)?;
    validate_inputs(documents)?;
    let issues: Vec<_> = documents
        .iter()
        .enumerate()
        .filter(|(_, d)| !readable(&d.text))
        .map(|(document_index, _)| InputIssue {
            document_index,
            message: "Supply at least 30 alphanumeric characters of readable source text",
        })
        .collect();
    let outputs = service.outputs(documents.len());
    Ok(Preflight {
        ready: issues.is_empty(),
        service_id: service.id,
        outputs,
        unit_price: service.unit_price.decimal(),
        amount: Cents(outputs as u64 * service.unit_price.0).decimal(),
        currency: "USD",
        issues,
    })
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
    fn preflight_terms_and_readability_are_deterministic() {
        let result = preflight(COMPARE, &docs(), None).unwrap();
        assert!(result.ready);
        assert_eq!(result.amount, "8.00");
        assert_eq!(result.outputs, 1);
        let mut inputs = docs();
        inputs[1].text = "a".repeat(29);
        let result = preflight(COMPARE, &inputs, None).unwrap();
        assert!(!result.ready);
        assert_eq!(result.issues[0].document_index, 1);
        inputs[1].text = "é".repeat(30);
        assert!(preflight(COMPARE, &inputs, None).unwrap().ready);
        inputs[1].text = "é".repeat(8001);
        assert!(preflight(COMPARE, &inputs, None).is_err());
        assert!(Task::quote_service(&buyer(), inputs, COMPARE, None).is_err());
        assert!(preflight(CHECK, &docs(), None).is_err());
        assert!(preflight("unknown", &docs(), None).is_err());
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
