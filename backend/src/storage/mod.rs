//! Off-chain status and metadata storage boundary.
//!
//! The backend deliberately stores only public payment metadata and transaction
//! lifecycle state. Wallet keys and seed phrases never enter this module.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::RwLock;

use crate::status::{PaymentRecord, TransactionRecord};

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("could not read status store: {0}")]
    Read(#[from] std::io::Error),
    #[error("could not decode status store: {0}")]
    Decode(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PersistedState {
    payments: HashMap<String, PaymentRecord>,
    transactions: HashMap<String, TransactionRecord>,
}

#[derive(Debug, Clone)]
pub struct StatusStore {
    state: Arc<RwLock<PersistedState>>,
    path: Option<PathBuf>,
}

impl Default for StatusStore {
    fn default() -> Self {
        Self::in_memory()
    }
}

impl StatusStore {
    pub fn in_memory() -> Self {
        Self {
            state: Arc::new(RwLock::new(PersistedState::default())),
            path: None,
        }
    }

    pub fn from_env() -> Result<Self, StorageError> {
        let path = std::env::var_os("CHAINPAY_STATUS_FILE").map(PathBuf::from);
        Self::from_path(path)
    }

    pub fn from_path(path: Option<PathBuf>) -> Result<Self, StorageError> {
        let persisted = match path.as_deref() {
            Some(path) if path.exists() => {
                let bytes = fs::read(path)?;
                serde_json::from_slice(&bytes)?
            }
            _ => PersistedState::default(),
        };

        Ok(Self {
            state: Arc::new(RwLock::new(persisted)),
            path,
        })
    }

    pub async fn get_payment(&self, payment_id: &str) -> Option<PaymentRecord> {
        self.state.read().await.payments.get(payment_id).cloned()
    }

    pub async fn find_payment_by_idempotency(&self, key: &str) -> Option<PaymentRecord> {
        self.state
            .read()
            .await
            .payments
            .values()
            .find(|record| record.idempotency_key == key)
            .cloned()
    }

    pub async fn put_payment(&self, record: PaymentRecord) -> Result<(), StorageError> {
        let snapshot = {
            let mut state = self.state.write().await;
            state.payments.insert(record.payment_id.clone(), record);
            state.clone()
        };
        self.persist(&snapshot)
    }

    pub async fn get_transaction(&self, transaction_id: &str) -> Option<TransactionRecord> {
        self.state
            .read()
            .await
            .transactions
            .get(transaction_id)
            .cloned()
    }

    pub async fn find_transaction_by_idempotency(&self, key: &str) -> Option<TransactionRecord> {
        self.state
            .read()
            .await
            .transactions
            .values()
            .find(|record| record.idempotency_key == key)
            .cloned()
    }

    pub async fn put_transaction(&self, record: TransactionRecord) -> Result<(), StorageError> {
        let snapshot = {
            let mut state = self.state.write().await;
            state
                .transactions
                .insert(record.transaction_id.clone(), record);
            state.clone()
        };
        self.persist(&snapshot)
    }

    fn persist(&self, state: &PersistedState) -> Result<(), StorageError> {
        let Some(path) = &self.path else {
            return Ok(());
        };

        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)?;
        }

        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(state)?;
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, path)?;
        Ok(())
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::PaymentStatus;

    fn payment() -> PaymentRecord {
        PaymentRecord {
            payment_id: "payment-1".into(),
            idempotency_key: "invoice-1".into(),
            mandate: "mandate".into(),
            invoice_hash: "00".repeat(32),
            receipt_address: None,
            agent: None,
            mint: None,
            recipient: None,
            amount: None,
            token_program: None,
            signature: None,
            slot: None,
            status: PaymentStatus::Prepared,
            simulation: None,
            error: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[tokio::test]
    async fn stores_and_reads_idempotent_payment_records() {
        let store = StatusStore::in_memory();
        store.put_payment(payment()).await.unwrap();

        assert_eq!(
            store
                .find_payment_by_idempotency("invoice-1")
                .await
                .unwrap()
                .payment_id,
            "payment-1"
        );
    }
}
