//! Public payment metadata and transaction lifecycle persistence.
//!
//! Production uses PostgreSQL. The in-memory implementation exists only for
//! deterministic unit tests; the backend process refuses to start without a
//! `DATABASE_URL`.

use std::{collections::HashMap, sync::Arc};

use sqlx::{
    PgPool, Row,
    postgres::{PgPoolOptions, PgRow},
    types::Json,
};
use thiserror::Error;
use tokio::sync::RwLock;

use crate::status::{
    PaymentRecord, PaymentStatus, TransactionRecord, X402PaymentRecord, X402PaymentStatus,
};

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("DATABASE_URL is required; production storage cannot fall back to memory")]
    MissingDatabaseUrl,
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
    #[error("database migration error: {0}")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("stored {field} value is invalid: {value}")]
    InvalidValue { field: &'static str, value: String },
    #[error("{field} exceeds PostgreSQL BIGINT range: {value}")]
    ValueOutOfRange { field: &'static str, value: u64 },
}

#[derive(Debug, Default)]
struct MemoryState {
    payments: HashMap<String, PaymentRecord>,
    transactions: HashMap<String, TransactionRecord>,
    x402_payments: HashMap<String, X402PaymentRecord>,
}

#[derive(Debug, Clone)]
enum StorageBackend {
    Memory(Arc<RwLock<MemoryState>>),
    Postgres(PgPool),
}

#[derive(Debug, Clone)]
pub struct StatusStore {
    backend: StorageBackend,
}

impl Default for StatusStore {
    fn default() -> Self {
        Self::in_memory()
    }
}

impl StatusStore {
    /// Unit-test storage. Runtime startup never selects this implementation.
    pub fn in_memory() -> Self {
        Self {
            backend: StorageBackend::Memory(Arc::new(RwLock::new(MemoryState::default()))),
        }
    }

    pub async fn from_env() -> Result<Self, StorageError> {
        let database_url = std::env::var("DATABASE_URL")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .ok_or(StorageError::MissingDatabaseUrl)?;
        Self::connect(&database_url).await
    }

    pub async fn connect(database_url: &str) -> Result<Self, StorageError> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await?;
        sqlx::migrate!().run(&pool).await?;
        Ok(Self {
            backend: StorageBackend::Postgres(pool),
        })
    }

    pub async fn get_payment(
        &self,
        payment_id: &str,
    ) -> Result<Option<PaymentRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Memory(state) => {
                Ok(state.read().await.payments.get(payment_id).cloned())
            }
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(PAYMENT_SELECT_BY_ID)
                    .bind(payment_id)
                    .fetch_optional(pool)
                    .await?;
                row.map(payment_from_row).transpose()
            }
        }
    }

    pub async fn find_payment_by_idempotency(
        &self,
        key: &str,
    ) -> Result<Option<PaymentRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .payments
                .values()
                .find(|record| record.idempotency_key == key)
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(PAYMENT_SELECT_BY_IDEMPOTENCY)
                    .bind(key)
                    .fetch_optional(pool)
                    .await?;
                row.map(payment_from_row).transpose()
            }
        }
    }

    pub async fn find_payment_by_receipt(
        &self,
        receipt_address: &str,
    ) -> Result<Option<PaymentRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .payments
                .values()
                .find(|record| record.receipt_address.as_deref() == Some(receipt_address))
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(PAYMENT_SELECT_BY_RECEIPT)
                    .bind(receipt_address)
                    .fetch_optional(pool)
                    .await?;
                row.map(payment_from_row).transpose()
            }
        }
    }

    pub async fn put_payment(&self, record: PaymentRecord) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Memory(state) => {
                state
                    .write()
                    .await
                    .payments
                    .insert(record.payment_id.clone(), record);
                Ok(())
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO payments (
                        payment_id, idempotency_key, mandate, invoice_hash,
                        receipt_address, agent, mint, recipient, amount,
                        token_program, signature, slot, status, error,
                        created_at_ms, updated_at_ms
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8,
                        CAST($9 AS NUMERIC), $10, $11, $12, $13,
                        $14, $15, $16
                    )
                    ON CONFLICT (payment_id) DO UPDATE SET
                        idempotency_key = EXCLUDED.idempotency_key,
                        mandate = EXCLUDED.mandate,
                        invoice_hash = EXCLUDED.invoice_hash,
                        receipt_address = EXCLUDED.receipt_address,
                        agent = EXCLUDED.agent,
                        mint = EXCLUDED.mint,
                        recipient = EXCLUDED.recipient,
                        amount = EXCLUDED.amount,
                        token_program = EXCLUDED.token_program,
                        signature = EXCLUDED.signature,
                        slot = EXCLUDED.slot,
                        status = EXCLUDED.status,
                        error = EXCLUDED.error,
                        updated_at_ms = EXCLUDED.updated_at_ms
                    "#,
                )
                .bind(&record.payment_id)
                .bind(&record.idempotency_key)
                .bind(&record.mandate)
                .bind(&record.invoice_hash)
                .bind(&record.receipt_address)
                .bind(&record.agent)
                .bind(&record.mint)
                .bind(&record.recipient)
                .bind(record.amount.map(|value| value.to_string()))
                .bind(&record.token_program)
                .bind(&record.signature)
                .bind(to_i64(record.slot, "slot")?)
                .bind(status_name(record.status))
                .bind(&record.error)
                .bind(to_i64(Some(record.created_at_ms), "created_at_ms")?)
                .bind(to_i64(Some(record.updated_at_ms), "updated_at_ms")?)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn get_transaction(
        &self,
        transaction_id: &str,
    ) -> Result<Option<TransactionRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Memory(state) => {
                Ok(state.read().await.transactions.get(transaction_id).cloned())
            }
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(TRANSACTION_SELECT_BY_ID)
                    .bind(transaction_id)
                    .fetch_optional(pool)
                    .await?;
                row.map(transaction_from_row).transpose()
            }
        }
    }

    pub async fn find_transaction_by_idempotency(
        &self,
        key: &str,
    ) -> Result<Option<TransactionRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .transactions
                .values()
                .find(|record| record.idempotency_key == key)
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(TRANSACTION_SELECT_BY_IDEMPOTENCY)
                    .bind(key)
                    .fetch_optional(pool)
                    .await?;
                row.map(transaction_from_row).transpose()
            }
        }
    }

    pub async fn put_transaction(&self, record: TransactionRecord) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Memory(state) => {
                state
                    .write()
                    .await
                    .transactions
                    .insert(record.transaction_id.clone(), record);
                Ok(())
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO transactions (
                        transaction_id, idempotency_key, signature, slot,
                        status, error, created_at_ms, updated_at_ms
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (transaction_id) DO UPDATE SET
                        idempotency_key = EXCLUDED.idempotency_key,
                        signature = EXCLUDED.signature,
                        slot = EXCLUDED.slot,
                        status = EXCLUDED.status,
                        error = EXCLUDED.error,
                        updated_at_ms = EXCLUDED.updated_at_ms
                    "#,
                )
                .bind(&record.transaction_id)
                .bind(&record.idempotency_key)
                .bind(&record.signature)
                .bind(to_i64(record.slot, "slot")?)
                .bind(status_name(record.status))
                .bind(&record.error)
                .bind(to_i64(Some(record.created_at_ms), "created_at_ms")?)
                .bind(to_i64(Some(record.updated_at_ms), "updated_at_ms")?)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn find_x402_by_idempotency(
        &self,
        key: &str,
    ) -> Result<Option<X402PaymentRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .x402_payments
                .values()
                .find(|record| record.idempotency_key == key)
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(X402_SELECT_BY_IDEMPOTENCY)
                    .bind(key)
                    .fetch_optional(pool)
                    .await?;
                row.map(x402_from_row).transpose()
            }
        }
    }

    pub async fn put_x402(&self, record: X402PaymentRecord) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Memory(state) => {
                state
                    .write()
                    .await
                    .x402_payments
                    .insert(record.x402_payment_id.clone(), record);
                Ok(())
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO x402_payments (
                        x402_payment_id, idempotency_key, resource, payment_id,
                        receipt_address, transaction_signature, status, challenge,
                        proof, response_status, error, created_at, updated_at
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                        TO_TIMESTAMP($12::DOUBLE PRECISION / 1000.0),
                        TO_TIMESTAMP($13::DOUBLE PRECISION / 1000.0)
                    )
                    ON CONFLICT (x402_payment_id) DO UPDATE SET
                        resource = EXCLUDED.resource,
                        payment_id = EXCLUDED.payment_id,
                        receipt_address = EXCLUDED.receipt_address,
                        transaction_signature = EXCLUDED.transaction_signature,
                        status = EXCLUDED.status,
                        challenge = EXCLUDED.challenge,
                        proof = EXCLUDED.proof,
                        response_status = EXCLUDED.response_status,
                        error = EXCLUDED.error,
                        updated_at = EXCLUDED.updated_at
                    "#,
                )
                .bind(&record.x402_payment_id)
                .bind(&record.idempotency_key)
                .bind(&record.resource)
                .bind(&record.payment_id)
                .bind(&record.receipt_address)
                .bind(&record.transaction_signature)
                .bind(x402_status_name(record.status))
                .bind(Json(record.challenge.clone()))
                .bind(record.proof.clone().map(Json))
                .bind(record.response_status.map(i32::from))
                .bind(&record.error)
                .bind(to_i64(Some(record.created_at_ms), "created_at_ms")?)
                .bind(to_i64(Some(record.updated_at_ms), "updated_at_ms")?)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }
}

