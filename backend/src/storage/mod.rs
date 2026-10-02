//! Public payment metadata and transaction lifecycle persistence.
//!
//! Production uses explicitly selected Convex or PostgreSQL storage. The in-memory implementation exists only for
//! deterministic unit tests; the backend process refuses to start without a
//! `DATABASE_URL`.

mod convex;
use convex::{ConvexStore, decode, encode};
use serde_json::json;
use std::{collections::HashMap, sync::Arc};

use sqlx::{
    PgPool, Row,
    postgres::{PgPoolOptions, PgRow},
    types::Json,
};
use thiserror::Error;
use tokio::sync::RwLock;

use crate::delivery::{DeliveryAttestationPut, DeliveryAttestationRecord};
use crate::receipts::{ObservedPolicyRecord, ReceiptPolicyLimits, ReceiptRequestRecord};
use crate::status::{
    ConnectorKind, ManagedSignerChallenge, ManagedSignerRecord, ManagedSignerStatus, PaymentRecord,
    PaymentStatus, SigningMode, TransactionRecord, X402PaymentRecord, X402PaymentStatus,
};

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("Convex storage error: {0}")]
    Remote(String),
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
    operations: HashMap<String, (String, serde_json::Value, serde_json::Value)>,
    auth: HashMap<String, (serde_json::Value, u64)>,
    payments: HashMap<String, PaymentRecord>,
    transactions: HashMap<String, TransactionRecord>,
    x402_payments: HashMap<String, X402PaymentRecord>,
    managed_signer_challenges: HashMap<String, ManagedSignerChallenge>,
    managed_signers: HashMap<String, ManagedSignerRecord>,
    delivery_attestations: HashMap<String, DeliveryAttestationRecord>,
    receipt_requests: HashMap<String, ReceiptRequestRecord>,
    observed_policies: HashMap<String, ObservedPolicyRecord>,
    mandate_requests: HashMap<String, serde_json::Value>,
}

/// Outcome of a first-write-wins keyed record put. The caller decides whether
/// an existing record is the same one or a conflict.
#[derive(Debug, Clone, PartialEq)]
pub enum KeyedRecordPut {
    Created(serde_json::Value),
    Existing(serde_json::Value),
}

#[derive(Debug, Clone)]
enum StorageBackend {
    Memory(Arc<RwLock<MemoryState>>),
    Postgres(PgPool),
    Convex(ConvexStore),
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
        if std::env::var("CHAINPAY_STORAGE").as_deref() == Ok("convex") {
            let url = std::env::var("CHAINPAY_CONVEX_SITE_URL")
                .map_err(|_| StorageError::Remote("CHAINPAY_CONVEX_SITE_URL is required".into()))?;
            let secret = std::env::var("CHAINPAY_CONVEX_BACKEND_SECRET").map_err(|_| {
                StorageError::Remote("CHAINPAY_CONVEX_BACKEND_SECRET is required".into())
            })?;
            let client = ConvexStore::new(&url, secret)?;
            let _: serde_json::Value = client.call("ping", json!({})).await?;
            return Ok(Self {
                backend: StorageBackend::Convex(client),
            });
        }
        if std::env::var("CHAINPAY_STORAGE").is_ok_and(|s| s != "postgres")
            || std::env::var("VERCEL").as_deref() == Ok("1")
        {
            return Err(StorageError::Remote(
                "CHAINPAY_STORAGE=convex is required on Vercel; unknown storage selection refused"
                    .into(),
            ));
        }
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

