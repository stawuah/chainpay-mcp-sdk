use super::domain::{Error, Principal, Role, Task, hash, now, random_id};
use serde_json::Value;
use sqlx::{PgPool, Row, postgres::PgPoolOptions};
use std::time::Duration;

#[derive(Clone)]
pub struct Store {
    pool: PgPool,
}

impl Store {
    pub(crate) fn pool(&self) -> &PgPool {
        &self.pool
    }
    pub async fn connect(url: &str) -> Result<Self, Error> {
        let parsed =
            url::Url::parse(url).map_err(|_| Error::Invalid("Invalid PayPal database URL"))?;
        if !parsed.path().starts_with("/chainpay_paypal_") {
            return Err(Error::Invalid("Dedicated PayPal database required"));
        }
        let pool = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect(url)
            .await?;
        let database: String = sqlx::query_scalar("SELECT current_database()")
            .fetch_one(&pool)
            .await?;
        if !database.starts_with("chainpay_paypal_") {
            return Err(Error::Invalid("Dedicated PayPal database required"));
        }
        let mut tx = pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(770024)")
            .execute(&mut *tx)
            .await?;
        sqlx::raw_sql(include_str!("schema.sql"))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(Self { pool })
    }

    /// Operator-only bootstrap. Never expose this as an unauthenticated route.
    pub async fn issue_access(&self, principal: &Principal, ttl: u64) -> Result<String, Error> {
        if principal.workspace.is_empty()
            || principal.workspace.len() > 80
            || principal.id.is_empty()
            || principal.id.len() > 80
            || ttl == 0
            || ttl > 60 * 86400
        {
            return Err(Error::Invalid("Invalid access grant"));
        }
        let token = format!("{}{}", random_id()?, random_id()?);
        let role = match principal.role {
            Role::Buyer => "buyer",
            Role::Merchant => "merchant",
            Role::Agent => "agent",
        };
        sqlx::query("INSERT INTO paypal_sessions(token_hash,principal,workspace,role,expires_at) VALUES($1,$2,$3,$4,$5)")
            .bind(hash(token.as_bytes())).bind(&principal.id).bind(&principal.workspace).bind(role)
            .bind((now()+ttl) as i64).execute(&self.pool).await?;
        Ok(token)
    }