const PAYMENT_SELECT_BY_ID: &str = r#"
    SELECT payment_id, idempotency_key, mandate, invoice_hash, receipt_address,
           agent, mint, recipient, amount::text AS amount_text, token_program,
           signature, slot, status, error, created_at_ms, updated_at_ms
    FROM payments WHERE payment_id = $1
"#;

const PAYMENT_SELECT_BY_IDEMPOTENCY: &str = r#"
    SELECT payment_id, idempotency_key, mandate, invoice_hash, receipt_address,
           agent, mint, recipient, amount::text AS amount_text, token_program,
           signature, slot, status, error, created_at_ms, updated_at_ms
    FROM payments WHERE idempotency_key = $1
"#;

const PAYMENT_SELECT_BY_RECEIPT: &str = r#"
    SELECT payment_id, idempotency_key, mandate, invoice_hash, receipt_address,
           agent, mint, recipient, amount::text AS amount_text, token_program,
           signature, slot, status, error, created_at_ms, updated_at_ms
    FROM payments WHERE receipt_address = $1
    ORDER BY updated_at_ms DESC LIMIT 1
"#;

const TRANSACTION_SELECT_BY_ID: &str = r#"
    SELECT transaction_id, idempotency_key, signature, slot, status, error,
           created_at_ms, updated_at_ms
    FROM transactions WHERE transaction_id = $1