    /// Returns the original reservation and whether this caller alone owns the effect.
    pub async fn claim_operation(
        &self,
        id: &str,
        owner: &str,
        intent: serde_json::Value,
        initial: serde_json::Value,
    ) -> Result<(bool, String, serde_json::Value, serde_json::Value), StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let (won, owner, intent, initial): (bool, String, String, String) = client.call("claim_operation", json!({"id":id,"owner":owner,"intent_json":encode(&intent)?,"initial_json":encode(&initial)?})).await?;
                Ok((won, owner, decode(&intent)?, decode(&initial)?))
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let won = !state.operations.contains_key(id);
                let record =
                    state
                        .operations
                        .entry(id.into())
                        .or_insert((owner.into(), intent, initial));
                Ok((won, record.0.clone(), record.1.clone(), record.2.clone()))
            }
            StorageBackend::Postgres(pool) => {
                let won = sqlx::query("INSERT INTO operation_claims (operation_id,owner_wallet,intent,initial_record) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING")
                    .bind(id).bind(owner).bind(Json(intent)).bind(Json(initial)).execute(pool).await?.rows_affected() == 1;
                let row = sqlx::query("SELECT owner_wallet,intent,initial_record FROM operation_claims WHERE operation_id=$1").bind(id).fetch_one(pool).await?;
                Ok((
                    won,
                    row.get("owner_wallet"),
                    row.get::<Json<serde_json::Value>, _>("intent").0,
                    row.get::<Json<serde_json::Value>, _>("initial_record").0,
                ))
            }
        }
    }

    pub async fn operation_record(
        &self,
        id: &str,
    ) -> Result<Option<(String, serde_json::Value, serde_json::Value)>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => { let row: Option<(String,String,String)> = client.call("operation_record", json!({"id":id})).await?;
                row.map(|(owner,intent,initial)| Ok((owner,decode(&intent)?,decode(&initial)?))).transpose() },
            StorageBackend::Memory(state) => Ok(state.read().await.operations.get(id).cloned()),
            StorageBackend::Postgres(pool) => Ok(sqlx::query("SELECT owner_wallet,intent,initial_record FROM operation_claims WHERE operation_id=$1").bind(id).fetch_optional(pool).await?.map(|r| (r.get("owner_wallet"),r.get::<Json<serde_json::Value>,_>("intent").0,r.get::<Json<serde_json::Value>,_>("initial_record").0))),
        }
    }

    pub async fn operation_owner(&self, id: &str) -> Result<Option<String>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client.call("operation_owner", json!({"id":id})).await
            }
            StorageBackend::Memory(state) => {
                Ok(state.read().await.operations.get(id).map(|r| r.0.clone()))
            }
            StorageBackend::Postgres(pool) => Ok(sqlx::query(
                "SELECT owner_wallet FROM operation_claims WHERE operation_id=$1",
            )
            .bind(id)
            .fetch_optional(pool)
            .await?
            .map(|r| r.get("owner_wallet"))),
        }
    }

    pub async fn auth_rate(
        &self,
        bucket: &str,
        now: u64,
        limit: u64,
    ) -> Result<bool, StorageError> {
        let key = format!("rate:{bucket}:{}", now / 60_000);
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .call(
                        "auth_rate",
                        json!({"bucket":bucket,"now":now.to_string(),"limit":limit.to_string()}),
                    )
                    .await
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                state.auth.retain(|_, (_, expires)| *expires > now);
                let entry = state
                    .auth
                    .entry(key)
                    .or_insert((serde_json::json!(0), now + 60_000));
                let count = entry.0.as_u64().unwrap_or(0) + 1;
                entry.0 = serde_json::json!(count);
                Ok(count <= limit)
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query("DELETE FROM owner_auth WHERE expires_at_ms <= $1")
                    .bind(to_i64(Some(now), "now")?)
                    .execute(pool)
                    .await?;
                let row = sqlx::query("INSERT INTO owner_auth (key,payload,expires_at_ms) VALUES ($1,'1'::jsonb,$2) ON CONFLICT (key) DO UPDATE SET payload=to_jsonb((owner_auth.payload::text)::bigint+1) RETURNING payload")
                    .bind(key).bind(to_i64(Some(now+60_000), "expires")?).fetch_one(pool).await?;
                Ok(row
                    .get::<Json<serde_json::Value>, _>("payload")
                    .0
                    .as_u64()
                    .unwrap_or(u64::MAX)
                    <= limit)
            }
        }
    }

    /// Session secrets are hashed before reaching this storage API.
    pub async fn put_auth(
        &self,
        key: &str,
        value: serde_json::Value,
        expires: u64,
    ) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => client
                .call(
                    "put_auth",
                    json!({"key":key,"value_json":encode(&value)?,"expires":expires.to_string()}),
                )
                .await?,
            StorageBackend::Memory(state) => {
                state
                    .write()
                    .await
                    .auth
                    .insert(key.into(), (value, expires));
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query("INSERT INTO owner_auth (key, payload, expires_at_ms) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET payload=$2, expires_at_ms=$3")
                    .bind(key).bind(Json(value)).bind(to_i64(Some(expires), "expires_at_ms")?).execute(pool).await?;
            }
        }
        Ok(())
    }

    pub async fn get_auth(
        &self,
        key: &str,
        now: u64,
        consume: bool,
    ) -> Result<Option<serde_json::Value>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .record(
                        "get_auth",
                        json!({"key":key,"now":now.to_string(),"consume":consume}),
                    )
                    .await
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                state.auth.retain(|_, (_, expires)| *expires > now);
                Ok(if consume {
                    state.auth.remove(key)
                } else {
                    state.auth.get(key).cloned()
                }
                .map(|(value, _)| value))
            }
            StorageBackend::Postgres(pool) => {
                let query = if consume {
                    "DELETE FROM owner_auth WHERE key=$1 AND expires_at_ms>$2 RETURNING payload"
                } else {
                    "SELECT payload FROM owner_auth WHERE key=$1 AND expires_at_ms>$2"
                };
                let row = sqlx::query(query)
                    .bind(key)
                    .bind(to_i64(Some(now), "now")?)
                    .fetch_optional(pool)
                    .await?;
                Ok(row.map(|row| row.get::<Json<serde_json::Value>, _>("payload").0))
            }
        }
    }

    pub async fn auth_connection(
        &self,
        hash: &str,
    ) -> Result<Option<serde_json::Value>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client.call("auth_connection", json!({"hash":hash})).await
            }
            StorageBackend::Memory(_) => Ok(None),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query("SELECT wallet_address, scope FROM agent_connections WHERE token_hash=$1 AND revoked_at IS NULL")
                    .bind(hash).fetch_optional(pool).await?;
                Ok(row.map(|r| serde_json::json!({"wallet": r.get::<String,_>("wallet_address"), "scope": r.get::<String,_>("scope")})))
            }
        }
    }

    pub async fn get_payment(
        &self,
        payment_id: &str,
    ) -> Result<Option<PaymentRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .record("get_payment", json!({"payment_id":payment_id}))
                    .await
            }
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
            StorageBackend::Convex(client) => {
                client
                    .record("find_payment_by_idempotency", json!({"key":key}))
                    .await
            }
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
            StorageBackend::Convex(client) => {
                client
                    .record(
                        "find_payment_by_receipt",
                        json!({"receipt_address":receipt_address}),
                    )
                    .await
            }
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
            StorageBackend::Convex(client) => {
                client
                    .call("put_payment", json!({"record_json":encode(&record)?}))
                    .await
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                if state.payments.get(&record.payment_id).is_some_and(|old| {
                    matches!(old.status, PaymentStatus::Confirmed | PaymentStatus::Failed)
                        || (old.updated_at_ms > record.updated_at_ms)
                }) {
                    return Ok(());
                }
                state.payments.insert(record.payment_id.clone(), record);
                Ok(())
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO payments (
                        payment_id, idempotency_key, mandate, invoice_hash,
                        receipt_address, agent, mint, recipient, amount,
                        token_program, signing_mode, signature, slot, status,
                        error, created_at_ms, updated_at_ms
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8,
                        CAST($9 AS NUMERIC), $10, $11, $12, $13, $14,
                        $15, $16, $17
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
                        signing_mode = EXCLUDED.signing_mode,
                        signature = EXCLUDED.signature,
                        slot = EXCLUDED.slot,
                        status = EXCLUDED.status,
                        error = EXCLUDED.error,
                        updated_at_ms = EXCLUDED.updated_at_ms
                    WHERE payments.status NOT IN ('confirmed','failed') AND payments.updated_at_ms <= EXCLUDED.updated_at_ms
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
                .bind(signing_mode_name(record.signing_mode))
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
            StorageBackend::Convex(client) => {
                client
                    .record("get_transaction", json!({"transaction_id":transaction_id}))
                    .await
            }
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
            StorageBackend::Convex(client) => {
                client
                    .record("find_transaction_by_idempotency", json!({"key":key}))
                    .await
            }
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
            StorageBackend::Convex(client) => {
                client
                    .call("put_transaction", json!({"record_json":encode(&record)?}))
                    .await
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                if state
                    .transactions
                    .get(&record.transaction_id)
                    .is_some_and(|old| {
                        matches!(old.status, PaymentStatus::Confirmed | PaymentStatus::Failed)
                            || (old.updated_at_ms > record.updated_at_ms)
                    })
                {
                    return Ok(());
                }
                state
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
                    WHERE transactions.status NOT IN ('confirmed','failed') AND transactions.updated_at_ms <= EXCLUDED.updated_at_ms
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

    /// List one connector's jobs for one owner wallet. Idempotency keys are
    /// `{wallet}:{user_key}`. The connector is required so an x402 listing can
    /// never answer with a Crossmint job, or the reverse.
    pub async fn list_connector_jobs(
        &self,
        owner_wallet: &str,
        connector: ConnectorKind,
        mandate: Option<&str>,
        limit: u32,
    ) -> Result<Vec<(X402PaymentRecord, Option<String>)>, StorageError> {
        let prefix = format!("{owner_wallet}:");
        let limit = limit.clamp(1, 100) as usize;
        match &self.backend {
            StorageBackend::Convex(client) => {
                let rows: Vec<(String, Option<String>)> = client
                    .call(
                        "list_x402_for_owner",
                        json!({"owner_wallet":owner_wallet,"connector":connector.as_str(),"mandate":mandate,"limit":limit}),
                    )
                    .await?;
                rows.into_iter()
                    .map(|(record, mandate)| Ok((decode(&record)?, mandate)))
                    .collect()
            }
            StorageBackend::Memory(state) => {
                let state = state.read().await;
                let mut rows: Vec<(X402PaymentRecord, Option<String>)> = state
                    .x402_payments
                    .values()
                    .filter(|record| record.connector == connector)
                    .filter(|record| record.idempotency_key.starts_with(&prefix))
                    .filter_map(|record| {
                        let linked_mandate = record.payment_id.as_ref().and_then(|payment_id| {
                            state
                                .payments
                                .get(payment_id)
                                .map(|payment| payment.mandate.clone())
                        });
                        if mandate
                            .is_some_and(|expected| linked_mandate.as_deref() != Some(expected))
                        {
                            return None;
                        }
                        Some((record.clone(), linked_mandate))
                    })
                    .collect();
                rows.sort_by(|left, right| right.0.updated_at_ms.cmp(&left.0.updated_at_ms));
                rows.truncate(limit);
                Ok(rows)
            }
            StorageBackend::Postgres(pool) => {
                let rows = if let Some(mandate) = mandate {
                    sqlx::query(X402_LIST_FOR_OWNER_WITH_MANDATE)
                        .bind(format!("{prefix}%"))
                        .bind(connector.as_str())
                        .bind(mandate)
                        .bind(limit as i64)
                        .fetch_all(pool)
                        .await?
                } else {
                    sqlx::query(X402_LIST_FOR_OWNER)
                        .bind(format!("{prefix}%"))
                        .bind(connector.as_str())
                        .bind(limit as i64)
                        .fetch_all(pool)
                        .await?
                };
                rows.into_iter()
                    .map(|row| {
                        let mandate = row.try_get::<Option<String>, _>("mandate")?;
                        Ok((x402_from_row(row)?, mandate))
                    })
                    .collect()
            }
        }
    }

    pub async fn find_x402_by_idempotency(
        &self,
        key: &str,
    ) -> Result<Option<X402PaymentRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .record("find_x402_by_idempotency", json!({"key":key}))
                    .await
            }
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

    /// Find any other operation for the same owner's connector obligation.
    /// Failed jobs count too; their status is not permission to charge again.
    pub async fn find_other_connector_job_for_owner(
        &self,
        owner: &str,
        connector: ConnectorKind,
        reference: &str,
        current_key: &str,
    ) -> Result<Option<X402PaymentRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => { client.record("find_other_connector_job_for_owner", json!({"owner":owner,"connector":connector.as_str(),"reference":reference,"current_key":current_key})).await },
            StorageBackend::Memory(state) => {
                let state = state.read().await;
                let mut rows: Vec<X402PaymentRecord> = state
                    .x402_payments
                    .values()
                    .filter(|record| {
                        record.connector == connector
                            && record.connector_reference.as_deref() == Some(reference)
                            && record.idempotency_key.starts_with(&format!("{owner}:"))
                            && record.idempotency_key != current_key
                    })
                    .cloned()
                    .collect();
                rows.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
                Ok(rows.into_iter().next())
            }
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(X402_SELECT_BY_CONNECTOR_REFERENCE)
                    .bind(connector.as_str())
                    .bind(reference)
                    .bind(owner)
                    .bind(current_key)
                    .fetch_optional(pool)
                    .await?;
                row.map(x402_from_row).transpose()
            }
        }
    }

    pub async fn put_x402(&self, mut record: X402PaymentRecord) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .call("put_x402", json!({"record_json":encode(&record)?}))
                    .await
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                if state
                    .x402_payments
                    .get(&record.x402_payment_id)
                    .is_some_and(|old| {
                        matches!(old.status, X402PaymentStatus::Verified)
                            || (old.updated_at_ms > record.updated_at_ms)
                    })
                {
                    return Ok(());
                }
                if let Some(old) = state.x402_payments.get(&record.x402_payment_id) {
                    if matches!(
                        old.status,
                        X402PaymentStatus::Confirmed | X402PaymentStatus::Failed
                    ) && matches!(
                        record.status,
                        X402PaymentStatus::Prepared | X402PaymentStatus::Submitted
                    ) {
                        return Ok(());
                    }
                    if record.proof.is_none() {
                        record.proof = old.proof.clone();
                    }
                    if record.response_status.is_none() {
                        record.response_status = old.response_status;
                    }
                }
                state
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
                        proof, response_status, error, created_at, updated_at,
                        connector, connector_reference
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                        TO_TIMESTAMP($12::DOUBLE PRECISION / 1000.0),
                        TO_TIMESTAMP($13::DOUBLE PRECISION / 1000.0),
                        $14, $15
                    )
                    ON CONFLICT (x402_payment_id) DO UPDATE SET
                        connector = EXCLUDED.connector,
                        connector_reference = COALESCE(EXCLUDED.connector_reference,x402_payments.connector_reference),
                        resource = EXCLUDED.resource,
                        payment_id = EXCLUDED.payment_id,
                        receipt_address = EXCLUDED.receipt_address,
                        transaction_signature = EXCLUDED.transaction_signature,
                        status = EXCLUDED.status,
                        challenge = EXCLUDED.challenge,
                        proof = COALESCE(EXCLUDED.proof,x402_payments.proof),
                        response_status = COALESCE(EXCLUDED.response_status,x402_payments.response_status),
                        error = EXCLUDED.error,
                        updated_at = EXCLUDED.updated_at
                    WHERE x402_payments.status <> 'verified' AND NOT (x402_payments.status IN ('confirmed','failed') AND EXCLUDED.status IN ('prepared','submitted')) AND x402_payments.updated_at <= EXCLUDED.updated_at
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
                .bind(record.connector.as_str())
                .bind(&record.connector_reference)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    /// Refresh off-chain order evidence without rewriting settlement fields.
    /// Unlike x402 delivery proofs, Crossmint order phases can advance after
    /// verification (delivery -> completed). Generic payment reconciliation
    /// still cannot overwrite a verified job.
    pub async fn put_crossmint_proof(
        &self,
        record: &X402PaymentRecord,
    ) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .call::<()>(
                        "put_crossmint_proof",
                        json!({"record_json":encode(record)?}),
                    )
                    .await?;
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                if let Some(old) = state.x402_payments.get_mut(&record.x402_payment_id) {
                    if old.connector == ConnectorKind::Crossmint
                        && matches!(
                            old.status,
                            X402PaymentStatus::Confirmed | X402PaymentStatus::Verified
                        )
                        && old.updated_at_ms <= record.updated_at_ms
                    {
                        old.proof = record.proof.clone();
                        old.response_status = record.response_status;
                        old.error = record.error.clone();
                        // Verification that the order advanced is monotonic,
                        // even if a later poll fails or returns an older phase.
                        if old.status != X402PaymentStatus::Verified {
                            old.status = record.status;
                        }
                        old.updated_at_ms = record.updated_at_ms;
                    }
                }
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    r#"
                    UPDATE x402_payments SET
                        proof = $2, response_status = $3, error = $4,
                        status = CASE WHEN status = 'verified' THEN status ELSE $5 END,
                        updated_at = TO_TIMESTAMP($6::DOUBLE PRECISION / 1000.0)
                    WHERE x402_payment_id = $1 AND connector = 'crossmint'
                      AND status IN ('confirmed', 'verified')
                      AND updated_at <= TO_TIMESTAMP($6::DOUBLE PRECISION / 1000.0)
                "#,
                )
                .bind(&record.x402_payment_id)
                .bind(record.proof.clone().map(Json))
                .bind(record.response_status.map(i32::from))
                .bind(&record.error)
                .bind(x402_status_name(record.status))
                .bind(to_i64(Some(record.updated_at_ms), "updated_at_ms")?)
                .execute(pool)
                .await?;
            }
        }
        Ok(())
    }

    pub async fn put_managed_signer_challenge(
        &self,
        challenge: ManagedSignerChallenge,
    ) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .call(
                        "put_managed_signer_challenge",
                        json!({"challenge_json":encode(&challenge)?}),
                    )
                    .await
            }
            StorageBackend::Memory(state) => {
                state
                    .write()
                    .await
                    .managed_signer_challenges
                    .insert(challenge.challenge_id.clone(), challenge);
                Ok(())
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO managed_signer_challenges (
                        challenge_id, owner_wallet, mandate_pda, message,
                        expires_at_ms, consumed_at_ms, created_at_ms
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                    "#,
                )
                .bind(&challenge.challenge_id)
                .bind(&challenge.owner_wallet)
                .bind(&challenge.mandate_pda)
                .bind(&challenge.message)
                .bind(to_i64(Some(challenge.expires_at_ms), "expires_at_ms")?)
                .bind(to_i64(challenge.consumed_at_ms, "consumed_at_ms")?)
                .bind(to_i64(Some(challenge.created_at_ms), "created_at_ms")?)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn get_managed_signer_challenge(
        &self,
        challenge_id: &str,
    ) -> Result<Option<ManagedSignerChallenge>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .record(
                        "get_managed_signer_challenge",
                        json!({"challenge_id":challenge_id}),
                    )
                    .await
            }
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .managed_signer_challenges
                .get(challenge_id)
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(MANAGED_SIGNER_CHALLENGE_SELECT_BY_ID)
                    .bind(challenge_id)
                    .fetch_optional(pool)
                    .await?;
                row.map(managed_signer_challenge_from_row).transpose()
            }
        }
    }

    pub async fn consume_managed_signer_challenge(
        &self,
        challenge_id: &str,
        consumed_at_ms: u64,
    ) -> Result<bool, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => { client.call("consume_managed_signer_challenge", json!({"challenge_id":challenge_id,"consumed_at_ms":consumed_at_ms.to_string()})).await },
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let Some(challenge) = state.managed_signer_challenges.get_mut(challenge_id) else {
                    return Ok(false);
                };
                if challenge.consumed_at_ms.is_some() || challenge.expires_at_ms < consumed_at_ms {
                    return Ok(false);
                }
                challenge.consumed_at_ms = Some(consumed_at_ms);
                Ok(true)
            }
            StorageBackend::Postgres(pool) => {
                let consumed_at_ms = to_i64(Some(consumed_at_ms), "consumed_at_ms")?;
                let result = sqlx::query(
                    r#"
                    UPDATE managed_signer_challenges
                    SET consumed_at_ms = $2
                    WHERE challenge_id = $1
                      AND consumed_at_ms IS NULL
                      AND expires_at_ms >= $2
                    "#,
                )
                .bind(challenge_id)
                .bind(consumed_at_ms)
                .execute(pool)
                .await?;
                Ok(result.rows_affected() == 1)
            }
        }
    }

    pub async fn put_managed_signer(
        &self,
        signer: ManagedSignerRecord,
    ) -> Result<(), StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let mut value = serde_json::to_value(&signer)
                    .map_err(|_| StorageError::Remote("invalid signer record".into()))?;
                value["provider_wallet_id"] = json!(signer.provider_wallet_id);
                value["provider_policy_id"] = json!(signer.provider_policy_id);
                client
                    .call("put_managed_signer", json!({"signer_json":encode(&value)?}))
                    .await
            }
            StorageBackend::Memory(state) => {
                state
                    .write()
                    .await
                    .managed_signers
                    .insert(signer.signer_id.clone(), signer);
                Ok(())
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO managed_signers (
                        signer_id, owner_wallet, public_key, provider,
                        provider_wallet_id, provider_policy_id, mandate_pda,
                        signing_mode, status, created_at_ms, updated_at_ms,
                        revoked_at_ms
                    ) VALUES (
                        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
                    )
                    ON CONFLICT (signer_id) DO UPDATE SET
                        owner_wallet = EXCLUDED.owner_wallet,
                        public_key = EXCLUDED.public_key,
                        provider = EXCLUDED.provider,
                        provider_wallet_id = EXCLUDED.provider_wallet_id,
                        provider_policy_id = EXCLUDED.provider_policy_id,
                        mandate_pda = EXCLUDED.mandate_pda,
                        signing_mode = EXCLUDED.signing_mode,
                        status = EXCLUDED.status,
                        updated_at_ms = EXCLUDED.updated_at_ms,
                        revoked_at_ms = EXCLUDED.revoked_at_ms
                    "#,
                )
                .bind(&signer.signer_id)
                .bind(&signer.owner_wallet)
                .bind(&signer.public_key)
                .bind(&signer.provider)
                .bind(&signer.provider_wallet_id)
                .bind(&signer.provider_policy_id)
                .bind(&signer.mandate_pda)
                .bind(signing_mode_name(signer.signing_mode))
                .bind(managed_signer_status_name(signer.status))
                .bind(to_i64(Some(signer.created_at_ms), "created_at_ms")?)
                .bind(to_i64(Some(signer.updated_at_ms), "updated_at_ms")?)
                .bind(to_i64(signer.revoked_at_ms, "revoked_at_ms")?)
                .execute(pool)
                .await?;
                Ok(())
            }
        }
    }

    pub async fn find_managed_signer_by_public_key(
        &self,
        public_key: &str,
    ) -> Result<Option<ManagedSignerRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .record(
                        "find_managed_signer_by_public_key",
                        json!({"public_key":public_key}),
                    )
                    .await
            }
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .managed_signers
                .values()
                .find(|record| record.public_key == public_key)
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(MANAGED_SIGNER_SELECT_BY_PUBLIC_KEY)
                    .bind(public_key)
                    .fetch_optional(pool)
                    .await?;
                row.map(managed_signer_from_row).transpose()
            }
        }
    }

    pub async fn find_managed_signer_by_mandate(
        &self,
        mandate_pda: &str,
    ) -> Result<Option<ManagedSignerRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .record(
                        "find_managed_signer_by_mandate",
                        json!({"mandate_pda":mandate_pda}),
                    )
                    .await
            }
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .managed_signers
                .values()
                .find(|record| record.mandate_pda == mandate_pda)
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(MANAGED_SIGNER_SELECT_BY_MANDATE)
                    .bind(mandate_pda)
                    .fetch_optional(pool)
                    .await?;
                row.map(managed_signer_from_row).transpose()
            }
        }
    }

    pub async fn put_delivery_attestation(
        &self,
        record: DeliveryAttestationRecord,
    ) -> Result<DeliveryAttestationPut, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let result: serde_json::Value = client
                    .call(
                        "put_delivery_attestation",
                        json!({"record_json":encode(&record)?}),
                    )
                    .await?;
                let stored =
                    decode(result["record_json"].as_str().ok_or_else(|| {
                        StorageError::Remote("invalid attestation response".into())
                    })?)?;
                match result["kind"].as_str() {
                    Some("created") => Ok(DeliveryAttestationPut::Created(stored)),
                    Some("unchanged") => Ok(DeliveryAttestationPut::Unchanged(stored)),
                    Some("conflict") => Ok(DeliveryAttestationPut::Conflict(stored)),
                    _ => Err(StorageError::Remote("invalid attestation result".into())),
                }
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let key = delivery_key(&record);
                if let Some(existing) = state.delivery_attestations.get(&key) {
                    return Ok(delivery_put_result(existing.clone(), &record));
                }
                state.delivery_attestations.insert(key, record.clone());
                Ok(DeliveryAttestationPut::Created(record))
            }
            StorageBackend::Postgres(pool) => {
                let inserted = sqlx::query(
                    r#"
                    INSERT INTO delivery_attestations (
                        cluster, program_id, receipt_address, seller,
                        content_hash, served_at, signature, canonical_payload,
                        published_at_ms
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (cluster, program_id, receipt_address, seller)
                    DO NOTHING
                    "#,
                )
                .bind(&record.cluster)
                .bind(&record.program_id)
                .bind(&record.receipt_address)
                .bind(&record.seller)
                .bind(&record.content_hash)
                .bind(&record.served_at)
                .bind(&record.signature)
                .bind(&record.canonical_payload)
                .bind(to_i64(Some(record.published_at_ms), "published_at_ms")?)
                .execute(pool)
                .await?
                .rows_affected()
                    == 1;
                if inserted {
                    return Ok(DeliveryAttestationPut::Created(record));
                }
                let existing = sqlx::query(DELIVERY_SELECT_BY_KEY)
                    .bind(&record.cluster)
                    .bind(&record.program_id)
                    .bind(&record.receipt_address)
                    .bind(&record.seller)
                    .fetch_one(pool)
                    .await?;
                Ok(delivery_put_result(delivery_from_row(existing)?, &record))
            }
        }
    }

    /// Keyed JSON record for the mandate request an owner accepted, keyed by
    /// mandate PDA. First write wins; rows are never updated. Stored as one
    /// key and one JSON value so it maps onto a generic `records` table with
    /// kind `mandate_requests`.
    pub async fn put_mandate_request(
        &self,
        mandate_pda: &str,
        record: serde_json::Value,
        created_at_ms: u64,
    ) -> Result<KeyedRecordPut, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let result: (bool, String) = client.call("put_mandate_request", json!({"record_json":encode(&json!({"mandate_pda":mandate_pda,"record":record,"created_at_ms":created_at_ms}))?})).await?;
                let value = decode(&result.1)?;
                Ok(if result.0 {
                    KeyedRecordPut::Created(value)
                } else {
                    KeyedRecordPut::Existing(value)
                })
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                if let Some(existing) = state.mandate_requests.get(mandate_pda) {
                    return Ok(KeyedRecordPut::Existing(existing.clone()));
                }
                state
                    .mandate_requests
                    .insert(mandate_pda.to_owned(), record.clone());
                Ok(KeyedRecordPut::Created(record))
            }
            StorageBackend::Postgres(pool) => {
                let inserted = sqlx::query(
                    "INSERT INTO mandate_requests (mandate_pda, record, created_at_ms) VALUES ($1, $2, $3) ON CONFLICT (mandate_pda) DO NOTHING",
                )
                .bind(mandate_pda)
                .bind(Json(&record))
                .bind(to_i64(Some(created_at_ms), "created_at_ms")?)
                .execute(pool)
                .await?
                .rows_affected()
                    == 1;
                if inserted {
                    return Ok(KeyedRecordPut::Created(record));
                }
                let row = sqlx::query("SELECT record FROM mandate_requests WHERE mandate_pda = $1")
                    .bind(mandate_pda)
                    .fetch_one(pool)
                    .await?;
                Ok(KeyedRecordPut::Existing(
                    row.get::<Json<serde_json::Value>, _>("record").0,
                ))
            }
        }
    }

    pub async fn get_mandate_request(
        &self,
        mandate_pda: &str,
    ) -> Result<Option<serde_json::Value>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                client
                    .record("get_mandate_request", json!({"mandate_pda":mandate_pda}))
                    .await
            }
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .mandate_requests
                .get(mandate_pda)
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query("SELECT record FROM mandate_requests WHERE mandate_pda = $1")
                    .bind(mandate_pda)
                    .fetch_optional(pool)
                    .await?;
                Ok(row.map(|row| row.get::<Json<serde_json::Value>, _>("record").0))
            }
        }
    }

    pub async fn find_delivery_attestation(
        &self,
        cluster: &str,
        program_id: &str,
        receipt_address: &str,
    ) -> Result<Option<DeliveryAttestationRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => { client.record("find_delivery_attestation", json!({"cluster":cluster,"program_id":program_id,"receipt_address":receipt_address})).await },
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .delivery_attestations
                .values()
                .filter(|record| {
                    record.cluster == cluster
                        && record.program_id == program_id
                        && record.receipt_address == receipt_address
                })
                .min_by_key(|record| record.published_at_ms)
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(DELIVERY_SELECT_BY_RECEIPT)
                    .bind(cluster)
                    .bind(program_id)
                    .bind(receipt_address)
                    .fetch_optional(pool)
                    .await?;
                row.map(delivery_from_row).transpose()
            }
        }
    }

    /// Keep a signed request by receipt PDA. Written once: a later write for
    /// the same receipt returns the stored row unchanged. The invoice hash is
    /// a PDA seed, so a second, different request cannot match the receipt.
    pub async fn put_receipt_request(
        &self,
        record: ReceiptRequestRecord,
    ) -> Result<ReceiptRequestRecord, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let value: String = client
                    .call(
                        "put_receipt_request",
                        json!({"record_json":encode(&record)?}),
                    )
                    .await?;
                decode(&value)
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let key = receipt_key(&record.cluster, &record.program_id, &record.receipt_address);
                Ok(state.receipt_requests.entry(key).or_insert(record).clone())
            }
            StorageBackend::Postgres(pool) => {
                sqlx::query(
                    r#"
                    INSERT INTO receipt_requests (
                        cluster, program_id, receipt_address, mandate, invoice_hash,
                        merchant, canonical_payload, signature, stored_at_ms
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    ON CONFLICT (cluster, program_id, receipt_address) DO NOTHING
                    "#,
                )
                .bind(&record.cluster)
                .bind(&record.program_id)
                .bind(&record.receipt_address)
                .bind(&record.mandate)
                .bind(&record.invoice_hash)
                .bind(&record.merchant)
                .bind(&record.canonical_payload)
                .bind(&record.signature)
                .bind(to_i64(Some(record.stored_at_ms), "stored_at_ms")?)
                .execute(pool)
                .await?;
                self.find_receipt_request(
                    &record.cluster,
                    &record.program_id,
                    &record.receipt_address,
                )
                .await?
                .ok_or_else(|| StorageError::InvalidValue {
                    field: "receipt_request",
                    value: record.receipt_address.clone(),
                })
            }
        }
    }

    pub async fn find_receipt_request(
        &self,
        cluster: &str,
        program_id: &str,
        receipt_address: &str,
    ) -> Result<Option<ReceiptRequestRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => { client.record("find_receipt_request", json!({"cluster":cluster,"program_id":program_id,"receipt_address":receipt_address})).await },
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .receipt_requests
                .get(&receipt_key(cluster, program_id, receipt_address))
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    SELECT cluster, program_id, receipt_address, mandate, invoice_hash,
                           merchant, canonical_payload, signature, stored_at_ms
                    FROM receipt_requests
                    WHERE cluster = $1 AND program_id = $2 AND receipt_address = $3
                    "#,
                )
                .bind(cluster)
                .bind(program_id)
                .bind(receipt_address)
                .fetch_optional(pool)
                .await?;
                row.map(|row| {
                    Ok(ReceiptRequestRecord {
                        cluster: row.try_get("cluster")?,
                        program_id: row.try_get("program_id")?,
                        receipt_address: row.try_get("receipt_address")?,
                        mandate: row.try_get("mandate")?,
                        invoice_hash: row.try_get("invoice_hash")?,
                        merchant: row.try_get("merchant")?,
                        canonical_payload: row.try_get("canonical_payload")?,
                        signature: row.try_get("signature")?,
                        stored_at_ms: from_i64(Some(row.try_get("stored_at_ms")?), "stored_at_ms")?
                            .unwrap_or_default(),
                    })
                })
                .transpose()
            }
        }
    }

    /// Keep the relay's first post-payment read of a mandate for one receipt.
    /// Written once, so a later read with more payments counted never replaces
    /// the observation closest to the payment.
    pub async fn put_observed_policy(
        &self,
        record: ObservedPolicyRecord,
    ) -> Result<ObservedPolicyRecord, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => {
                let value: String = client
                    .call(
                        "put_observed_policy",
                        json!({"record_json":encode(&record)?}),
                    )
                    .await?;
                decode(&value)
            }
            StorageBackend::Memory(state) => {
                let mut state = state.write().await;
                let key = receipt_key(&record.cluster, &record.program_id, &record.receipt_address);
                Ok(state.observed_policies.entry(key).or_insert(record).clone())
            }
            StorageBackend::Postgres(pool) => {
                let limits = serde_json::to_value(&record.limits).map_err(|error| {
                    StorageError::InvalidValue {
                        field: "limits",
                        value: error.to_string(),
                    }
                })?;
                sqlx::query(
                    r#"
                    INSERT INTO observed_policies (
                        cluster, program_id, receipt_address, mandate, limits,
                        observed_at_slot, includes_later_payments, observed_at_ms
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    ON CONFLICT (cluster, program_id, receipt_address) DO NOTHING
                    "#,
                )
                .bind(&record.cluster)
                .bind(&record.program_id)
                .bind(&record.receipt_address)
                .bind(&record.mandate)
                .bind(Json(limits))
                .bind(to_i64(Some(record.observed_at_slot), "observed_at_slot")?)
                .bind(record.includes_later_payments)
                .bind(to_i64(Some(record.observed_at_ms), "observed_at_ms")?)
                .execute(pool)
                .await?;
                self.find_observed_policy(
                    &record.cluster,
                    &record.program_id,
                    &record.receipt_address,
                )
                .await?
                .ok_or_else(|| StorageError::InvalidValue {
                    field: "observed_policy",
                    value: record.receipt_address.clone(),
                })
            }
        }
    }

    pub async fn find_observed_policy(
        &self,
        cluster: &str,
        program_id: &str,
        receipt_address: &str,
    ) -> Result<Option<ObservedPolicyRecord>, StorageError> {
        match &self.backend {
            StorageBackend::Convex(client) => { client.record("find_observed_policy", json!({"cluster":cluster,"program_id":program_id,"receipt_address":receipt_address})).await },
            StorageBackend::Memory(state) => Ok(state
                .read()
                .await
                .observed_policies
                .get(&receipt_key(cluster, program_id, receipt_address))
                .cloned()),
            StorageBackend::Postgres(pool) => {
                let row = sqlx::query(
                    r#"
                    SELECT cluster, program_id, receipt_address, mandate, limits,
                           observed_at_slot, includes_later_payments, observed_at_ms
                    FROM observed_policies
                    WHERE cluster = $1 AND program_id = $2 AND receipt_address = $3
                    "#,
                )
                .bind(cluster)
                .bind(program_id)
                .bind(receipt_address)
                .fetch_optional(pool)
                .await?;
                row.map(|row| {
                    let limits = row.try_get::<Json<serde_json::Value>, _>("limits")?.0;
                    let limits: ReceiptPolicyLimits = serde_json::from_value(limits.clone())
                        .map_err(|_| StorageError::InvalidValue {
                            field: "limits",
                            value: limits.to_string(),
                        })?;
                    Ok(ObservedPolicyRecord {
                        cluster: row.try_get("cluster")?,
                        program_id: row.try_get("program_id")?,
                        receipt_address: row.try_get("receipt_address")?,
                        mandate: row.try_get("mandate")?,
                        limits,
                        observed_at_slot: from_i64(
                            Some(row.try_get("observed_at_slot")?),
                            "observed_at_slot",
                        )?
                        .unwrap_or_default(),
                        includes_later_payments: row.try_get("includes_later_payments")?,
                        observed_at_ms: from_i64(
                            Some(row.try_get("observed_at_ms")?),
                            "observed_at_ms",
                        )?
                        .unwrap_or_default(),
                    })
                })
                .transpose()
            }
        }
    }
}