    pub async fn authenticate(&self, token: &str) -> Result<Principal, Error> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::Forbidden);
        }
        let row = sqlx::query("SELECT principal,workspace,role FROM paypal_sessions WHERE token_hash=$1 AND expires_at>$2")
            .bind(hash(token.as_bytes())).bind(now() as i64).fetch_optional(&self.pool).await?.ok_or(Error::Forbidden)?;
        let role = match row.get::<String, _>("role").as_str() {
            "buyer" => Role::Buyer,
            "merchant" => Role::Merchant,
            "agent" => Role::Agent,
            _ => return Err(Error::Forbidden),
        };
        Ok(Principal {
            id: row.get("principal"),
            workspace: row.get("workspace"),
            role,
        })
    }

    pub async fn revoke(&self, token: &str) -> Result<(), Error> {
        sqlx::query("DELETE FROM paypal_sessions WHERE token_hash=$1")
            .bind(hash(token.as_bytes()))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn rate_limit(&self, identity: &str, limit: i32) -> Result<(), Error> {
        let window = (now() / 60) as i64;
        let count: i32 = sqlx::query_scalar("INSERT INTO paypal_rate_windows(identity,window_id,count) VALUES($1,$2,1) ON CONFLICT(identity,window_id) DO UPDATE SET count=paypal_rate_windows.count+1 RETURNING count")
            .bind(identity).bind(window).fetch_one(&self.pool).await?;
        sqlx::query("DELETE FROM paypal_rate_windows WHERE window_id<$1")
            .bind(window - 10)
            .execute(&self.pool)
            .await?;
        if count > limit {
            return Err(Error::Invalid("Rate limit reached; retry after one minute"));
        }
        Ok(())
    }

    pub async fn create(
        &self,
        task: &Task,
        request_id: &str,
        fingerprint: &str,
    ) -> Result<Task, Error> {
        if request_id.len() < 16
            || request_id.len() > 64
            || !request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(Error::Invalid(
                "Use a stable request ID of 16–64 characters",
            ));
        }
        let record = serde_json::to_value(task).map_err(|_| Error::Invalid("Invalid task"))?;
        sqlx::query("INSERT INTO paypal_tasks(id,workspace,principal,request_id,fingerprint,record,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace,principal,request_id) DO NOTHING")
            .bind(&task.id).bind(&task.workspace).bind(&task.principal).bind(request_id).bind(fingerprint).bind(record)
            .bind(task.created_at as i64).execute(&self.pool).await?;
        let row = sqlx::query("SELECT fingerprint,record FROM paypal_tasks WHERE workspace=$1 AND principal=$2 AND request_id=$3")
            .bind(&task.workspace).bind(&task.principal).bind(request_id).fetch_one(&self.pool).await?;
        if row.get::<String, _>("fingerprint") != fingerprint {
            return Err(Error::Conflict);
        }
        decode(row.get("record"))
    }

    pub async fn get(&self, id: &str, p: &Principal) -> Result<Task, Error> {
        let value: Option<Value> = sqlx::query_scalar(
            "SELECT record FROM paypal_tasks WHERE id=$1 AND workspace=$2 AND (principal=$3 OR $4 OR ((record->'subscription_funding'->>'buyer'=$3 OR record->'purchase'->>'buyer'=$3) AND $5))",
        )
        .bind(id)
        .bind(&p.workspace)
        .bind(&p.id)
        .bind(p.role == Role::Merchant)
        .bind(p.role == Role::Buyer)
        .fetch_optional(&self.pool)
        .await?;
        self.refresh_funding(decode(value.ok_or(Error::NotFound)?)?)
            .await
    }

    pub async fn list(&self, p: &Principal) -> Result<Vec<Task>, Error> {
        let rows: Vec<Value> = sqlx::query_scalar("SELECT record FROM paypal_tasks WHERE workspace=$1 AND (principal=$2 OR $3 OR ((record->'subscription_funding'->>'buyer'=$2 OR record->'purchase'->>'buyer'=$2) AND $4)) ORDER BY created_at DESC,id LIMIT 100")
            .bind(&p.workspace).bind(&p.id).bind(p.role == Role::Merchant).bind(p.role == Role::Buyer).fetch_all(&self.pool).await?;
        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(self.refresh_funding(decode(row)?).await?);
        }
        Ok(tasks)
    }

    /// Purchases waiting on the buyer. A buyer sees the ones against their
    /// allowances; an agent sees the ones it asked for.
    pub async fn approvals(&self, p: &Principal) -> Result<Vec<Task>, Error> {
        let owner = match p.role {
            Role::Buyer => "record->'purchase'->>'buyer'",
            Role::Agent => "principal",
            Role::Merchant => return Err(Error::Forbidden),
        };
        let rows: Vec<Value> = sqlx::query_scalar(&format!("SELECT record FROM paypal_tasks WHERE workspace=$1 AND {owner}=$2 AND record->'purchase'->>'approval'='requested' ORDER BY created_at DESC,id LIMIT 100"))
            .bind(&p.workspace).bind(&p.id).fetch_all(&self.pool).await?;
        rows.into_iter().map(decode).collect()
    }

    async fn refresh_funding(&self, mut task: Task) -> Result<Task, Error> {
        if let Some(f) = &task.subscription_funding {
            let blocked: Option<bool> = sqlx::query_scalar("SELECT blocked FROM paypal_subscription_periods WHERE subscription_id=$1 AND start_at=$2").bind(&f.subscription_id).bind(f.period_start).fetch_optional(&self.pool).await?;
            if blocked != Some(false) {
                task.payment_review =
                    Some("Subscription funding requires merchant billing review".into());
            }
        }
        Ok(task)
    }

    /// The short transaction claims work before provider I/O. No network calls
    /// belong inside `change`; a crashed dispatch remains unknown, never reset.
    pub async fn update<R>(
        &self,
        id: &str,
        p: &Principal,
        change: impl FnOnce(&mut Task) -> Result<R, Error>,
    ) -> Result<(Task, R), Error> {
        let mut tx = self.pool.begin().await?;
        let value: Option<Value> = sqlx::query_scalar("SELECT record FROM paypal_tasks WHERE id=$1 AND workspace=$2 AND (principal=$3 OR $4 OR ((record->'subscription_funding'->>'buyer'=$3 OR record->'purchase'->>'buyer'=$3) AND $5)) FOR UPDATE")
            .bind(id).bind(&p.workspace).bind(&p.id).bind(p.role == Role::Merchant).bind(p.role == Role::Buyer).fetch_optional(&mut *tx).await?;
        let mut task = decode(value.ok_or(Error::NotFound)?)?;
        Store::account_allowance(&mut tx, &mut task).await?;
        let result = change(&mut task)?;
        Store::account_allowance(&mut tx, &mut task).await?;
        sqlx::query("UPDATE paypal_tasks SET record=$1 WHERE id=$2")
            .bind(serde_json::to_value(&task).map_err(|_| Error::Invalid("Invalid task"))?)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok((task, result))
    }

    /// Called only after provider signature verification. Conflicting duplicate
    /// IDs never overwrite an accepted event. A DB error must not receive 200.
    pub async fn insert_event(&self, event: &Value) -> Result<(), Error> {
        let id = event
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or(Error::Invalid("Webhook event ID missing"))?;
        sqlx::query("INSERT INTO paypal_webhook_inbox(id,event,received_at) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING")
            .bind(id).bind(event).bind(now() as i64).execute(&self.pool).await?;
        let original: Value =
            sqlx::query_scalar("SELECT event FROM paypal_webhook_inbox WHERE id=$1")
                .bind(id)
                .fetch_one(&self.pool)
                .await?;
        if original != *event {
            return Err(Error::Conflict);
        }
        Ok(())
    }

    pub async fn pending_events(&self) -> Result<Vec<Value>, Error> {
        Ok(sqlx::query_scalar("WITH candidates AS (SELECT id FROM paypal_webhook_inbox WHERE processed_at IS NULL ORDER BY attempted_at NULLS FIRST, received_at, id LIMIT 100 FOR UPDATE SKIP LOCKED) UPDATE paypal_webhook_inbox inbox SET attempted_at=EXTRACT(EPOCH FROM clock_timestamp())::BIGINT FROM candidates WHERE inbox.id=candidates.id RETURNING inbox.event").fetch_all(&self.pool).await?)
    }
    pub async fn mark_event(&self, id: &str) -> Result<(), Error> {
        sqlx::query("UPDATE paypal_webhook_inbox SET processed_at=$1 WHERE id=$2")
            .bind(now() as i64)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn shared(&self, token: &str) -> Result<Task, Error> {
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::NotFound);
        }
        let value: Option<Value> =
            sqlx::query_scalar("SELECT record FROM paypal_tasks WHERE record->>'share_token'=$1")
                .bind(token)
                .fetch_optional(&self.pool)
                .await?;
        self.refresh_funding(decode(value.ok_or(Error::NotFound)?)?)
            .await
    }

    pub(crate) async fn related(&self, ids: &[String]) -> Result<Vec<Task>, Error> {
        let rows: Vec<Value> = sqlx::query_scalar("SELECT record FROM paypal_tasks WHERE id=ANY($1) OR record->>'order_id'=ANY($1) OR record->>'capture_id'=ANY($1) OR record->>'refund_id'=ANY($1) OR record->'refund'->>'key'=ANY($1) OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(record->'refunds','[]'::jsonb)) r WHERE r->>'provider_id'=ANY($1) OR r->'operation'->>'key'=ANY($1)) LIMIT 100")
            .bind(ids).fetch_all(&self.pool).await?;
        rows.into_iter().map(decode).collect()
    }
}

