//! Card connector records (contracts.md §5): one generic, versioned record per
//! key in the existing `records` table, under four additive kinds. Writes are
//! compare-and-swap on a `rev` counter inside the record, so the webhook inbox,
//! the ASA path and the reconciliation job can race without losing updates.
//!
//! Only opaque values (card id, owner wallet, hashes) are ever indexed. Every
//! sensitive field is an AES-GCM envelope produced by the connector before it
//! reaches this layer; Convex re-checks that shape.

use super::{StatusStore, StorageBackend, StorageError};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CardKind {
    Cards,
    CardEvents,
    CardStatements,
    CardRecovery,
}

impl CardKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cards => "cards",
            Self::CardEvents => "card_events",
            Self::CardStatements => "card_statements",
            Self::CardRecovery => "card_recovery",
        }
    }
}

/// Plaintext index columns. Every value must be opaque (ids, hashes, wallets).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CardIndex {
    pub owner: Option<String>,
    pub connector: Option<String>,
    pub reference: Option<String>,
    /// Unique per kind (Convex enforces it). Used for card-token and
    /// capability-hash lookups.
    pub idempotency: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StoredCardRecord {
    pub key: String,
    pub index: CardIndex,
    pub record: Value,
    /// Zero-padded sortable decimal.
    pub updated: String,
}