const PAYMENT_SELECT_BY_ID: &str = r#"
    SELECT payment_id, idempotency_key, mandate, invoice_hash, receipt_address,
           agent, mint, recipient, amount::text AS amount_text, token_program, signing_mode,
           signature, slot, status, error, created_at_ms, updated_at_ms
    FROM payments WHERE payment_id = $1
"#;

const PAYMENT_SELECT_BY_IDEMPOTENCY: &str = r#"
    SELECT payment_id, idempotency_key, mandate, invoice_hash, receipt_address,
           agent, mint, recipient, amount::text AS amount_text, token_program, signing_mode,
           signature, slot, status, error, created_at_ms, updated_at_ms
    FROM payments WHERE idempotency_key = $1
"#;

const PAYMENT_SELECT_BY_RECEIPT: &str = r#"
    SELECT payment_id, idempotency_key, mandate, invoice_hash, receipt_address,
           agent, mint, recipient, amount::text AS amount_text, token_program, signing_mode,
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
    SELECT x402_payment_id, idempotency_key, connector, connector_reference, resource, payment_id,
           receipt_address, transaction_signature, status, challenge, proof,
           response_status, error,
           (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT AS created_at_ms,
           (EXTRACT(EPOCH FROM updated_at) * 1000)::BIGINT AS updated_at_ms
    FROM x402_payments WHERE idempotency_key = $1
"#;

const X402_SELECT_BY_CONNECTOR_REFERENCE: &str = r#"
    SELECT x402_payment_id, idempotency_key, connector, connector_reference, resource, payment_id,
           receipt_address, transaction_signature, status, challenge, proof,
           response_status, error,
           (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT AS created_at_ms,
           (EXTRACT(EPOCH FROM updated_at) * 1000)::BIGINT AS updated_at_ms
    FROM x402_payments
    WHERE connector = $1 AND connector_reference = $2
      AND split_part(idempotency_key, ':', 1) = $3
      AND idempotency_key <> $4
    ORDER BY updated_at DESC
    LIMIT 1
"#;

const X402_LIST_FOR_OWNER: &str = r#"
    SELECT x.x402_payment_id, x.idempotency_key, x.connector, x.connector_reference, x.resource, x.payment_id,
           x.receipt_address, x.transaction_signature, x.status, x.challenge, x.proof,
           x.response_status, x.error,
           (EXTRACT(EPOCH FROM x.created_at) * 1000)::BIGINT AS created_at_ms,
           (EXTRACT(EPOCH FROM x.updated_at) * 1000)::BIGINT AS updated_at_ms,
           p.mandate
    FROM x402_payments x
    LEFT JOIN payments p ON p.payment_id = x.payment_id
    WHERE x.idempotency_key LIKE $1 ESCAPE '\'
      AND x.connector = $2
    ORDER BY x.updated_at DESC
    LIMIT $3
"#;

const X402_LIST_FOR_OWNER_WITH_MANDATE: &str = r#"
    SELECT x.x402_payment_id, x.idempotency_key, x.connector, x.connector_reference, x.resource, x.payment_id,
           x.receipt_address, x.transaction_signature, x.status, x.challenge, x.proof,
           x.response_status, x.error,
           (EXTRACT(EPOCH FROM x.created_at) * 1000)::BIGINT AS created_at_ms,
           (EXTRACT(EPOCH FROM x.updated_at) * 1000)::BIGINT AS updated_at_ms,
           p.mandate
    FROM x402_payments x
    INNER JOIN payments p ON p.payment_id = x.payment_id
    WHERE x.idempotency_key LIKE $1 ESCAPE '\'
      AND x.connector = $2
      AND p.mandate = $3
    ORDER BY x.updated_at DESC
    LIMIT $4
"#;

const MANAGED_SIGNER_CHALLENGE_SELECT_BY_ID: &str = r#"
    SELECT challenge_id, owner_wallet, mandate_pda, message, expires_at_ms,
           consumed_at_ms, created_at_ms
    FROM managed_signer_challenges WHERE challenge_id = $1
"#;

const DELIVERY_SELECT_BY_KEY: &str = r#"
    SELECT cluster, program_id, receipt_address, seller, content_hash, served_at,
           signature, canonical_payload, published_at_ms
    FROM delivery_attestations
    WHERE cluster = $1 AND program_id = $2 AND receipt_address = $3 AND seller = $4
"#;

const DELIVERY_SELECT_BY_RECEIPT: &str = r#"
    SELECT cluster, program_id, receipt_address, seller, content_hash, served_at,
           signature, canonical_payload, published_at_ms
    FROM delivery_attestations
    WHERE cluster = $1 AND program_id = $2 AND receipt_address = $3
    ORDER BY published_at_ms ASC
    LIMIT 1
"#;

const MANAGED_SIGNER_SELECT_BY_PUBLIC_KEY: &str = r#"
    SELECT signer_id, owner_wallet, public_key, provider, provider_wallet_id,
           provider_policy_id, mandate_pda, signing_mode, status,
           created_at_ms, updated_at_ms, revoked_at_ms
    FROM managed_signers WHERE public_key = $1
"#;

const MANAGED_SIGNER_SELECT_BY_MANDATE: &str = r#"
    SELECT signer_id, owner_wallet, public_key, provider, provider_wallet_id,
           provider_policy_id, mandate_pda, signing_mode, status,
           created_at_ms, updated_at_ms, revoked_at_ms
    FROM managed_signers WHERE mandate_pda = $1
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
        signing_mode: parse_signing_mode(row.try_get("signing_mode")?)?,
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

fn managed_signer_challenge_from_row(row: PgRow) -> Result<ManagedSignerChallenge, StorageError> {
    Ok(ManagedSignerChallenge {
        challenge_id: row.try_get("challenge_id")?,
        owner_wallet: row.try_get("owner_wallet")?,
        mandate_pda: row.try_get("mandate_pda")?,
        message: row.try_get("message")?,
        expires_at_ms: from_i64(row.try_get("expires_at_ms")?, "expires_at_ms")?
            .unwrap_or_default(),
        consumed_at_ms: from_i64(row.try_get("consumed_at_ms")?, "consumed_at_ms")?,
        created_at_ms: from_i64(row.try_get("created_at_ms")?, "created_at_ms")?
            .unwrap_or_default(),
    })
}

fn managed_signer_from_row(row: PgRow) -> Result<ManagedSignerRecord, StorageError> {
    Ok(ManagedSignerRecord {
        signer_id: row.try_get("signer_id")?,
        owner_wallet: row.try_get("owner_wallet")?,
        public_key: row.try_get("public_key")?,
        provider: row.try_get("provider")?,
        provider_wallet_id: row.try_get("provider_wallet_id")?,
        provider_policy_id: row.try_get("provider_policy_id")?,
        mandate_pda: row.try_get("mandate_pda")?,
        signing_mode: parse_signing_mode(row.try_get("signing_mode")?)?,
        status: parse_managed_signer_status(row.try_get("status")?)?,
        created_at_ms: from_i64(row.try_get("created_at_ms")?, "created_at_ms")?
            .unwrap_or_default(),
        updated_at_ms: from_i64(row.try_get("updated_at_ms")?, "updated_at_ms")?
            .unwrap_or_default(),
        revoked_at_ms: from_i64(row.try_get("revoked_at_ms")?, "revoked_at_ms")?,
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
        connector: parse_connector(row.try_get("connector")?)?,
        connector_reference: row.try_get("connector_reference")?,
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

fn signing_mode_name(mode: SigningMode) -> &'static str {
    match mode {
        SigningMode::Human => "human",
        SigningMode::Delegated => "delegated",
    }
}

fn parse_signing_mode(value: String) -> Result<SigningMode, StorageError> {
    match value.as_str() {
        "human" => Ok(SigningMode::Human),
        "delegated" => Ok(SigningMode::Delegated),
        _ => Err(StorageError::InvalidValue {
            field: "signing_mode",
            value,
        }),
    }
}

fn managed_signer_status_name(status: ManagedSignerStatus) -> &'static str {
    match status {
        ManagedSignerStatus::Provisioning => "provisioning",
        ManagedSignerStatus::Active => "active",
        ManagedSignerStatus::Suspended => "suspended",
        ManagedSignerStatus::Revoked => "revoked",
    }
}

fn parse_managed_signer_status(value: String) -> Result<ManagedSignerStatus, StorageError> {
    match value.as_str() {
        "provisioning" => Ok(ManagedSignerStatus::Provisioning),
        "active" => Ok(ManagedSignerStatus::Active),
        "suspended" => Ok(ManagedSignerStatus::Suspended),
        "revoked" => Ok(ManagedSignerStatus::Revoked),
        _ => Err(StorageError::InvalidValue {
            field: "managed_signer_status",
            value,
        }),
    }
}

fn parse_connector(value: String) -> Result<ConnectorKind, StorageError> {
    ConnectorKind::parse(&value).ok_or(StorageError::InvalidValue {
        field: "connector",
        value,
    })
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

fn receipt_key(cluster: &str, program_id: &str, receipt_address: &str) -> String {
    format!("{cluster}:{program_id}:{receipt_address}")
}

fn delivery_key(record: &DeliveryAttestationRecord) -> String {
    format!(
        "{}:{}:{}:{}",
        record.cluster, record.program_id, record.receipt_address, record.seller
    )
}

fn delivery_put_result(
    existing: DeliveryAttestationRecord,
    incoming: &DeliveryAttestationRecord,
) -> DeliveryAttestationPut {
    if existing.canonical_payload == incoming.canonical_payload
        && existing.signature == incoming.signature
    {
        DeliveryAttestationPut::Unchanged(existing)
    } else {
        DeliveryAttestationPut::Conflict(existing)
    }
}

fn delivery_from_row(row: PgRow) -> Result<DeliveryAttestationRecord, StorageError> {
    Ok(DeliveryAttestationRecord {
        cluster: row.try_get("cluster")?,
        program_id: row.try_get("program_id")?,
        receipt_address: row.try_get("receipt_address")?,
        seller: row.try_get("seller")?,
        content_hash: row.try_get("content_hash")?,
        served_at: row.try_get("served_at")?,
        signature: row.try_get("signature")?,
        canonical_payload: row.try_get("canonical_payload")?,
        published_at_ms: from_i64(row.try_get("published_at_ms")?, "published_at_ms")?.unwrap_or(0),
    })
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

    fn highest_placeholder(sql: &str) -> usize {
        sql.split('$')
            .skip(1)
            .filter_map(|tail| {
                let digits: String = tail.chars().take_while(char::is_ascii_digit).collect();
                digits.parse().ok()
            })
            .max()
            .unwrap_or(0)
    }

    // The memory store cannot catch a query whose placeholders drift from the
    // binds in `list_connector_jobs`; Postgres rejects the mismatch at runtime.
    #[test]
    fn connector_list_queries_filter_by_connector_and_match_binds() {
        assert_eq!(highest_placeholder(X402_LIST_FOR_OWNER), 3);
        assert_eq!(highest_placeholder(X402_LIST_FOR_OWNER_WITH_MANDATE), 4);
        assert!(X402_LIST_FOR_OWNER.contains("x.connector = $2"));
        assert!(X402_LIST_FOR_OWNER_WITH_MANDATE.contains("x.connector = $2"));
        assert_eq!(highest_placeholder(X402_SELECT_BY_CONNECTOR_REFERENCE), 4);
    }

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
            signing_mode: SigningMode::Human,
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

    #[tokio::test]
    async fn lists_x402_jobs_for_one_owner_and_mandate() {
        let store = StatusStore::in_memory();
        let owner = "owner-wallet";
        let other = "other-wallet";
        let mandate_a = "mandate-a";
        let mandate_b = "mandate-b";

        store
            .put_payment(PaymentRecord {
                payment_id: "payment-a".into(),
                idempotency_key: "invoice-a".into(),
                mandate: mandate_a.into(),
                invoice_hash: "00".repeat(32),
                receipt_address: None,
                agent: None,
                mint: None,
                recipient: None,
                amount: None,
                token_program: None,
                signing_mode: SigningMode::Human,
                signature: None,
                slot: None,
                status: PaymentStatus::Prepared,
                error: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .await
            .unwrap();
        store
            .put_payment(PaymentRecord {
                payment_id: "payment-b".into(),
                idempotency_key: "invoice-b".into(),
                mandate: mandate_b.into(),
                invoice_hash: "11".repeat(32),
                receipt_address: None,
                agent: None,
                mint: None,
                recipient: None,
                amount: None,
                token_program: None,
                signing_mode: SigningMode::Human,
                signature: None,
                slot: None,
                status: PaymentStatus::Prepared,
                error: None,
                created_at_ms: 2,
                updated_at_ms: 2,
            })
            .await
            .unwrap();

        for (wallet, payment_id, suffix, updated_at_ms) in [
            (owner, "payment-a", "a", 10_u64),
            (owner, "payment-b", "b", 20_u64),
            (other, "payment-a", "c", 30_u64),
        ] {
            store
                .put_x402(X402PaymentRecord {
                    x402_payment_id: format!("x402-{suffix}"),
                    idempotency_key: format!("{wallet}:job-{suffix}"),
                    resource: format!("https://example/{suffix}"),
                    payment_id: Some(payment_id.into()),
                    receipt_address: None,
                    transaction_signature: None,
                    status: X402PaymentStatus::Prepared,
                    challenge: serde_json::json!({"version":"x402/1.0","amount":"1000"}),
                    proof: None,
                    response_status: None,
                    error: None,
                    connector: ConnectorKind::X402,
                    connector_reference: None,
                    created_at_ms: updated_at_ms,
                    updated_at_ms,
                })
                .await
                .unwrap();
        }

        let owner_jobs = store
            .list_connector_jobs(owner, ConnectorKind::X402, None, 10)
            .await
            .unwrap();
        assert_eq!(owner_jobs.len(), 2);
        assert_eq!(owner_jobs[0].0.x402_payment_id, "x402-b");

        let filtered = store
            .list_connector_jobs(owner, ConnectorKind::X402, Some(mandate_a), 10)
            .await
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].1.as_deref(), Some(mandate_a));
    }

    #[tokio::test]
    async fn managed_signer_challenges_are_single_use() {
        let store = StatusStore::in_memory();
        store
            .put_managed_signer_challenge(ManagedSignerChallenge {
                challenge_id: "challenge-1".into(),
                owner_wallet: "owner".into(),
                mandate_pda: "mandate".into(),
                message: "authorize".into(),
                expires_at_ms: 200,
                consumed_at_ms: None,
                created_at_ms: 100,
            })
            .await
            .unwrap();

        assert!(
            store
                .consume_managed_signer_challenge("challenge-1", 150)
                .await
                .unwrap()
        );
        assert!(
            !store
                .consume_managed_signer_challenge("challenge-1", 151)
                .await
                .unwrap()
        );
        assert_eq!(
            store
                .get_managed_signer_challenge("challenge-1")
                .await
                .unwrap()
                .unwrap()
                .consumed_at_ms,
            Some(150)
        );

        store
            .put_managed_signer_challenge(ManagedSignerChallenge {
                challenge_id: "expired-challenge".into(),
                owner_wallet: "owner".into(),
                mandate_pda: "mandate".into(),
                message: "authorize".into(),
                expires_at_ms: 100,
                consumed_at_ms: None,
                created_at_ms: 1,
            })
            .await
            .unwrap();
        assert!(
            !store
                .consume_managed_signer_challenge("expired-challenge", 101)
                .await
                .unwrap()
        );
    }

    #[test]
    fn rejects_values_outside_postgres_bigint_range() {
        assert!(to_i64(Some(u64::MAX), "slot").is_err());
    }

    fn delivery_record(served_at: &str, signature: &str) -> DeliveryAttestationRecord {
        DeliveryAttestationRecord {
            cluster: "devnet".into(),
            program_id: "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4".into(),
            receipt_address: "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1".into(),
            seller: "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB".into(),
            content_hash: "8e60b641218418bde0cde3b190a028e846ccebed8dc804901b8e6f87b9072eee".into(),
            served_at: served_at.into(),
            signature: signature.into(),
            canonical_payload: format!("{served_at}:{signature}"),
            published_at_ms: 1_000,
        }
    }

    #[tokio::test]
    async fn delivery_attestations_are_immutable_and_idempotent() {
        let store = StatusStore::in_memory();
        let first = delivery_record(
            "2026-09-15T04:16:00.000Z",
            "K+hQlY/7U7cbhE2229fk/C2g5MHUahSrhBZz4F3SUxTqyVvLgfV0gZkPosZKdFZzIXbawLS3xJQ3XsrtYXqIDg==",
        );
        assert!(matches!(
            store.put_delivery_attestation(first.clone()).await.unwrap(),
            DeliveryAttestationPut::Created(_)
        ));
        assert!(matches!(
            store.put_delivery_attestation(first.clone()).await.unwrap(),
            DeliveryAttestationPut::Unchanged(record) if record.published_at_ms == 1_000
        ));
        let mut conflicting = first.clone();
        conflicting.served_at = "2026-09-15T04:17:00.000Z".into();
        conflicting.canonical_payload = "different".into();
        conflicting.published_at_ms = 2_000;
        assert!(matches!(
            store.put_delivery_attestation(conflicting).await.unwrap(),
            DeliveryAttestationPut::Conflict(record) if record.served_at == first.served_at
                && record.published_at_ms == 1_000
        ));
        let stored = store
            .find_delivery_attestation(
                "devnet",
                "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4",
                "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1",
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.served_at, first.served_at);
        assert_eq!(stored.published_at_ms, 1_000);
    }

    async fn mandate_request_round_trip(store: &StatusStore, key: &str) {
        let first = serde_json::json!({"requestHash": "aa", "owner": "o"});
        assert_eq!(
            store
                .put_mandate_request(key, first.clone(), 1_000)
                .await
                .unwrap(),
            KeyedRecordPut::Created(first.clone())
        );
        let second = serde_json::json!({"requestHash": "bb", "owner": "o"});
        assert_eq!(
            store.put_mandate_request(key, second, 2_000).await.unwrap(),
            KeyedRecordPut::Existing(first.clone())
        );
        assert_eq!(store.get_mandate_request(key).await.unwrap(), Some(first));
        assert_eq!(
            store
                .get_mandate_request(&format!("{key}-missing"))
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn mandate_requests_are_first_write_wins() {
        mandate_request_round_trip(&StatusStore::in_memory(), "mandate-a").await;
    }

    #[tokio::test]
    #[ignore = "requires explicitly isolated TEST_DATABASE_URL"]
    async fn postgres_mandate_requests_match_memory() {
        let url = std::env::var("TEST_DATABASE_URL").expect("isolated fixture URL required");
        assert!(
            url.starts_with("postgresql://chainpay_test@127.0.0.1:55439/"),
            "Only the explicitly provisioned local fixture is allowed"
        );
        let store = StatusStore::connect(&url).await.unwrap();
        let mut suffix = [0_u8; 8];
        getrandom::fill(&mut suffix).unwrap();
        let key = format!(
            "mandate-{}",
            suffix
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        );
        mandate_request_round_trip(&store, &key).await;
        let reconnected = StatusStore::connect(&url).await.unwrap();
        assert_eq!(
            reconnected
                .get_mandate_request(&key)
                .await
                .unwrap()
                .unwrap()["requestHash"],
            "aa"
        );
    }
}