"#;

const TRANSACTION_SELECT_BY_IDEMPOTENCY: &str = r#"
    SELECT transaction_id, idempotency_key, signature, slot, status, error,
           created_at_ms, updated_at_ms
    FROM transactions WHERE idempotency_key = $1
"#;

const X402_SELECT_BY_IDEMPOTENCY: &str = r#"
    SELECT x402_payment_id, idempotency_key, resource, payment_id,
           receipt_address, transaction_signature, status, challenge, proof,
           response_status, error,
           (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT AS created_at_ms,
           (EXTRACT(EPOCH FROM updated_at) * 1000)::BIGINT AS updated_at_ms
    FROM x402_payments WHERE idempotency_key = $1
"#;

fn payment_from_row(row: PgRow) -> Result<PaymentRecord, StorageError> {
    let amount = row
        .try_get::<Option<String>, _>("amount_text")?
        .map(|value| parse_u64("amount", value))
        .transpose()?;
    Ok(PaymentRecord {
        payment_id: row.try_get("payment_id")?,
        idempotency_key: row.try_get("idempotency_key")?,
        mandate: row.try_get("mandate")?,
        invoice_hash: row.try_get("invoice_hash")?,
        receipt_address: row.try_get("receipt_address")?,
        agent: row.try_get("agent")?,
        mint: row.try_get("mint")?,
        recipient: row.try_get("recipient")?,
        amount,
        token_program: row.try_get("token_program")?,
        signature: row.try_get("signature")?,
        slot: from_i64(row.try_get("slot")?, "slot")?,
        status: parse_status(row.try_get("status")?)?,
        error: row.try_get("error")?,
        created_at_ms: from_i64(row.try_get("created_at_ms")?, "created_at_ms")?
            .unwrap_or_default(),
        updated_at_ms: from_i64(row.try_get("updated_at_ms")?, "updated_at_ms")?
            .unwrap_or_default(),
    })
}

fn transaction_from_row(row: PgRow) -> Result<TransactionRecord, StorageError> {
    Ok(TransactionRecord {
        transaction_id: row.try_get("transaction_id")?,
        idempotency_key: row.try_get("idempotency_key")?,
        signature: row.try_get("signature")?,
        slot: from_i64(row.try_get("slot")?, "slot")?,
        status: parse_status(row.try_get("status")?)?,
        error: row.try_get("error")?,
        created_at_ms: from_i64(row.try_get("created_at_ms")?, "created_at_ms")?
            .unwrap_or_default(),
        updated_at_ms: from_i64(row.try_get("updated_at_ms")?, "updated_at_ms")?
            .unwrap_or_default(),
    })
}

fn x402_from_row(row: PgRow) -> Result<X402PaymentRecord, StorageError> {
    Ok(X402PaymentRecord {
        x402_payment_id: row.try_get("x402_payment_id")?,
        idempotency_key: row.try_get("idempotency_key")?,
        resource: row.try_get("resource")?,
        payment_id: row.try_get("payment_id")?,
        receipt_address: row.try_get("receipt_address")?,
        transaction_signature: row.try_get("transaction_signature")?,
        status: parse_x402_status(row.try_get("status")?)?,
        challenge: row.try_get::<Json<serde_json::Value>, _>("challenge")?.0,
        proof: row
            .try_get::<Option<Json<serde_json::Value>>, _>("proof")?
            .map(|value| value.0),
        response_status: row
            .try_get::<Option<i32>, _>("response_status")?
            .map(|value| {
                u16::try_from(value).map_err(|_| StorageError::InvalidValue {
                    field: "response_status",
                    value: value.to_string(),
                })
            })
            .transpose()?,
        error: row.try_get("error")?,
        created_at_ms: from_i64(row.try_get("created_at_ms")?, "created_at_ms")?
            .unwrap_or_default(),
        updated_at_ms: from_i64(row.try_get("updated_at_ms")?, "updated_at_ms")?
            .unwrap_or_default(),
    })
}

fn status_name(status: PaymentStatus) -> &'static str {
    match status {
        PaymentStatus::Prepared => "prepared",
        PaymentStatus::Submitted => "submitted",
        PaymentStatus::Confirmed => "confirmed",
        PaymentStatus::Failed => "failed",
    }
}