impl StoredCardRecord {
    pub fn rev(&self) -> u64 {
        self.record["rev"].as_u64().unwrap_or(0)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CardPut {
    /// The write landed. Holds the stored record.
    Written(StoredCardRecord),
    /// `expected_rev` did not match (or the key already existed on a create).
    /// Holds the current record, if any.
    Conflict(Option<StoredCardRecord>),
}

fn sortable(updated: u64) -> String {
    format!("{updated:020}")
}

fn decode_row(value: Value) -> Result<StoredCardRecord, StorageError> {
    let get = |field: &str| value.get(field).and_then(Value::as_str).map(str::to_owned);
    let record_json =
        get("record_json").ok_or_else(|| StorageError::Remote("invalid card record".into()))?;
    let record: Value = serde_json::from_str(&record_json)
        .map_err(|_| StorageError::Remote("invalid card record".into()))?;
    Ok(StoredCardRecord {
        key: get("key").ok_or_else(|| StorageError::Remote("invalid card record".into()))?,
        index: CardIndex {
            owner: get("owner"),
            connector: get("connector"),
            reference: get("reference"),
            idempotency: get("idempotency"),
        },
        record,
        updated: get("updated").unwrap_or_default(),
    })
}

fn unsupported() -> StorageError {
    StorageError::Remote("card records require Convex storage (CHAINPAY_STORAGE=convex)".into())
}

impl StatusStore {
    /// Create (`expected_rev = None`) or compare-and-swap update a card record.
    /// The stored `rev` becomes `expected_rev + 1` (or 1 on create).
    pub async fn put_card_record(
        &self,
        kind: CardKind,
        key: &str,
        index: CardIndex,
        mut record: Value,
        expected_rev: Option<u64>,
        updated: u64,
    ) -> Result<CardPut, StorageError> {
        let next = expected_rev.map_or(1, |rev| rev + 1);
        record["rev"] = json!(next);
        match &self.backend {
            StorageBackend::Convex(client) => {
                let record_json = serde_json::to_string(&record)
                    .map_err(|_| StorageError::Remote("invalid card record".into()))?;
                let result: Value = client
                    .call(
                        "put_card_record",
                        json!({
                            "kind": kind.as_str(), "key": key, "record_json": record_json,
                            "owner": index.owner, "connector": index.connector,
                            "reference": index.reference, "idempotency": index.idempotency,
                            "expected_rev": expected_rev.map(|rev| rev.to_string()),
                            "updated": updated.to_string(),
                        }),
                    )
                    .await?;
                let written = result["written"].as_bool().unwrap_or(false);
                let current = match result.get("record") {
                    Some(Value::Null) | None => None,
                    Some(row) => Some(decode_row(row.clone())?),
                };
                Ok(match (written, current) {
                    (true, Some(row)) => CardPut::Written(row),
                    (true, None) => return Err(StorageError::Remote("invalid card put".into())),
                    (false, current) => CardPut::Conflict(current),
                })
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                #[cfg(test)]
                if state
                    .card_write_fault
                    .as_ref()
                    .is_some_and(|fault| (fault.0)(kind, key, &record))
                {
                    return Err(StorageError::Remote("injected card write failure".into()));
                }
                let slot = (kind, key.to_owned());
                let current = state.card_records.get(&slot).cloned();
                let current_rev = current.as_ref().map(StoredCardRecord::rev);
                if current_rev != expected_rev {
                    return Ok(CardPut::Conflict(current));
                }
                if let Some(idempotency) = &index.idempotency {
                    if state.card_records.iter().any(|((k, other_key), row)| {
                        *k == kind
                            && other_key != key
                            && row.index.idempotency.as_ref() == Some(idempotency)
                    }) {
                        return Err(StorageError::Remote(
                            "card record idempotency key already exists".into(),
                        ));
                    }
                }
                let row = StoredCardRecord {
                    key: key.to_owned(),
                    index,
                    record,
                    updated: sortable(updated),
                };
                state.card_records.insert(slot, row.clone());
                Ok(CardPut::Written(row))
            }
            StorageBackend::Postgres(_) => Err(unsupported()),
        }
    }

    pub async fn get_card_record(
        &self,
        kind: CardKind,
        key: &str,
    ) -> Result<Option<StoredCardRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let row: Value = client
                    .call(
                        "get_card_record",
                        json!({"kind": kind.as_str(), "key": key}),
                    )
                    .await?;
                if row.is_null() {
                    Ok(None)
                } else {
                    decode_row(row).map(Some)
                }
            }
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .card_records
                .get(&(kind, key.to_owned()))
                .cloned()),
            StorageBackend::Postgres(_) => Err(unsupported()),
        }
    }

    pub async fn find_card_record_by_idempotency(
        &self,
        kind: CardKind,
        idempotency: &str,
    ) -> Result<Option<StoredCardRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let row: Value = client
                    .call(
                        "find_card_record_by_idempotency",
                        json!({"kind": kind.as_str(), "idempotency": idempotency}),
                    )
                    .await?;
                if row.is_null() {
                    Ok(None)
                } else {
                    decode_row(row).map(Some)
                }
            }
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .card_records
                .iter()
                .find(|((k, _), row)| {
                    *k == kind && row.index.idempotency.as_deref() == Some(idempotency)
                })
                .map(|(_, row)| row.clone())),
            StorageBackend::Postgres(_) => Err(unsupported()),
        }
    }

    /// Card registry lookup by the opaque issuer-card reference
    /// (`sha256("chainpay-lithic-card:v1\n" + card_token)`), which the
    /// `cards` kind stores in its unique idempotency column.
    pub async fn find_card_by_reference(
        &self,
        reference: &str,
    ) -> Result<Option<StoredCardRecord>, StorageError> {
        self.find_card_record_by_idempotency(CardKind::Cards, reference)
            .await
    }

    /// Newest first, `updated < before`. All of owner, connector and reference
    /// are required so one listing can never cross cards or owners.
    pub async fn list_card_records_for_owner(
        &self,
        kind: CardKind,
        owner: &str,
        connector: &str,
        reference: &str,
        before: Option<&str>,
        limit: u32,
    ) -> Result<Vec<StoredCardRecord>, StorageError> {
        let limit = limit.clamp(1, 200);
        match &self.backend {
            StorageBackend::Convex(client) => {
                let rows: Vec<Value> = client
                    .call(
                        "list_card_records_for_owner",
                        json!({
                            "kind": kind.as_str(), "owner": owner, "connector": connector,
                            "reference": reference, "before": before, "limit": limit,
                        }),
                    )
                    .await?;
                rows.into_iter().map(decode_row).collect()
            }
            StorageBackend::Memory(state) => {
                let state = state.read().await;
                let mut rows: Vec<StoredCardRecord> = state
                    .card_records
                    .iter()
                    .filter(|((k, _), row)| {
                        *k == kind
                            && row.index.owner.as_deref() == Some(owner)
                            && row.index.connector.as_deref() == Some(connector)
                            && row.index.reference.as_deref() == Some(reference)
                            && before.is_none_or(|before| row.updated.as_str() < before)
                    })
                    .map(|(_, row)| row.clone())
                    .collect();
                rows.sort_by(|a, b| b.updated.cmp(&a.updated).then(b.key.cmp(&a.key)));
                rows.truncate(limit as usize);
                Ok(rows)
            }
            StorageBackend::Postgres(_) => Err(unsupported()),
        }
    }

    /// Key-ordered scan of one kind (`key > after`, keys starting with
    /// `prefix`). Used by the bounded reconciliation job.
    pub async fn scan_card_records(
        &self,
        kind: CardKind,
        prefix: &str,
        after: Option<&str>,
        limit: u32,
    ) -> Result<Vec<StoredCardRecord>, StorageError> {
        let limit = limit.clamp(1, 100);
        match &self.backend {
            StorageBackend::Convex(client) => {
                let rows: Vec<Value> = client
                    .call(
                        "scan_card_records",
                        json!({"kind": kind.as_str(), "prefix": prefix, "after": after, "limit": limit}),
                    )
                    .await?;
                rows.into_iter().map(decode_row).collect()
            }
            StorageBackend::Memory(state) => {
                let state = state.read().await;
                let mut rows: Vec<StoredCardRecord> = state
                    .card_records
                    .iter()
                    .filter(|((k, key), _)| {
                        *k == kind
                            && key.starts_with(prefix)
                            && after.is_none_or(|after| key.as_str() > after)
                    })
                    .map(|(_, row)| row.clone())
                    .collect();
                rows.sort_by(|a, b| a.key.cmp(&b.key));
                rows.truncate(limit as usize);
                Ok(rows)
            }
            StorageBackend::Postgres(_) => Err(unsupported()),
        }
    }

    /// Test and scanner support: every card record this store holds, as stored.
    #[cfg(test)]
    pub(crate) async fn all_card_records(&self) -> Vec<StoredCardRecord> {
        match &self.backend {
            StorageBackend::Memory(state) => {
                state.read().await.card_records.values().cloned().collect()
            }
            _ => Vec::new(),
        }
    }

    /// Test fault injection: card record puts matching `fault` fail until cleared.
    #[cfg(test)]
    pub(crate) async fn fail_card_writes(&self, fault: Option<CardWriteFault>) {
        if let StorageBackend::Memory(state) = &self.backend {
            state.write().await.card_write_fault = fault;
        }
    }

    /// Test and scanner support: every operation claim, as stored.
    #[cfg(test)]
    pub(crate) async fn all_operation_claims(&self) -> Vec<(String, Value, Value)> {
        match &self.backend {
            StorageBackend::Memory(state) => {
                state.read().await.operations.values().cloned().collect()
            }
            _ => Vec::new(),
        }
    }
}