fn decode(value: Value) -> Result<Task, Error> {
    serde_json::from_value(value).map_err(|_| Error::Invalid("Stored task is invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paypal::domain::Document;

    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn durable_claims_roles_replay_and_inbox_survive_reconnect() {
        let url = std::env::var("PAYPAL_TEST_DATABASE_URL").expect("isolated database required");
        let a = Store::connect(&url).await.unwrap();
        let b = Store::connect(&url).await.unwrap();
        let p = Principal {
            id: random_id().unwrap(),
            workspace: random_id().unwrap(),
            role: Role::Buyer,
        };
        let token = a.issue_access(&p, 60 * 86400).await.unwrap();
        assert!(a.issue_access(&p, 61 * 86400).await.is_err());
        assert_eq!(b.authenticate(&token).await.unwrap().id, p.id);
        let task = Task::quote(
            &p,
            vec![Document {
                name: "doc".into(),
                text: "actual input".into(),
            }],
        )
        .unwrap();
        let request = random_id().unwrap();
        let first = a.create(&task, &request, "same").await.unwrap();
        assert_eq!(
            b.create(&task, &request, "same").await.unwrap().id,
            first.id
        );
        assert!(matches!(
            b.create(&task, &request, "different").await,
            Err(Error::Conflict)
        ));
        let digest = &task.quote_digest;
        let (left, right) = tokio::join!(
            a.update(&task.id, &p, |t| t.start_checkout(&p, digest)),
            b.update(&task.id, &p, |t| t.start_checkout(&p, digest))
        );
        let wins = [left.unwrap().1, right.unwrap().1]
            .iter()
            .filter(|k| k.is_some())
            .count();
        assert_eq!(wins, 1);
        let stranger = Principal {
            id: p.id.clone(),
            workspace: "stranger".into(),
            role: Role::Merchant,
        };
        assert!(matches!(
            b.get(&task.id, &stranger).await,
            Err(Error::NotFound)
        ));
        let restored = Store::connect(&url).await.unwrap();
        assert!(restored.get(&task.id, &p).await.unwrap().order.is_some());
        assert!(a.rate_limit(&p.id, 1).await.is_ok());
        assert!(b.rate_limit(&p.id, 1).await.is_err());
        let mut merchant = p.clone();
        merchant.role = Role::Merchant;
        a.update(&task.id, &p, |t| {
            t.captured = true;
            t.capture_id = Some("fixture-capture".into());
            t.units[0].state = crate::paypal::domain::UnitState::Failed;
            Ok(())
        })
        .await
        .unwrap();
        let (_, refund_digest) = b
            .get(&task.id, &p)
            .await
            .unwrap()
            .refund_proposal()
            .unwrap();
        let (left, right) = tokio::join!(
            a.update(&task.id, &merchant, |t| t
                .approve_refund(&merchant, &refund_digest)),
            b.update(&task.id, &merchant, |t| t
                .approve_refund(&merchant, &refund_digest))
        );
        assert_eq!(
            [left.unwrap().1, right.unwrap().1]
                .iter()
                .filter(|k| k.is_some())
                .count(),
            1
        );
        let event = serde_json::json!({"id":random_id().unwrap(),"event_type":"fixture"});
        a.insert_event(&event).await.unwrap();
        b.insert_event(&event).await.unwrap();
        let mut conflict = event.clone();
        conflict["event_type"] = "changed".into();
        assert!(matches!(
            a.insert_event(&conflict).await,
            Err(Error::Conflict)
        ));
        a.mark_event(event["id"].as_str().unwrap()).await.unwrap();
        b.revoke(&token).await.unwrap();
        assert!(a.authenticate(&token).await.is_err());
    }
    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn unmatched_events_do_not_starve_new_events() {
        let store = Store::connect(&std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let mut ids = Vec::new();
        for _ in 0..105 {
            let id = random_id().unwrap();
            store
                .insert_event(&serde_json::json!({"id":id,"event_type":"unmatched-fixture"}))
                .await
                .unwrap();
            ids.push(id);
        }
        store.pending_events().await.unwrap();
        let fresh = random_id().unwrap();
        store
            .insert_event(&serde_json::json!({"id":fresh,"event_type":"new-fixture"}))
            .await
            .unwrap();
        assert!(
            store
                .pending_events()
                .await
                .unwrap()
                .iter()
                .any(|event| event["id"] == fresh)
        );
        ids.push(fresh);
        for id in ids {
            store.mark_event(&id).await.unwrap();
        }
    }
}
