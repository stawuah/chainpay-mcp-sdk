//! Buyer allowances: a cap an agent can spend from a vaulted PayPal or card
//! funding source. The vault token never leaves this server.
use super::{
    domain::{self, Error, Operation, OperationState, Principal, Role, Task},
    money::Cents,
    observations,
    routes::App,
    store::Store,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

pub const RULE: &str = "allowance-rules-v1";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Vault {
    pub source: String,
    pub setup_token_id: Option<String>,
    pub payment_token_id: Option<String>,
    pub approval_url: Option<String>,
    pub setup: Operation,
    pub token: Option<Operation>,
    /// DELETE of the payment token after a revoke; outcome kept like any call.
    #[serde(default)]
    pub delete: Option<Operation>,
}
impl Vault {
    pub fn status(&self) -> &'static str {
        if self.payment_token_id.is_some() {
            "ready"
        } else if self.approval_url.is_some() {
            "pending_approval"
        } else {
            "none"
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Allowance {
    pub id: String,
    pub workspace: String,
    pub buyer: String,
    pub agent: Option<String>,
    pub name: String,
    pub status: String,
    pub mode: String,
    /// ask_above only: purchases over this ask the buyer first.
    #[serde(default)]
    pub ask_above_cents: Cents,
    pub merchants: Vec<String>,
    /// Merchant kinds from the catalog; empty means any kind.
    #[serde(default)]
    pub categories: Vec<String>,
    pub total_cap_cents: Cents,
    pub per_purchase_cap_cents: Cents,
    pub expires_at: u64,
    pub cooldown_seconds: u64,
    pub max_per_day: u32,
    pub created_at: u64,
    pub vault: Vault,
    #[serde(default)]
    pub fingerprint: String,
}
impl Allowance {
    #[cfg(test)]
    pub(crate) fn fixture(buyer: &str, mode: &str) -> Self {
        Self {
            id: "allowance-fixture".into(),
            workspace: "workspace".into(),
            buyer: buyer.into(),
            agent: None,
            name: "Groceries".into(),
            status: "Active".into(),
            mode: mode.into(),
            ask_above_cents: Cents(0),
            merchants: vec!["grocer".into()],
            categories: vec![],
            total_cap_cents: Cents(5000),
            per_purchase_cap_cents: Cents(2000),
            expires_at: domain::now() + 86400,
            cooldown_seconds: 0,
            max_per_day: 5,
            created_at: domain::now(),
            vault: Vault {
                source: "card".into(),
                setup_token_id: None,
                payment_token_id: Some("token".into()),
                approval_url: None,
                setup: Operation::begin().unwrap(),
                token: None,
                delete: None,
            },
            fingerprint: String::new(),
        }
    }
    /// Whether this purchase waits for the buyer: always for ask_first, over
    /// the threshold for ask_above, never for agent_pays.
    pub fn needs_approval(&self, amount: Cents) -> bool {
        match self.mode.as_str() {
            "ask_first" => true,
            "ask_above" => amount.0 > self.ask_above_cents.0,
            _ => false,
        }
    }
}

/// What the allowance has already been used for, from the spend table.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Usage {
    pub spent: Cents,
    pub purchases_today: u32,
    pub last_purchase_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Check {
    pub rule: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit_cents: Option<Cents>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_cents: Option<Cents>,
    pub allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Policy {
    pub allowed: bool,
    pub rule: String,
    pub allowance_id: String,
    pub reason_code: Option<String>,
    pub checks: Vec<Check>,
}

/// Pure rule evaluation. The first failing check names the reason code.
pub fn check(
    a: &Allowance,
    actor: &Principal,
    merchant: &str,
    amount: Cents,
    usage: &Usage,
    now: u64,
) -> Policy {
    let agent_ok = match actor.role {
        Role::Agent => a.agent.as_deref().is_none_or(|g| g == actor.id),
        Role::Buyer => a.buyer == actor.id,
        Role::Merchant => false,
    };
    let since_last = usage.last_purchase_at.map(|t| now.saturating_sub(t));
    let cooldown_ok = since_last.is_none_or(|s| s >= a.cooldown_seconds);
    let kind = super::catalog::merchant(merchant)
        .map(|m| m.kind)
        .unwrap_or("unknown");
    let rows: Vec<(&str, &str, bool, Option<Cents>, Option<Cents>, String)> = vec![
        (
            "status",
            "allowance_not_active",
            a.status == "Active",
            None,
            None,
            a.status.clone(),
        ),
        (
            "expiry",
            "allowance_expired",
            a.expires_at > now,
            None,
            None,
            a.expires_at.to_string(),
        ),
        (
            "agent",
            "agent_not_allowed",
            agent_ok,
            None,
            None,
            actor.id.clone(),
        ),
        (
            "merchant",
            "merchant_not_allowed",
            a.merchants.iter().any(|m| m == merchant),
            None,
            None,
            merchant.into(),
        ),
        (
            "category",
            "category_not_allowed",
            a.categories.is_empty() || a.categories.iter().any(|c| c == kind),
            None,
            None,
            if a.categories.is_empty() {
                format!("{kind}; any category allowed")
            } else {
                format!("{kind} is not in {}", a.categories.join(", "))
            },
        ),
        (
            "per_purchase_cap",
            "per_purchase_cap",
            amount.0 <= a.per_purchase_cap_cents.0,
            Some(a.per_purchase_cap_cents),
            Some(amount),
            amount.decimal(),
        ),
        (
            "total_cap",
            "total_cap",
            usage.spent.0 + amount.0 <= a.total_cap_cents.0,
            Some(a.total_cap_cents),
            Some(Cents(usage.spent.0 + amount.0)),
            format!("{} spent", usage.spent.decimal()),
        ),
        (
            "max_per_day",
            "max_per_day",
            usage.purchases_today < a.max_per_day,
            None,
            None,
            format!("{} of {} today", usage.purchases_today, a.max_per_day),
        ),
        (
            "cooldown",
            "cooldown",
            cooldown_ok,
            None,
            None,
            match since_last {
                Some(s) => format!("{s}s since last purchase"),
                None => "no purchases yet".into(),
            },
        ),
        (
            "vault",
            "vault_not_ready",
            a.vault.payment_token_id.is_some(),
            None,
            None,
            a.vault.status().into(),
        ),
    ];
    let mut checks = Vec::new();
    let mut reason_code = None;
    for (rule, code, allowed, limit_cents, observed_cents, observed) in rows {
        if !allowed && reason_code.is_none() {
            reason_code = Some(code.to_string());
        }
        checks.push(Check {
            rule: rule.into(),
            limit_cents,
            observed_cents,
            allowed,
            observed: Some(observed),
        });
    }
    Policy {
        allowed: reason_code.is_none(),
        rule: RULE.into(),
        allowance_id: a.id.clone(),
        reason_code,
        checks,
    }
}

fn decode(v: Value) -> Result<Allowance, Error> {
    serde_json::from_value(v).map_err(|_| Error::Invalid("Stored allowance is invalid"))
}
/// Reserve rows that have no release for the same task, less confirmed refunds
/// on that task (never below zero), excluding one task so an approval can
/// re-check without counting itself.
async fn usage(
    conn: &mut sqlx::PgConnection,
    allowance_id: &str,
    exclude_task: &str,
    now: u64,
) -> Result<Usage, Error> {
    let rows = sqlx::query("SELECT cents,created_at,COALESCE((SELECT SUM(f.cents) FROM paypal_allowance_spend f WHERE f.allowance_id=s.allowance_id AND f.task_id=s.task_id AND f.kind='refund'),0)::BIGINT AS refunded FROM paypal_allowance_spend s WHERE allowance_id=$1 AND kind='reserve' AND task_id<>$2 AND NOT EXISTS(SELECT 1 FROM paypal_allowance_spend r WHERE r.allowance_id=s.allowance_id AND r.task_id=s.task_id AND r.kind='release')")
        .bind(allowance_id).bind(exclude_task).fetch_all(conn).await?;
    let day_start = now - now % 86400;
    let mut u = Usage {
        spent: Cents(0),
        purchases_today: 0,
        last_purchase_at: None,
    };
    for row in rows {
        let cents: i64 = row.get("cents");
        let at: i64 = row.get("created_at");
        let refunded: i64 = row.get("refunded");
        u.spent = Cents(u.spent.0 + (cents as u64).saturating_sub(refunded.max(0) as u64));
        if at as u64 >= day_start {
            u.purchases_today += 1;
        }
        u.last_purchase_at = Some(u.last_purchase_at.unwrap_or(0).max(at as u64));
    }
    Ok(u)
}
async fn spend(
    conn: &mut sqlx::PgConnection,
    kind: &str,
    allowance_id: &str,
    task_id: &str,
    cents: Cents,
) -> Result<(), Error> {
    sqlx::query("INSERT INTO paypal_allowance_spend(entry_key,allowance_id,task_id,kind,cents,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING")
        .bind(format!("{kind}:{task_id}")).bind(allowance_id).bind(task_id).bind(kind).bind(cents.0 as i64).bind(domain::now() as i64).execute(conn).await?;
    Ok(())
}

/// Confirmed refunds on a task, by provider refund id: the original refund
/// and each resolution refund. Partial refunds carry only their own amount.
pub fn confirmed_refunds(task: &Task) -> Vec<(String, Cents)> {
    let mut out = Vec::new();
    if let (true, Some(id)) = (task.refund_confirmed, &task.refund_id) {
        out.push((id.clone(), task.refund_amount));
    }
    for r in task.refunds.iter().filter(|r| r.confirmed) {
        if let Some(id) = &r.provider_id {
            out.push((id.clone(), r.amount));
        }
    }
    out
}

impl Store {
    /// One refund row per provider refund id, so a replayed webhook or a
    /// repeated reconcile never credits twice. Takes no task lock: the insert
    /// only key-share locks the allowance, keeping the allowance-first order.
    pub(crate) async fn credit_refunds(&self, task: &Task) -> Result<u64, Error> {
        let Some(purchase) = &task.purchase else {
            return Ok(0);
        };
        let mut added = 0;
        for (refund_id, cents) in confirmed_refunds(task) {
            added += sqlx::query("INSERT INTO paypal_allowance_spend(entry_key,allowance_id,task_id,kind,cents,created_at) VALUES($1,$2,$3,'refund',$4,$5) ON CONFLICT DO NOTHING")
                .bind(format!("refund:{refund_id}")).bind(&purchase.allowance_id).bind(&task.id).bind(cents.0 as i64).bind(domain::now() as i64)
                .execute(self.pool()).await?.rows_affected();
        }
        Ok(added)
    }
    pub(crate) async fn allowance_record(&self, id: &str) -> Result<Allowance, Error> {
        let v: Option<Value> =
            sqlx::query_scalar("SELECT record FROM paypal_allowances WHERE id=$1")
                .bind(id)
                .fetch_optional(self.pool())
                .await?;
        decode(v.ok_or(Error::NotFound)?)
    }
    /// Buyers see their own, agents see Active ones they may spend from, and
    /// merchants never see a buyer's budget. Quote and purchase resolve the
    /// allowance through this too, so nobody can probe caps they cannot see.
    fn visible(a: &Allowance, p: &Principal) -> bool {
        a.workspace == p.workspace
            && match p.role {
                Role::Buyer => a.buyer == p.id,
                Role::Merchant => false,
                Role::Agent => a.status == "Active" && a.agent.as_deref().is_none_or(|g| g == p.id),
            }
    }
    pub async fn allowance(&self, id: &str, p: &Principal) -> Result<Allowance, Error> {
        let a = self.allowance_record(id).await?;
        if !Store::visible(&a, p) {
            return Err(Error::NotFound);
        }
        Ok(a)
    }
    pub async fn allowances(&self, p: &Principal) -> Result<Vec<Allowance>, Error> {
        let rows: Vec<Value> = sqlx::query_scalar("SELECT record FROM paypal_allowances WHERE workspace=$1 AND ($2 OR buyer=$3) ORDER BY created_at DESC,id LIMIT 100")
            .bind(&p.workspace).bind(p.role != Role::Buyer).bind(&p.id).fetch_all(self.pool()).await?;
        let mut out = Vec::new();
        for row in rows {
            let a = decode(row)?;
            if Store::visible(&a, p) {
                out.push(a);
            }
        }
        Ok(out)
    }
    pub async fn usage(
        &self,
        allowance_id: &str,
        exclude_task: &str,
        now: u64,
    ) -> Result<Usage, Error> {
        let mut conn = self.pool().acquire().await?;
        usage(&mut conn, allowance_id, exclude_task, now).await
    }
    pub async fn allowance_view(&self, a: &Allowance, p: &Principal) -> Result<Value, Error> {
        let u = self.usage(&a.id, "", domain::now()).await?;
        let mut view = json!({"id":a.id,"name":a.name,"status":a.status,"mode":a.mode,"ask_above_cents":a.ask_above_cents,"agent":a.agent,"merchants":a.merchants,"categories":a.categories,
            "total_cap_cents":a.total_cap_cents,"per_purchase_cap_cents":a.per_purchase_cap_cents,
            "spent_cents":u.spent,"remaining_cents":Cents(a.total_cap_cents.0.saturating_sub(u.spent.0)),
            "purchases_today":u.purchases_today,"max_per_day":a.max_per_day,"cooldown_seconds":a.cooldown_seconds,
            "last_purchase_at":u.last_purchase_at,"expires_at":a.expires_at,"created_at":a.created_at,"sandbox":true});
        if p.role == Role::Buyer && a.buyer == p.id {
            let mut vault = json!({"source":a.vault.source,"status":a.vault.status(),
                "delete_state":a.vault.delete.as_ref().map(|o| &o.state)});
            if a.vault.payment_token_id.is_none() {
                vault["approval_url"] = json!(a.vault.approval_url);
            }
            view["vault"] = vault;
        }
        Ok(view)
    }
    /// Lock, change, write. No provider calls inside `change`.
    pub(crate) async fn update_allowance<R>(
        &self,
        id: &str,
        change: impl FnOnce(&mut Allowance) -> Result<R, Error>,
    ) -> Result<(Allowance, R), Error> {
        let mut tx = self.pool().begin().await?;
        let v: Option<Value> =
            sqlx::query_scalar("SELECT record FROM paypal_allowances WHERE id=$1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        let mut a = decode(v.ok_or(Error::NotFound)?)?;
        let result = change(&mut a)?;
        sqlx::query("UPDATE paypal_allowances SET record=$1 WHERE id=$2")
            .bind(json!(a))
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok((a, result))
    }
    /// Creates the purchase task and runs the policy inside one transaction so
    /// two agents cannot both squeeze under the cap. A retry with the same
    /// request_id returns the stored task without touching the allowance.
    pub async fn purchase(
        &self,
        task: &Task,
        request_id: &str,
        fingerprint: &str,
        p: &Principal,
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
        let mut task = task.clone();
        let purchase = task.purchase.clone().ok_or(Error::Conflict)?;
        // Lock order everywhere: allowance, spend, then paypal_tasks.
        let mut tx = self.pool().begin().await?;
        let v: Option<Value> =
            sqlx::query_scalar("SELECT record FROM paypal_allowances WHERE id=$1 FOR UPDATE")
                .bind(&purchase.allowance_id)
                .fetch_optional(&mut *tx)
                .await?;
        let a = decode(v.ok_or(Error::NotFound)?)?;
        let now = domain::now();
        let u = usage(&mut tx, &a.id, &task.id, now).await?;
        let policy = check(&a, p, &purchase.merchant, task.amount, &u, now);
        if policy.allowed {
            spend(&mut tx, "reserve", &a.id, &task.id, task.amount).await?;
        }
        let c = task.purchase.as_mut().unwrap();
        if policy.allowed && a.needs_approval(task.amount) {
            c.approval = Some("requested".into());
            c.approval_requested_at = Some(now);
        }
        c.policy = policy;
        let inserted = sqlx::query("INSERT INTO paypal_tasks(id,workspace,principal,request_id,fingerprint,record,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace,principal,request_id) DO NOTHING")
            .bind(&task.id).bind(&task.workspace).bind(&task.principal).bind(request_id).bind(fingerprint).bind(json!(task))
            .bind(task.created_at as i64).execute(&mut *tx).await?.rows_affected() == 1;
        if inserted {
            tx.commit().await?;
            return Ok(task);
        }
        // A retry: drop the reserve made above and answer with the stored task.
        tx.rollback().await?;
        let row = sqlx::query("SELECT fingerprint,record FROM paypal_tasks WHERE workspace=$1 AND principal=$2 AND request_id=$3")
            .bind(&task.workspace).bind(&task.principal).bind(request_id).fetch_one(self.pool()).await?;
        if row.get::<String, _>("fingerprint") != fingerprint {
            return Err(Error::Conflict);
        }
        serde_json::from_value(row.get("record"))
            .map_err(|_| Error::Invalid("Stored task is invalid"))
    }
    /// Locks the allowance first, then the task, in the same order purchase()
    /// uses. The task's allowance id never changes, so an unlocked peek is enough.
    async fn lock_purchase_task(
        tx: &mut sqlx::PgConnection,
        id: &str,
        p: &Principal,
    ) -> Result<(Task, Allowance), Error> {
        let allowance_id: Option<String> = sqlx::query_scalar("SELECT record->'purchase'->>'allowance_id' FROM paypal_tasks WHERE id=$1 AND workspace=$2 AND record->'purchase'->>'buyer'=$3")
            .bind(id).bind(&p.workspace).bind(&p.id).fetch_optional(&mut *tx).await?;
        let v: Option<Value> =
            sqlx::query_scalar("SELECT record FROM paypal_allowances WHERE id=$1 FOR UPDATE")
                .bind(allowance_id.ok_or(Error::NotFound)?)
                .fetch_optional(&mut *tx)
                .await?;
        let a = decode(v.ok_or(Error::NotFound)?)?;
        let v: Option<Value> = sqlx::query_scalar("SELECT record FROM paypal_tasks WHERE id=$1 AND workspace=$2 AND record->'purchase'->>'buyer'=$3 FOR UPDATE")
            .bind(id).bind(&p.workspace).bind(&p.id).fetch_optional(&mut *tx).await?;
        let task: Task = serde_json::from_value(v.ok_or(Error::NotFound)?)
            .map_err(|_| Error::Invalid("Stored task is invalid"))?;
        Ok((task, a))
    }
    /// Re-runs the rules at approval time; the earlier reserve stays in place.
    /// A failed re-check denies the purchase and releases the reserve, so the
    /// request does not sit in the inbox forever.
    pub async fn approve_purchase(&self, id: &str, p: &Principal) -> Result<Task, Error> {
        let mut tx = self.pool().begin().await?;
        let (mut task, a) = Store::lock_purchase_task(&mut tx, id, p).await?;
        let purchase = task.purchase.clone().ok_or(Error::NotFound)?;
        if p.role != Role::Buyer || !matches!(purchase.mode.as_str(), "ask_first" | "ask_above") {
            return Err(Error::Forbidden);
        }
        match purchase.approval.as_deref() {
            Some("approved") => return Ok(task),
            Some("requested") => {}
            _ => return Err(Error::Conflict),
        }
        let now = domain::now();
        let u = usage(&mut tx, &a.id, &task.id, now).await?;
        let policy = check(&a, p, &purchase.merchant, task.amount, &u, now);
        let c = task.purchase.as_mut().unwrap();
        c.approval_decided_at = Some(now);
        if policy.allowed {
            spend(&mut tx, "reserve", &a.id, &task.id, task.amount).await?;
            c.approval = Some("approved".into());
            c.approved_by = Some(p.id.clone());
        } else {
            spend(&mut tx, "release", &a.id, &task.id, task.amount).await?;
            c.approval = Some("denied".into());
            c.approved_by = Some("rules".into());
        }
        c.policy = policy;
        sqlx::query("UPDATE paypal_tasks SET record=$1 WHERE id=$2")
            .bind(json!(task))
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(task)
    }
    pub async fn deny_purchase(
        &self,
        id: &str,
        p: &Principal,
        reason: &str,
    ) -> Result<Task, Error> {
        let mut tx = self.pool().begin().await?;
        let (mut task, _) = Store::lock_purchase_task(&mut tx, id, p).await?;
        let c = task.purchase.as_mut().ok_or(Error::NotFound)?;
        if p.role != Role::Buyer {
            return Err(Error::Forbidden);
        }
        match c.approval.as_deref() {
            Some("denied") => return Ok(task),
            Some("requested") => {}
            _ => return Err(Error::Conflict),
        }
        c.approval = Some("denied".into());
        c.approval_decided_at = Some(domain::now());
        c.approved_by = Some(p.id.clone());
        c.policy.allowed = false;
        c.policy.reason_code = Some("denied".into());
        c.policy.checks.push(Check {
            rule: "buyer_decision".into(),
            limit_cents: None,
            observed_cents: None,
            allowed: false,
            observed: Some(reason.into()),
        });
        let allowance_id = c.allowance_id.clone();
        spend(&mut tx, "release", &allowance_id, id, task.amount).await?;
        sqlx::query("UPDATE paypal_tasks SET record=$1 WHERE id=$2")
            .bind(json!(task))
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(task)
    }
}

impl App {
    /// A confirmed refund on an allowance purchase gives its cents back to the
    /// allowance. Behind CHAINPAY_PAYPAL_ALLOWANCES; safe to call repeatedly.
    pub(crate) async fn credit_refunds(&self, id: &str, p: &Principal) -> Result<(), Error> {
        if !self.config.allowances {
            return Ok(());
        }
        let task = self.store.get(id, p).await?;
        self.store.credit_refunds(&task).await?;
        Ok(())
    }
    pub(crate) fn allowances_enabled(&self) -> Result<(), Error> {
        self.purchases()?;
        if !self.config.allowances {
            return Err(Error::Invalid(
                "Allowances and catalog purchases are paused",
            ));
        }
        Ok(())
    }
    /// Charges a purchase against the vault. Shared by agent_pays purchases and
    /// buyer approvals. Never dispatches twice: the order Operation is claimed
    /// under the task lock before any provider call.
    pub async fn charge_purchase(&self, id: &str, p: &Principal) -> Result<Task, Error> {
        let task = self.store.get(id, p).await?;
        let purchase = task.purchase.as_ref().ok_or(Error::Conflict)?;
        let a = self.store.allowance_record(&purchase.allowance_id).await?;
        // The rules passed earlier, but the buyer may have paused it since.
        if a.status != "Active" || a.expires_at <= domain::now() {
            return Err(Error::Conflict);
        }
        let token = a.vault.payment_token_id.clone().ok_or(Error::Invalid(
            "Vault not ready; finish the PayPal approval first",
        ))?;
        let (task, key) = self
            .store
            .update(id, p, |t| t.start_vault_charge(p))
            .await?;
        if let Some(key) = key {
            match self
                .provider
                .create_vault_order(id, task.amount, &a.vault.source, &token, &key)
                .await
            {
                Ok(value) => {
                    self.store
                        .update(id, p, |t| observations::order(t, value))
                        .await?;
                }
                Err(_) => {
                    self.store
                        .update(id, p, |t| {
                            t.order.as_mut().unwrap().unknown();
                            Ok(())
                        })
                        .await?;
                }
            }
        }
        // Vault orders usually come back COMPLETED; an APPROVED one still needs a capture call.
        let task = self.store.get(id, p).await?;
        let approved = task
            .order
            .as_ref()
            .and_then(|o| o.observation.as_ref())
            .and_then(|v| v["status"].as_str())
            == Some("APPROVED");
        if task.captured || task.capture.is_some() || !approved {
            return Ok(task);
        }
        let (task, key) = self
            .store
            .update(id, p, |t| {
                if t.capture.is_some() {
                    return Ok(None);
                }
                let op = Operation::begin()?;
                let key = op.key.clone();
                t.capture = Some(op);
                Ok(Some(key))
            })
            .await?;
        if let Some(key) = key {
            let order_id = task.order_id.as_deref().ok_or(Error::Conflict)?;
            match self.provider.capture_order(order_id, &key).await {
                Ok(value) => {
                    self.store
                        .update(id, p, |t| observations::order(t, value))
                        .await?;
                }
                Err(_) => {
                    self.store
                        .update(id, p, |t| {
                            t.capture.as_mut().unwrap().unknown();
                            Ok(())
                        })
                        .await?;
                }
            }
        }
        self.store.get(id, p).await
    }
    /// Verified inbox only. A deleted vault token pauses the allowance.
    pub(crate) async fn vault_event(&self, event: &Value) -> Result<bool, Error> {
        let typ = event["event_type"].as_str().unwrap_or("");
        if !typ.starts_with("VAULT.PAYMENT-TOKEN.") {
            return Ok(false);
        }
        let Some(token) = event["resource"]["id"].as_str() else {
            return Ok(false);
        };
        // A token we deleted on revoke is matched through the delete record.
        let ids: Vec<String> = sqlx::query_scalar(
            "SELECT id FROM paypal_allowances WHERE record->'vault'->>'payment_token_id'=$1 OR record->'vault'->'delete'->'observation'->>'token'=$1",
        )
        .bind(token)
        .fetch_all(self.store.pool())
        .await?;
        if ids.is_empty() {
            return Ok(false);
        }
        if typ == "VAULT.PAYMENT-TOKEN.DELETED" || typ == "VAULT.PAYMENT-TOKEN.DELETION-INITIATED" {
            for id in ids {
                self.store
                    .update_allowance(&id, |a| {
                        a.vault.payment_token_id = None;
                        a.vault.setup_token_id = None;
                        a.vault.approval_url = None;
                        if a.status == "Active" {
                            a.status = "Paused".into();
                        }
                        Ok(())
                    })
                    .await?;
            }
        }
        Ok(true)
    }
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/v1/paypal/allowances", get(list).post(create))
        .route("/v1/paypal/allowances/{id}", get(read))
        .route("/v1/paypal/allowances/{id}/vault", post(finish_vault))
        .route("/v1/paypal/allowances/{id}/status", post(set_status))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Card {
    number: String,
    expiry: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    request_id: String,
    name: String,
    total_cap_cents: u64,
    per_purchase_cap_cents: u64,
    expires_at: u64,
    cooldown_seconds: u64,
    max_per_day: u32,
    merchants: Vec<String>,
    mode: String,
    #[serde(default)]
    ask_above_cents: u64,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    agent: Option<String>,
    vault_source: String,
    #[serde(default)]
    card: Option<Card>,
}
fn approve_link(value: &Value) -> Result<Option<String>, Error> {
    for link in value["links"].as_array().into_iter().flatten() {
        if matches!(link["rel"].as_str(), Some("approve" | "payer-action")) {
            let href = link["href"]
                .as_str()
                .ok_or(Error::Invalid("Invalid approval link"))?;
            let u = url::Url::parse(href).map_err(|_| Error::Invalid("Invalid approval link"))?;
            if u.scheme() != "https"
                || u.host_str() != Some("www.sandbox.paypal.com")
                || u.port().is_some()
                || !u.username().is_empty()
                || u.password().is_some()
            {
                return Err(Error::Invalid("Unexpected approval origin"));
            }
            return Ok(Some(href.into()));
        }
    }
    Ok(None)
}
async fn create(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<Create>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    if p.role != Role::Buyer {
        return Err(Error::Forbidden);
    }
    app.allowances_enabled()?;
    let now = domain::now();
    let known: Vec<&str> = super::catalog::merchants().iter().map(|m| m.id).collect();
    let mut merchants = body.merchants.clone();
    merchants.sort();
    merchants.dedup();
    let kinds: Vec<&str> = super::catalog::merchants().iter().map(|m| m.kind).collect();
    let mut categories = body.categories.clone();
    categories.sort();
    categories.dedup();
    if body.request_id.len() < 16
        || body.request_id.len() > 64
        || !body
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || body.name.trim().is_empty()
        || body.name.chars().count() > 80
        || body.total_cap_cents == 0
        || body.total_cap_cents > 1_000_000
        || body.per_purchase_cap_cents == 0
        || body.per_purchase_cap_cents > body.total_cap_cents
        || body.expires_at <= now
        || body.expires_at > now + 366 * 86400
        || body.cooldown_seconds > 7 * 86400
        || body.max_per_day == 0
        || body.max_per_day > 100
        || merchants.is_empty()
        || merchants.iter().any(|m| !known.contains(&m.as_str()))
        || !matches!(body.mode.as_str(), "agent_pays" | "ask_first" | "ask_above")
        || (body.mode == "ask_above")
            != (body.ask_above_cents > 0 && body.ask_above_cents <= body.per_purchase_cap_cents)
        || (body.mode != "ask_above" && body.ask_above_cents != 0)
        || categories.iter().any(|c| !kinds.contains(&c.as_str()))
        || body
            .agent
            .as_deref()
            .is_some_and(|a| a.is_empty() || a.len() > 80 || a == p.id)
        || !matches!(body.vault_source.as_str(), "paypal" | "card")
        || (body.vault_source == "card") != body.card.is_some()
    {
        return Err(Error::Invalid(
            "Allowance needs a name, caps in cents, expiry within a year, known merchants and categories, a mode (ask_above needs 0 < ask_above_cents ≤ per_purchase_cap_cents) and a vault source",
        ));
    }
    if let Some(card) = &body.card {
        if !(12..=19).contains(&card.number.len())
            || !card.number.bytes().all(|b| b.is_ascii_digit())
            || card.expiry.len() != 7
            || card.expiry.as_bytes()[4] != b'-'
            || !card.expiry[..4].bytes().all(|b| b.is_ascii_digit())
            || !card.expiry[5..].bytes().all(|b| b.is_ascii_digit())
            || card.name.trim().is_empty()
            || card.name.chars().count() > 80
        {
            return Err(Error::Invalid(
                "Card needs a number, expiry YYYY-MM and name",
            ));
        }
    }
    // The card itself is never part of the fingerprint or the record. The
    // threshold and categories join it only when set, so earlier retries match.
    let base = (
        &body.name,
        body.total_cap_cents,
        body.per_purchase_cap_cents,
        body.expires_at,
        body.cooldown_seconds,
        body.max_per_day,
        &merchants,
        &body.mode,
        &body.agent,
        &body.vault_source,
    );
    let fingerprint = domain::hash(
        &if body.ask_above_cents == 0 && categories.is_empty() {
            serde_json::to_vec(&base)
        } else {
            serde_json::to_vec(&(base, body.ask_above_cents, &categories))
        }
        .unwrap(),
    );
    let a = Allowance {
        id: domain::random_id()?,
        workspace: p.workspace.clone(),
        buyer: p.id.clone(),
        agent: body.agent.clone(),
        name: body.name.trim().into(),
        status: "Active".into(),
        mode: body.mode.clone(),
        ask_above_cents: Cents(body.ask_above_cents),
        merchants,
        categories,
        total_cap_cents: Cents(body.total_cap_cents),
        per_purchase_cap_cents: Cents(body.per_purchase_cap_cents),
        expires_at: body.expires_at,
        cooldown_seconds: body.cooldown_seconds,
        max_per_day: body.max_per_day,
        created_at: now,
        vault: Vault {
            source: body.vault_source.clone(),
            setup_token_id: None,
            payment_token_id: None,
            approval_url: None,
            setup: Operation::begin()?,
            token: None,
            delete: None,
        },
        fingerprint: fingerprint.clone(),
    };
    let inserted = sqlx::query("INSERT INTO paypal_allowances(id,workspace,buyer,request_id,record,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace,buyer,request_id) DO NOTHING")
        .bind(&a.id).bind(&p.workspace).bind(&p.id).bind(&body.request_id).bind(json!(a)).bind(now as i64).execute(app.store.pool()).await?.rows_affected() == 1;
    let id: String = sqlx::query_scalar(
        "SELECT id FROM paypal_allowances WHERE workspace=$1 AND buyer=$2 AND request_id=$3",
    )
    .bind(&p.workspace)
    .bind(&p.id)
    .bind(&body.request_id)
    .fetch_one(app.store.pool())
    .await?;
    if !inserted {
        let existing = app.store.allowance(&id, &p).await?;
        if existing.fingerprint != fingerprint {
            return Err(Error::Conflict);
        }
        return Ok(Json(app.store.allowance_view(&existing, &p).await?));
    }
    let card = body
        .card
        .as_ref()
        .map(|c| json!({"card":{"number":c.number,"expiry":c.expiry,"name":c.name.trim()}}));
    let setup = app
        .provider
        .create_setup_token(&a.id, card, &a.vault.setup.key)
        .await;
    let (a, _) = app
        .store
        .update_allowance(&id, |a| {
            match &setup {
                Ok(v) => {
                    a.vault.setup_token_id = v["id"].as_str().map(String::from);
                    a.vault.approval_url = approve_link(v)?;
                    a.vault
                        .setup
                        .observe(json!({"id":v["id"],"status":v["status"]}));
                }
                Err(_) => a.vault.setup.unknown(),
            }
            Ok(())
        })
        .await?;
    // A card setup token is approved at once, so finish vaulting in the same call.
    if a.vault.source == "card" && a.vault.setup_token_id.is_some() {
        app.vault_token(&id, &p).await?;
    }
    let a = app.store.allowance(&id, &p).await?;
    Ok(Json(app.store.allowance_view(&a, &p).await?))
}
impl App {
    /// Turns an approved setup token into a payment token. Repeat-safe: the
    /// same PayPal-Request-Id is reused until a token id is stored.
    async fn vault_token(&self, id: &str, p: &Principal) -> Result<(), Error> {
        let (a, key) = self
            .store
            .update_allowance(id, |a| {
                if a.buyer != p.id || a.vault.payment_token_id.is_some() {
                    return Ok(None);
                }
                if a.vault.token.is_none() {
                    a.vault.token = Some(Operation::begin()?);
                }
                Ok(Some(a.vault.token.as_ref().unwrap().key.clone()))
            })
            .await?;
        let Some(key) = key else { return Ok(()) };
        let setup = a.vault.setup_token_id.as_deref().ok_or(Error::Invalid(
            "Setup result unknown; create the allowance again with a new request",
        ))?;
        let result = self.provider.create_payment_token(setup, &key).await;
        self.store
            .update_allowance(id, |a| {
                match &result {
                    Ok(v) if v["id"].as_str().is_some_and(|s| !s.is_empty()) => {
                        a.vault.payment_token_id = v["id"].as_str().map(String::from);
                        a.vault.approval_url = None;
                        if let Some(op) = &mut a.vault.token {
                            op.observe(json!({"id":v["id"]}));
                        }
                    }
                    _ => {
                        if let Some(op) = &mut a.vault.token {
                            op.unknown();
                        }
                    }
                }
                Ok(())
            })
            .await?;
        if result.is_err() {
            return Err(Error::Invalid(
                "Vault token result unavailable; retry Continue PayPal approval",
            ));
        }
        Ok(())
    }
}
async fn finish_vault(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let a = app.store.allowance(&id, &p).await?;
    if p.role != Role::Buyer || a.buyer != p.id {
        return Err(Error::Forbidden);
    }
    if a.vault.payment_token_id.is_none() {
        let setup = a.vault.setup_token_id.as_deref().ok_or(Error::Invalid(
            "Setup result unknown; create the allowance again with a new request",
        ))?;
        let observed = app.provider.setup_token(setup).await.map_err(|_| {
            Error::Invalid("PayPal setup token unavailable; keep this allowance and retry")
        })?;
        if observed["status"] != "APPROVED" {
            return Err(Error::Invalid(
                "PayPal approval has not been observed; open the approval link first",
            ));
        }
        app.vault_token(&id, &p).await?;
    }
    let a = app.store.allowance(&id, &p).await?;
    Ok(Json(app.store.allowance_view(&a, &p).await?))
}
async fn list(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let mut views = Vec::new();
    for a in app.store.allowances(&p).await? {
        views.push(app.store.allowance_view(&a, &p).await?);
    }
    Ok(Json(json!({"allowances":views})))
}
async fn read(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let a = app.store.allowance(&id, &p).await?;
    Ok(Json(app.store.allowance_view(&a, &p).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Status {
    status: String,
}
async fn set_status(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Status>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    if p.role != Role::Buyer {
        return Err(Error::Forbidden);
    }
    if !matches!(body.status.as_str(), "Active" | "Paused" | "Revoked") {
        return Err(Error::Invalid("Status is Active, Paused or Revoked"));
    }
    let before = app.store.allowance(&id, &p).await?;
    // Revoke also deletes the vault token at PayPal, unless another live
    // allowance still charges the same token.
    let shared = match &before.vault.payment_token_id {
        Some(token) => sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM paypal_allowances WHERE id<>$1 AND record->'vault'->>'payment_token_id'=$2 AND record->>'status'<>'Revoked')")
            .bind(&id).bind(token).fetch_one(app.store.pool()).await?,
        None => true,
    };
    let delete = body.status == "Revoked" && app.config.allowances && !shared;
    let (a, claimed) = app
        .store
        .update_allowance(&id, |a| {
            if p.role != Role::Buyer || a.buyer != p.id {
                return Err(Error::Forbidden);
            }
            if a.status == "Revoked" && body.status != "Revoked" {
                return Err(Error::Conflict);
            }
            a.status = body.status.clone();
            let retry = a
                .vault
                .delete
                .as_ref()
                .is_none_or(|o| o.state == OperationState::Unknown);
            match (&a.vault.payment_token_id, delete && retry) {
                (Some(token), true) => {
                    a.vault.delete = Some(Operation::begin()?);
                    Ok(Some(token.clone()))
                }
                _ => Ok(None),
            }
        })
        .await?;
    let Some(token) = claimed else {
        return Ok(Json(app.store.allowance_view(&a, &p).await?));
    };
    // The revoke above stands whatever PayPal answers; a failure stays Unknown.
    let result = app.provider.delete_payment_token(&token).await;
    let (a, _) = app
        .store
        .update_allowance(&id, |a| {
            let op = a.vault.delete.as_mut().ok_or(Error::Conflict)?;
            match &result {
                Ok(_) => {
                    op.observe(json!({"token":token,"deleted":true}));
                    a.vault.payment_token_id = None;
                    a.vault.approval_url = None;
                }
                Err(_) => op.unknown(),
            }
            Ok(())
        })
        .await?;
    Ok(Json(app.store.allowance_view(&a, &p).await?))
}

#[cfg(test)]
mod tests;