/// Predicate over (kind, key, record) for injected card write failures.
#[cfg(test)]
#[derive(Clone)]
pub(crate) struct CardWriteFault(
    pub std::sync::Arc<dyn Fn(CardKind, &str, &Value) -> bool + Send + Sync>,
);

#[cfg(test)]
impl std::fmt::Debug for CardWriteFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CardWriteFault")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn compare_and_swap_creates_once_and_rejects_stale_revisions() {
        let store = StatusStore::in_memory();
        let index = CardIndex {
            owner: Some("owner".into()),
            connector: Some("lithic".into()),
            reference: Some("card".into()),
            idempotency: None,
        };
        let first = store
            .put_card_record(
                CardKind::CardEvents,
                "asa:t",
                index.clone(),
                json!({"v":1}),
                None,
                10,
            )
            .await
            .unwrap();
        let CardPut::Written(row) = first else {
            panic!()
        };
        assert_eq!(row.rev(), 1);
        let again = store
            .put_card_record(
                CardKind::CardEvents,
                "asa:t",
                index.clone(),
                json!({"v":1}),
                None,
                11,
            )
            .await
            .unwrap();
        assert!(matches!(again, CardPut::Conflict(Some(ref current)) if current.rev() == 1));
        let update = store
            .put_card_record(
                CardKind::CardEvents,
                "asa:t",
                index.clone(),
                json!({"v":1,"s":2}),
                Some(1),
                12,
            )
            .await
            .unwrap();
        assert!(matches!(update, CardPut::Written(ref row) if row.rev() == 2));
        let stale = store
            .put_card_record(
                CardKind::CardEvents,
                "asa:t",
                index.clone(),
                json!({"v":1}),
                Some(1),
                13,
            )
            .await
            .unwrap();
        assert!(matches!(stale, CardPut::Conflict(_)));
        let listed = store
            .list_card_records_for_owner(CardKind::CardEvents, "owner", "lithic", "card", None, 10)
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert!(
            store
                .list_card_records_for_owner(
                    CardKind::CardEvents,
                    "other",
                    "lithic",
                    "card",
                    None,
                    10
                )
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn idempotency_column_is_unique_per_kind() {
        let store = StatusStore::in_memory();
        let index = CardIndex {
            idempotency: Some("ref".into()),
            ..Default::default()
        };
        store
            .put_card_record(
                CardKind::Cards,
                "card:a",
                index.clone(),
                json!({"v":1}),
                None,
                1,
            )
            .await
            .unwrap();
        assert!(
            store
                .put_card_record(CardKind::Cards, "card:b", index, json!({"v":1}), None, 2)
                .await
                .is_err()
        );
        assert_eq!(
            store
                .find_card_by_reference("ref")
                .await
                .unwrap()
                .unwrap()
                .key,
            "card:a"
        );
    }
}
