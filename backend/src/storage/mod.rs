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
    ManagedSignerChallenge, ManagedSignerRecord, ManagedSignerStatus, PaymentRecord, PaymentStatus,
    SigningMode, TransactionRecord, X402PaymentRecord, X402PaymentStatus,
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
    auth: HashMap<String, (serde_json::Value, u64)>,
    payments: HashMap<String, PaymentRecord>,
    transactions: HashMap<String, TransactionRecord>,
    x402_payments: HashMap<String, X402PaymentRecord>,
    managed_signer_challenges: HashMap<String, ManagedSignerChallenge>,
    managed_signers: HashMap<String, ManagedSignerRecord>,
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

    pub async fn auth_rate(
        &self,
        bucket: &str,
        now: u64,
        limit: u64,
    ) -> Result<bool, StorageError> {
        let key = format!("rate:{bucket}:{}", now / 60_000);
        match &self.backend {
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

    pub async fn put_managed_signer_challenge(
        &self,
        challenge: ManagedSignerChallenge,
    ) -> Result<(), StorageError> {
        match &self.backend {
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
    SELECT x402_payment_id, idempotency_key, resource, payment_id,
           receipt_address, transaction_signature, status, challenge, proof,
           response_status, error,
           (EXTRACT(EPOCH FROM created_at) * 1000)::BIGINT AS created_at_ms,
           (EXTRACT(EPOCH FROM updated_at) * 1000)::BIGINT AS updated_at_ms
    FROM x402_payments WHERE idempotency_key = $1
"#;

const MANAGED_SIGNER_CHALLENGE_SELECT_BY_ID: &str = r#"
    SELECT challenge_id, owner_wallet, mandate_pda, message, expires_at_ms,
           consumed_at_ms, created_at_ms
    FROM managed_signer_challenges WHERE challenge_id = $1
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
}