fn parse_status(value: String) -> Result<PaymentStatus, StorageError> {
    match value.as_str() {
        "prepared" => Ok(PaymentStatus::Prepared),
        "submitted" => Ok(PaymentStatus::Submitted),
        "confirmed" => Ok(PaymentStatus::Confirmed),
        "failed" => Ok(PaymentStatus::Failed),
        _ => Err(StorageError::InvalidValue {
            field: "status",
            value,
        }),
    }
}

fn x402_status_name(status: X402PaymentStatus) -> &'static str {
    match status {
        X402PaymentStatus::Prepared => "prepared",
        X402PaymentStatus::Submitted => "submitted",
        X402PaymentStatus::Confirmed => "confirmed",
        X402PaymentStatus::Verified => "verified",
        X402PaymentStatus::Failed => "failed",
    }
}

fn parse_x402_status(value: String) -> Result<X402PaymentStatus, StorageError> {
    match value.as_str() {
        "prepared" => Ok(X402PaymentStatus::Prepared),
        "submitted" => Ok(X402PaymentStatus::Submitted),
        "confirmed" => Ok(X402PaymentStatus::Confirmed),
        "verified" => Ok(X402PaymentStatus::Verified),
        "failed" => Ok(X402PaymentStatus::Failed),
        _ => Err(StorageError::InvalidValue {
            field: "x402_status",
            value,
        }),
    }
}

fn parse_u64(field: &'static str, value: String) -> Result<u64, StorageError> {
    value
        .parse()
        .map_err(|_| StorageError::InvalidValue { field, value })
}

fn to_i64(value: Option<u64>, field: &'static str) -> Result<Option<i64>, StorageError> {
    value
        .map(|value| {
            i64::try_from(value).map_err(|_| StorageError::ValueOutOfRange { field, value })
        })
        .transpose()
}

fn from_i64(value: Option<i64>, field: &'static str) -> Result<Option<u64>, StorageError> {
    value
        .map(|value| {
            u64::try_from(value).map_err(|_| StorageError::InvalidValue {
                field,
                value: value.to_string(),
            })
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

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
            error: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[tokio::test]
    async fn stores_and_reads_idempotent_payment_records() {
        let store = StatusStore::in_memory();
        let mut record = payment();
        record.receipt_address = Some("receipt-1".into());
        store.put_payment(record).await.unwrap();

        assert_eq!(
            store
                .find_payment_by_idempotency("invoice-1")
                .await
                .unwrap()
                .unwrap()
                .payment_id,
            "payment-1"
        );
        assert_eq!(
            store
                .find_payment_by_receipt("receipt-1")
                .await
                .unwrap()
                .unwrap()
                .payment_id,
            "payment-1"
        );
    }

    #[test]
    fn rejects_values_outside_postgres_bigint_range() {
        assert!(to_i64(Some(u64::MAX), "slot").is_err());
    }
}
