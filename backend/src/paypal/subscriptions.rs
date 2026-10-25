//! Prepaid service access, independent of Orders captures and on-chain mandates.
//! Calendar periods are ChainPay policy, not provider-certified historical coverage.
use super::{
    domain::{self, Error, Operation, Principal, Role, Task, UnitState},
    routes::App,
    store::Store,
};
use axum::{
    Json, Router,
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
};
use chrono::{DateTime, Months, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

const HISTORY_WINDOWS: usize = 120;
const HISTORY_RECORDS: usize = 1200;

pub const TERMS: &str = "chainpay-monthly-40usd-10units-v1";
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Funding {
    pub subscription_id: String,
    pub buyer: String,
    pub period_start: i64,
    pub period_end: i64,
    pub payment_id: String,
    pub units: u32,
    pub delegation_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Subscription {
    pub id: String,
    pub workspace: String,
    pub buyer: String,
    pub plan_id: String,
    pub terms: String,
    pub created_at: u64,
    pub create: Operation,
    pub cancel: Option<Operation>,
    pub provider_id: Option<String>,
    pub approval_url: Option<String>,
    pub status: String,
    pub payment_review: Option<String>,
    pub anchor: Option<i64>,
    pub observed_next: Option<i64>,
    #[serde(default)]
    pub payment_proofs: std::collections::BTreeMap<String, PaymentProof>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentProof {
    amount_cents: u64,
    currency: String,
    time: i64,
    #[serde(default)]
    subsecond_nanos: u32,
}
fn payment_proof(p: &Value) -> Result<PaymentProof, Error> {
    let amount = &p["amount_with_breakdown"]["gross_amount"];
    if p["status"] != "COMPLETED"
        || amount["currency_code"] != "USD"
        || money(&amount["value"]) != Some(super::money::Cents(4000))
    {
        return Err(Error::Invalid(
            "Contrary subscription payment status or amount",
        ));
    }
    let instant = DateTime::parse_from_rfc3339(
        p["time"]
            .as_str()
            .ok_or(Error::Invalid("Payment time missing"))?,
    )
    .map_err(|_| Error::Invalid("Payment time invalid"))?;
    Ok(PaymentProof {
        amount_cents: 4000,
        currency: "USD".into(),
        time: instant.timestamp(),
        subsecond_nanos: instant.timestamp_subsec_nanos(),
    })
}
fn complete_history(history: &Value) -> bool {
    history["transactions"].as_array().is_some_and(|ps| {
        ps.len() <= HISTORY_RECORDS && history["total_items"].as_u64() == Some(ps.len() as u64)
    }) && history["total_pages"].as_u64().is_some_and(|n| n <= 1)
        && !history["links"]
            .as_array()
            .is_some_and(|ls| ls.iter().any(|l| l["rel"] == "next"))
}
fn canonical_payments(s: &Subscription, payments: &[Value]) -> Result<Vec<Value>, Error> {
    let mut unique = std::collections::BTreeMap::<String, (PaymentProof, Value)>::new();
    let mut statuses = std::collections::BTreeMap::new();
    for p in payments {
        let id = p["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(Error::Invalid("Payment reference missing"))?;
        let status = p["status"].as_str().unwrap_or("UNKNOWN");
        if statuses.insert(id, status).is_some_and(|old| old != status) {
            return Err(Error::Invalid("Contradictory statuses for one payment ID"));
        }
        if matches!(
            p["status"].as_str(),
            Some("REFUNDED" | "PARTIALLY_REFUNDED" | "REVERSED")
        ) || (s.payment_proofs.contains_key(id) && p["status"] != "COMPLETED")
        {
            return Err(Error::Invalid("Contrary payment status"));
        }
        if p["status"] != "COMPLETED" {
            continue;
        }
        let proof = payment_proof(p)?;
        if s.payment_proofs.get(id).is_some_and(|old| *old != proof)
            || unique.get(id).is_some_and(|(old, _)| *old != proof)
        {
            return Err(Error::Invalid("Contradictory payment proof"));
        }
        unique.insert(id.into(), (proof, p.clone()));
    }
    let mut proofs = s.payment_proofs.clone();
    for (id, (proof, _)) in &unique {
        proofs.insert(id.clone(), proof.clone());
    }
    let mut periods = std::collections::BTreeMap::<i64, String>::new();
    if let Some(anchor) = s.anchor {
        for (id, proof) in proofs {
            for n in 0..1200 {
                let Some(start) = month(anchor, n) else { break };
                if start > proof.time {
                    break;
                }
                if proof.time <= start + 3600 && periods.insert(start, id.clone()).is_some() {
                    return Err(Error::Invalid(
                        "Multiple payment IDs match the same service period",
                    ));
                }
            }
        }
    }
    let mut sorted: Vec<_> = unique.into_values().collect();
    sorted.sort_by_key(|(p, _)| (p.time, p.subsecond_nanos));
    Ok(sorted.into_iter().map(|(_, v)| v).collect())
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Delegation {
    pub id: String,
    pub agent: String,
    pub services: Vec<String>,
    pub task_limit: u32,
    pub period_limit: u32,
    pub expires_at: u64,
    pub revoked: bool,
}
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, Error> {
    serde_json::from_value(v).map_err(|_| Error::Invalid("Invalid stored subscription record"))
}
fn money(v: &Value) -> Option<super::money::Cents> {
    let raw = v.as_str()?;
    let normalized = match raw.split_once('.') {
        None => format!("{raw}.00"),
        Some((w, f)) if f.len() == 1 => format!("{w}.{f}0"),
        _ => raw.into(),
    };
    super::money::Cents::parse(&normalized).ok()
}
fn epoch(v: &Value) -> Option<i64> {
    DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|d| d.timestamp())
}
fn stamp(t: i64) -> Result<String, Error> {
    Ok(DateTime::<Utc>::from_timestamp(t, 0)
        .ok_or(Error::Invalid("Invalid schedule"))?
        .to_rfc3339())
}
fn month(anchor: i64, n: u32) -> Option<i64> {
    DateTime::<Utc>::from_timestamp(anchor, 0)?
        .checked_add_months(Months::new(n))
        .map(|d| d.timestamp())
}
pub fn validate_plan(v: &Value, plan: &str) -> Result<(), Error> {
    let cycles = v["billing_cycles"]
        .as_array()
        .ok_or(Error::Invalid("Plan billing cycles missing"))?;
    let c = cycles
        .first()
        .ok_or(Error::Invalid("Plan billing cycles missing"))?;
    if v["id"] != plan
        || v["status"] != "ACTIVE"
        || v["quantity_supported"].as_bool().unwrap_or(false)
        || cycles.len() != 1
        || c["tenure_type"] != "REGULAR"
        || c["sequence"] != 1
        || c["total_cycles"] != 0
        || c["frequency"]["interval_unit"] != "MONTH"
        || c["frequency"]["interval_count"] != 1
        || c["pricing_scheme"]["fixed_price"]["currency_code"] != "USD"
        || money(&c["pricing_scheme"]["fixed_price"]["value"]) != Some(super::money::Cents(4000))
        || v["payment_preferences"]["auto_bill_outstanding"] != false
        || v["payment_preferences"].get("setup_fee").is_some_and(|v| {
            money(&v["value"]) != Some(super::money::Cents(0)) || v["currency_code"] != "USD"
        })
        || v.get("taxes").is_some_and(|v| !v.is_null())
    {
        return Err(Error::Invalid(
            "Provider plan does not match approved USD 40 monthly terms",
        ));
    }
    Ok(())
}
impl Subscription {
    fn observe(&mut self, v: Value) -> Result<(), Error> {
        if v["custom_id"] != self.id
            || v["plan_id"] != self.plan_id
            || v.get("plan").is_some_and(|x| !x.is_null())
            || v["plan_overridden"].as_bool() == Some(true)
            || v["quantity"].as_str().is_some_and(|q| q != "1")
        {
            self.payment_review = Some("Subscription terms differ from approved terms".into());
            return Ok(());
        }
        let id = v["id"]
            .as_str()
            .filter(|x| !x.is_empty())
            .ok_or(Error::Invalid("Provider subscription ID missing"))?;
        if self.provider_id.as_deref().is_some_and(|old| old != id) {
            return Err(Error::Conflict);
        }
        self.provider_id = Some(id.into());
        self.status = v["status"].as_str().unwrap_or("UNKNOWN").into();
        if self.status == "CANCELLED" {
            if let Some(c) = &mut self.cancel {
                c.observe(json!({"status":"CANCELLED"}));
            }
        }
        if let Some(links) = v["links"].as_array() {
            for l in links {
                if l["rel"] == "approve" {
                    let raw = l["href"]
                        .as_str()
                        .ok_or(Error::Invalid("Invalid approval link"))?;
                    let u = url::Url::parse(raw)
                        .map_err(|_| Error::Invalid("Invalid approval link"))?;
                    if u.scheme() != "https"
                        || u.host_str() != Some("www.sandbox.paypal.com")
                        || u.port().is_some()
                        || !u.username().is_empty()
                        || u.password().is_some()
                    {
                        return Err(Error::Invalid("Unexpected approval origin"));
                    }
                    self.approval_url = Some(raw.into());
                }
            }
        }
        if let (Some(start), Some(next)) = (
            epoch(&v["start_time"]),
            epoch(&v["billing_info"]["next_billing_time"]),
        ) {
            let anchor = self.anchor.unwrap_or(start);
            if anchor != start
                || !(1..=1200).any(|n| month(anchor, n) == Some(next))
                || self.observed_next.is_some_and(|old| next < old)
            {
                self.payment_review =
                    Some("Contradictory subscription schedule; merchant review required".into());
            } else {
                self.anchor = Some(anchor);
                self.observed_next = Some(next);
            }
        }
        self.create.observe(v);
        Ok(())
    }
}
impl Store {
    pub async fn subscription(&self, id: &str, p: &Principal) -> Result<Subscription, Error> {
        let v:Option<Value>=sqlx::query_scalar("SELECT record FROM paypal_subscriptions WHERE id=$1 AND workspace=$2 AND (buyer=$3 OR $4 OR EXISTS(SELECT 1 FROM paypal_delegations d WHERE d.subscription_id=paypal_subscriptions.id AND d.record->>'agent'=$3 AND $5))")
    .bind(id).bind(&p.workspace).bind(&p.id).bind(p.role==Role::Merchant).bind(p.role==Role::Agent).fetch_optional(self.pool()).await?;
        decode(v.ok_or(Error::NotFound)?)
    }
    async fn observe_subscription(
        &self,
        id: &str,
        p: &Principal,
        v: Value,
    ) -> Result<Subscription, Error> {
        self.subscription(id, p).await?;
        let mut tx = self.pool().begin().await?;
        let record: Value =
            sqlx::query_scalar("SELECT record FROM paypal_subscriptions WHERE id=$1 FOR UPDATE")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        let mut s: Subscription = decode(record)?;
        s.observe(v)?;
        // Persist schedule evidence and candidate periods in the same transaction before grants.
        if let (Some(anchor), Some(next)) = (s.anchor, s.observed_next) {
            for n in 0..1200 {
                let start = month(anchor, n).ok_or(Error::Invalid("Invalid calendar period"))?;
                if start >= next {
                    break;
                }
                let end = month(anchor, n + 1).ok_or(Error::Invalid("Invalid calendar period"))?;
                sqlx::query("INSERT INTO paypal_subscription_periods(subscription_id,start_at,end_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(id).bind(start).bind(end).execute(&mut *tx).await?;
            }
        }
        if s.payment_review.is_some() {
            sqlx::query(
                "UPDATE paypal_subscription_periods SET blocked=TRUE WHERE subscription_id=$1",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query("UPDATE paypal_subscriptions SET record=$1 WHERE id=$2")
            .bind(json!(s))
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(s)
    }
    async fn grant_payments(&self, s: &Subscription, history: Value) -> Result<(), Error> {
        let payments = history["transactions"]
            .as_array()
            .ok_or(Error::Invalid("Subscription transactions missing"))?;
        let mut tx = self.pool().begin().await?;
        let record: Value =
            sqlx::query_scalar("SELECT record FROM paypal_subscriptions WHERE id=$1 FOR UPDATE")
                .bind(&s.id)
                .fetch_one(&mut *tx)
                .await?;
        let mut current: Subscription = decode(record)?;
        let original_proofs = current.payment_proofs.clone();
        let canonical = canonical_payments(&current, payments);
        if !complete_history(&history) || canonical.is_err() {
            current.payment_review = Some(
                "Incomplete or contradictory payment history; merchant review required".into(),
            );
        }
        let payments = canonical.unwrap_or_default();
        sqlx::query("SAVEPOINT allowance_grants")
            .execute(&mut *tx)
            .await?;
        if current.payment_review.is_none() {
            for payment in &payments {
                let Some(id) = payment["id"].as_str().filter(|id| !id.is_empty()) else {
                    current.payment_review = Some("Payment reference missing".into());
                    break;
                };
                if matches!(
                    payment["status"].as_str(),
                    Some("REFUNDED" | "PARTIALLY_REFUNDED" | "REVERSED")
                ) {
                    current.payment_review=Some("Subscription payment refunded or reversed; merchant billing review required".into());
                    break;
                }
                if payment["status"] != "COMPLETED" {
                    continue;
                }
                let existing: Option<String> = sqlx::query_scalar(
                    "SELECT subscription_id FROM paypal_subscription_periods WHERE payment_id=$1",
                )
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
                if let Some(existing) = existing {
                    if existing != s.id
                        || current.payment_proofs.get(id) != Some(&payment_proof(payment)?)
                    {
                        current.payment_review = Some("Payment reference conflicts".into());
                    }
                    continue;
                }
                let amount = &payment["amount_with_breakdown"]["gross_amount"];
                let time = epoch(&payment["time"]);
                if amount["currency_code"] != "USD"
                    || money(&amount["value"]) != Some(super::money::Cents(4000))
                    || time.is_none()
                    || current.anchor.is_none()
                {
                    current.payment_review =
                        Some("Payment amount or schedule evidence requires merchant review".into());
                    break;
                }
                // Strict boundary policy: no catch-up/late-payment inference from processing timestamps.
                // The one-hour boundary tolerance is explicit local service policy, never historical coverage proof.
                let candidates=sqlx::query("SELECT start_at,end_at FROM paypal_subscription_periods WHERE subscription_id=$1 AND payment_id IS NULL AND start_at<=$2 ORDER BY start_at FOR UPDATE")
      .bind(&s.id).bind(time.unwrap()).fetch_all(&mut *tx).await?;
                if candidates.len() != 1 {
                    current.payment_review=Some("Payment has no unique recorded on-time service period; merchant review required".into());
                    break;
                }
                let start: i64 = candidates[0].get("start_at");
                let end: i64 = candidates[0].get("end_at");
                if time.unwrap() > start + 3600 {
                    current.payment_review = Some(
                        "Late payment does not establish a unique on-time service period".into(),
                    );
                    break;
                }
                let count = payments
                    .iter()
                    .filter(|p| {
                        p["status"] == "COMPLETED"
                            && epoch(&p["time"]).is_some_and(|t| t >= start && t <= start + 3600)
                    })
                    .count();
                if count != 1 {
                    current.payment_review =
                        Some("Multiple payments match a service period".into());
                    break;
                }
                sqlx::query("UPDATE paypal_subscription_periods SET payment_id=$1,remaining=10 WHERE subscription_id=$2 AND start_at=$3").bind(id).bind(&s.id).bind(start).execute(&mut *tx).await?;
                current
                    .payment_proofs
                    .insert(id.into(), payment_proof(payment)?);
                ledger(
                    &mut tx,
                    &format!("grant:{id}"),
                    &s.id,
                    start,
                    None,
                    None,
                    "grant",
                    10,
                )
                .await?;
                if end <= domain::now() as i64 {
                    ledger(
                        &mut tx,
                        &format!("expiry:{}:{start}", s.id),
                        &s.id,
                        start,
                        None,
                        None,
                        "expiry",
                        10,
                    )
                    .await?;
                    sqlx::query("UPDATE paypal_subscription_periods SET remaining=0 WHERE subscription_id=$1 AND start_at=$2").bind(&s.id).bind(start).execute(&mut *tx).await?;
                }
            }
        }
        if current.payment_review.is_some() {
            sqlx::query("ROLLBACK TO SAVEPOINT allowance_grants")
                .execute(&mut *tx)
                .await?;
            current.payment_proofs = original_proofs;
            sqlx::query(
                "UPDATE paypal_subscription_periods SET blocked=TRUE WHERE subscription_id=$1",
            )
            .bind(&s.id)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query("UPDATE paypal_subscriptions SET record=$1 WHERE id=$2")
            .bind(json!(current))
            .bind(&s.id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn allocate(
        &self,
        id: &str,
        p: &Principal,
        sid: &str,
        digest: &str,
        delegation: Option<&str>,
    ) -> Result<Task, Error> {
        if !matches!(p.role, Role::Buyer | Role::Agent) {
            return Err(Error::Forbidden);
        }
        let s = self.subscription(sid, p).await?;
        if (p.role == Role::Buyer && s.buyer != p.id)
            || (p.role == Role::Agent && delegation.is_none())
        {
            return Err(Error::Forbidden);
        }
        let mut tx = self.pool().begin().await?;
        // Global lock order: task -> period -> delegation. Checkout shares this task lock.
        let value:Option<Value>=sqlx::query_scalar("SELECT record FROM paypal_tasks WHERE id=$1 AND workspace=$2 AND principal=$3 FOR UPDATE").bind(id).bind(&p.workspace).bind(&p.id).fetch_optional(&mut *tx).await?;
        let mut t: Task = decode(value.ok_or(Error::NotFound)?)?;
        if t.quote_digest != digest {
            return Err(Error::Conflict);
        }
        if let Some(f) = &t.subscription_funding {
            if f.subscription_id == sid && f.delegation_id.as_deref() == delegation {
                return Ok(t);
            }
            return Err(Error::Conflict);
        }
        if t.order.is_some()
            || t.captured
            || t.capture.is_some()
            || domain::now() > t.quote_expires_at
        {
            return Err(Error::Conflict);
        }
        if !super::services::preflight(&t.offer_version, &t.documents, t.requirements.as_deref())?
            .ready
        {
            return Err(Error::Invalid(
                "Input preflight failed; no allowance allocated",
            ));
        }
        let period=sqlx::query("SELECT start_at,end_at,payment_id,remaining,blocked FROM paypal_subscription_periods WHERE subscription_id=$1 AND start_at<=$2 AND end_at>$2 AND payment_id IS NOT NULL ORDER BY start_at DESC LIMIT 1 FOR UPDATE").bind(sid).bind(domain::now() as i64).fetch_optional(&mut *tx).await?.ok_or(Error::Invalid("No verified paid allowance for the current service period"))?;
        let start: i64 = period.get("start_at");
        let units = t.allowance_units()?;
        // Re-read after period lock so a completed reversal transaction cannot be bypassed.
        let current: Subscription = decode(
            sqlx::query_scalar("SELECT record FROM paypal_subscriptions WHERE id=$1")
                .bind(sid)
                .fetch_one(&mut *tx)
                .await?,
        )?;
        if period.get::<bool, _>("blocked")
            || current.payment_review.is_some()
            || period.get::<i32, _>("remaining") < (units as i32)
        {
            return Err(Error::Invalid("Allowance unavailable; no automatic charge"));
        }
        if let Some(did) = delegation {
            let v:Option<Value>=sqlx::query_scalar("SELECT record FROM paypal_delegations WHERE id=$1 AND subscription_id=$2 FOR UPDATE").bind(did).bind(sid).fetch_optional(&mut *tx).await?;
            let d: Delegation = decode(v.ok_or(Error::Forbidden)?)?;
            let spent:i64=sqlx::query_scalar("SELECT COALESCE(SUM(units),0)::BIGINT FROM paypal_allowance_ledger WHERE delegation_id=$1 AND period_start=$2 AND kind='reserve'").bind(did).bind(start).fetch_one(&mut *tx).await?;
            if p.role != Role::Agent
                || d.agent != p.id
                || d.revoked
                || d.expires_at <= domain::now()
                || !d.services.contains(&t.offer_version)
                || units > d.task_limit
                || spent + units as i64 > d.period_limit as i64
            {
                return Err(Error::Forbidden);
            }
        } else if p.role != Role::Buyer {
            return Err(Error::Forbidden);
        }
        sqlx::query("UPDATE paypal_subscription_periods SET remaining=remaining-$1 WHERE subscription_id=$2 AND start_at=$3").bind(units as i32).bind(sid).bind(start).execute(&mut *tx).await?;
        ledger(
            &mut tx,
            &format!("reserve:{id}"),
            sid,
            start,
            Some(id),
            delegation,
            "reserve",
            units as i32,
        )
        .await?;
        t.subscription_funding = Some(Funding {
            subscription_id: sid.into(),
            buyer: s.buyer,
            period_start: start,
            period_end: period.get("end_at"),
            payment_id: period.get("payment_id"),
            units,
            delegation_id: delegation.map(str::to_string),
        });
        t.approved_at = Some(domain::now());
        sqlx::query("UPDATE paypal_tasks SET record=$1 WHERE id=$2")
            .bind(json!(t))
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(t)
    }
    /// Called inside the task transaction: atomic outcome accounting and restoration.
    pub(crate) async fn account_allowance(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        t: &mut Task,
    ) -> Result<(), Error> {
        let Some(f) = t.subscription_funding.clone() else {
            return Ok(());
        };
        let period=sqlx::query("SELECT blocked,end_at FROM paypal_subscription_periods WHERE subscription_id=$1 AND start_at=$2 FOR UPDATE").bind(&f.subscription_id).bind(f.period_start).fetch_one(&mut **tx).await?;
        if period.get::<bool, _>("blocked") {
            t.payment_review = Some("Subscription funding requires merchant billing review".into());
        }
        let per = super::services::get(&t.offer_version)?.allowance_units_per_output as i32;
        for (i, u) in t.units.iter().enumerate() {
            let kind = match u.state {
                UnitState::Failed => "restore",
                UnitState::Delivered => "consume",
                _ => continue,
            };
            let added = ledger(
                tx,
                &format!("outcome:{}:{i}", t.id),
                &f.subscription_id,
                f.period_start,
                Some(&t.id),
                f.delegation_id.as_deref(),
                kind,
                per,
            )
            .await?;
            if added && kind == "restore" {
                // Restore failed service units once, but NEVER reset delegation lifetime reservations.
                if period.get::<i64, _>("end_at") > domain::now() as i64 {
                    sqlx::query("UPDATE paypal_subscription_periods SET remaining=remaining+$1 WHERE subscription_id=$2 AND start_at=$3").bind(per).bind(&f.subscription_id).bind(f.period_start).execute(&mut **tx).await?;
                } else {
                    ledger(
                        tx,
                        &format!("expiry:restore:{}:{i}", t.id),
                        &f.subscription_id,
                        f.period_start,
                        Some(&t.id),
                        f.delegation_id.as_deref(),
                        "expiry",
                        per,
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }
    pub async fn subscription_view(&self, id: &str, p: &Principal) -> Result<Value, Error> {
        let s = self.subscription(id, p).await?;
        let mut tx = self.pool().begin().await?;
        let expired=sqlx::query("SELECT start_at,remaining FROM paypal_subscription_periods WHERE subscription_id=$1 AND end_at<=$2 AND remaining>0 FOR UPDATE").bind(id).bind(domain::now() as i64).fetch_all(&mut *tx).await?;
        for row in expired {
            let start: i64 = row.get("start_at");
            let remaining: i32 = row.get("remaining");
            ledger(
                &mut tx,
                &format!("expiry:{id}:{start}"),
                id,
                start,
                None,
                None,
                "expiry",
                remaining,
            )
            .await?;
            sqlx::query("UPDATE paypal_subscription_periods SET remaining=0 WHERE subscription_id=$1 AND start_at=$2").bind(id).bind(start).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        let periods=sqlx::query("SELECT start_at,end_at,payment_id,remaining,blocked FROM paypal_subscription_periods WHERE subscription_id=$1 ORDER BY start_at DESC").bind(id).fetch_all(self.pool()).await?;
        let mut ds:Vec<Value>=sqlx::query_scalar("SELECT record FROM paypal_delegations WHERE subscription_id=$1 AND ($2 OR record->>'agent'=$3)").bind(id).bind(p.role!=Role::Agent).bind(&p.id).fetch_all(self.pool()).await?;
        let active = periods.iter().find(|r| {
            r.get::<i64, _>("start_at") <= domain::now() as i64
                && r.get::<i64, _>("end_at") > domain::now() as i64
        });
        for d in &mut ds {
            let used: i64 = if let Some(period) = active {
                sqlx::query_scalar("SELECT COALESCE(SUM(units),0)::BIGINT FROM paypal_allowance_ledger WHERE delegation_id=$1 AND period_start=$2 AND kind='reserve'").bind(d["id"].as_str().unwrap_or("")).bind(period.get::<i64,_>("start_at")).fetch_one(self.pool()).await?
            } else {
                0
            };
            let remaining = d["period_limit"]
                .as_u64()
                .unwrap_or(0)
                .saturating_sub(used as u64);
            let available = active
                .filter(|r| !r.get::<bool, _>("blocked"))
                .map(|r| r.get::<i32, _>("remaining") as u64)
                .unwrap_or(0);
            d["period_start"] = json!(active.map(|r| r.get::<i64, _>("start_at")));
            d["lifetime_reserved_units"] = json!(used);
            d["remaining_period_capacity"] = json!(remaining);
            d["available_units"] = json!(if d["revoked"] == true
                || d["expires_at"].as_u64().unwrap_or(0) <= domain::now()
            {
                0
            } else {
                remaining.min(available)
            });
        }
        let projection = json!({"id":s.id,"status":s.status,"terms":s.terms,"plan_id":s.plan_id,"payment_review":s.payment_review,
   "create":{"state":s.create.state},"cancel":s.cancel.as_ref().map(|c|json!({"state":c.state})),
   "approval_url":if p.role==Role::Buyer && s.buyer==p.id {s.approval_url.clone()}else{None}});
        Ok(
            json!({"subscription":projection,"periods":periods.iter().map(|r|json!({"start_at":r.get::<i64,_>("start_at"),"end_at":r.get::<i64,_>("end_at"),"payment_id":r.get::<Option<String>,_>("payment_id"),"available":if r.get::<bool,_>("blocked") || r.get::<i64,_>("end_at")<=domain::now() as i64 {0}else{r.get::<i32,_>("remaining")},"blocked":r.get::<bool,_>("blocked")})).collect::<Vec<_>>(),"delegations":ds}),
        )
    }
}
async fn ledger(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    key: &str,
    sid: &str,
    start: i64,
    task: Option<&str>,
    delegation: Option<&str>,
    kind: &str,
    units: i32,
) -> Result<bool, Error> {
    Ok(sqlx::query("INSERT INTO paypal_allowance_ledger(entry_key,subscription_id,period_start,task_id,delegation_id,kind,units,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING").bind(key).bind(sid).bind(start).bind(task).bind(delegation).bind(kind).bind(units).bind(domain::now() as i64).execute(&mut **tx).await?.rows_affected()==1)
}
impl App {
    fn subscription_purchases(&self) -> Result<&str, Error> {
        self.purchases()?;
        if !self.config.subscriptions {
            return Err(Error::Invalid(
                "New subscriptions and allocations are paused",
            ));
        }
        self.config
            .subscription_plan
            .as_deref()
            .ok_or(Error::Invalid(
                "Sandbox subscription plan is not configured",
            ))
    }
    pub async fn reconcile_subscription(&self, id: &str, p: &Principal) -> Result<Value, Error> {
        let s = self.store.subscription(id, p).await?;
        let provider = s.provider_id.as_deref().ok_or(Error::Invalid(
            "Create result unknown; preserve this subscription for verified webhook recovery",
        ))?;
        let plan = self
            .provider
            .subscription_plan(&s.plan_id)
            .await
            .map_err(|_| Error::Invalid("Plan observation unavailable"))?;
        if validate_plan(&plan, &s.plan_id).is_err() {
            self.block_subscription(id, "Provider plan terms changed; merchant review required")
                .await?;
            return self.store.subscription_view(id, p).await;
        }
        let v = self.provider.subscription(provider).await.map_err(|_| {
            Error::Invalid("Subscription observation unavailable; keep original operation")
        })?;
        let s = self.store.observe_subscription(id, p, v).await?;
        // No grant is visible until every bounded window has been read and compared.
        let start = s.created_at.saturating_sub(60) as i64;
        let now = domain::now() as i64;
        if now.saturating_sub(start) > HISTORY_WINDOWS as i64 * 30 * 86400 {
            self.block_subscription(id, "History traversal cutoff; merchant review required")
                .await?;
            return Err(Error::Invalid(
                "History traversal cutoff; no new allowance granted",
            ));
        }
        let mut cursor = start;
        let mut all = Vec::new();
        while cursor < now {
            let end = (cursor + 30 * 86400).min(now);
            let history = self
                .provider
                .subscription_transactions(provider, &stamp(cursor)?, &stamp(end)?)
                .await
                .map_err(|_| {
                    Error::Invalid("Payment observation unavailable; no new allowance granted")
                })?;
            let window = history["transactions"].as_array();
            if !complete_history(&history) || window.is_none() {
                self.block_subscription(
                    id,
                    "Incomplete transaction history; merchant review required",
                )
                .await?;
                return Err(Error::Invalid(
                    "Incomplete transaction history; no new allowance granted",
                ));
            }
            all.extend(window.unwrap().iter().cloned());
            // Check each observed prefix for contrary evidence, without granting from it.
            if all.len() > HISTORY_RECORDS || canonical_payments(&s, &all).is_err() {
                self.block_subscription(
                    id,
                    "Contradictory or oversized payment history; merchant review required",
                )
                .await?;
                return Err(Error::Invalid("Contradictory or oversized payment history"));
            }
            cursor = end;
        }
        self.store
            .grant_payments(
                &s,
                json!({"total_items":all.len(),"total_pages":1,"transactions":all}),
            )
            .await?;
        self.store.subscription_view(id, p).await
    }
    async fn block_subscription(&self, id: &str, reason: &str) -> Result<(), Error> {
        let mut tx = self.store.pool().begin().await?;
        sqlx::query("UPDATE paypal_subscriptions SET record=jsonb_set(record,'{payment_review}',to_jsonb($1::text)) WHERE id=$2").bind(reason).bind(id).execute(&mut *tx).await?;
        sqlx::query("UPDATE paypal_subscription_periods SET blocked=TRUE WHERE subscription_id=$1")
            .bind(id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        sqlx::query("UPDATE paypal_tasks SET record=jsonb_set(record,'{payment_review}',to_jsonb($1::text)) WHERE record->'subscription_funding'->>'subscription_id'=$2").bind(reason).bind(id).execute(self.store.pool()).await?;
        Ok(())
    }
    /// Verified inbox only; arbitrary caller-supplied provider IDs are never adopted.
    pub(crate) async fn subscription_event(&self, event: &Value) -> Result<bool, Error> {
        let typ = event["event_type"].as_str().unwrap_or("");
        if !typ.starts_with("BILLING.SUBSCRIPTION.") && !typ.starts_with("PAYMENT.SALE.") {
            return Ok(false);
        }
        let r = &event["resource"];
        let ids: Vec<String> = [
            r["id"].as_str(),
            r["billing_agreement_id"].as_str(),
            r["sale_id"].as_str(),
            r["custom_id"].as_str(),
        ]
        .into_iter()
        .flatten()
        .map(str::to_string)
        .collect();
        let rows:Vec<Value>=sqlx::query_scalar("SELECT record FROM paypal_subscriptions WHERE id=ANY($1) OR record->>'provider_id'=ANY($1) OR id IN(SELECT subscription_id FROM paypal_subscription_periods WHERE payment_id=ANY($1))").bind(&ids).fetch_all(self.store.pool()).await?;
        if rows.is_empty() {
            return Ok(false);
        }
        for record in rows {
            let s: Subscription = decode(record)?;
            let p = Principal {
                id: s.buyer.clone(),
                workspace: s.workspace.clone(),
                role: Role::Buyer,
            };
            if typ == "PAYMENT.SALE.REFUNDED" || typ == "PAYMENT.SALE.REVERSED" {
                self.block_subscription(
                    &s.id,
                    "Verified payment reversal/refund; merchant billing review required",
                )
                .await?;
            }
            if s.provider_id.is_none() && typ.starts_with("BILLING.SUBSCRIPTION.") {
                let pid = r["id"]
                    .as_str()
                    .ok_or(Error::Invalid("Subscription event ID missing"))?;
                let observed = self
                    .provider
                    .subscription(pid)
                    .await
                    .map_err(|_| Error::Invalid("Webhook subscription read unavailable"))?;
                self.store.observe_subscription(&s.id, &p, observed).await?;
            }
            self.reconcile_subscription(&s.id, &p).await?;
        }
        Ok(true)
    }
}
pub fn router() -> Router<App> {
    Router::new()
        .route("/v1/paypal/subscriptions", get(list).post(create))
        .route("/v1/paypal/subscriptions/terms", get(terms))
        .route("/v1/paypal/subscriptions/{id}", get(read))
        .route("/v1/paypal/subscriptions/{id}/reconcile", post(reconcile))
        .route("/v1/paypal/subscriptions/{id}/cancel", post(cancel))
        .route("/v1/paypal/subscriptions/{id}/delegations", post(delegate))
        .route(
            "/v1/paypal/subscriptions/{id}/delegations/{delegation}",
            axum::routing::delete(revoke),
        )
        .route("/v1/paypal/tasks/{id}/allowance", post(allocate))
}
async fn terms(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    app.principal(&headers).await?;
    Ok(Json(
        json!({"terms":TERMS,"plan_id":app.config.subscription_plan,"price":"40.00","currency":"USD","units":10,"enabled":app.config.subscriptions && app.config.new_purchases,"policy":"ChainPay service periods follow the observed subscription start and calendar-month schedule. Only one exact completed USD40 payment uniquely matching a recorded period within one hour of its start grants ten units. Missing, late, catch-up or ambiguous payments require merchant review. No rollover or overage. Compare uses two units; summary/check one per output. Cancellation stops renewal; allocated work can complete after expiry. Refund/reversal/review blocks work. Failed outputs restore quota once, never cash; delegation lifetime reservations are not reset."}),
    ))
}
async fn list(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let ids:Vec<String>=sqlx::query_scalar("SELECT id FROM paypal_subscriptions WHERE workspace=$1 AND (buyer=$2 OR $3 OR ($4 AND EXISTS(SELECT 1 FROM paypal_delegations d WHERE d.subscription_id=paypal_subscriptions.id AND d.record->>'agent'=$2))) ORDER BY id LIMIT 100").bind(&p.workspace).bind(&p.id).bind(p.role==Role::Merchant).bind(p.role==Role::Agent).fetch_all(app.store.pool()).await?;
    let mut views = Vec::new();
    for id in ids {
        views.push(app.store.subscription_view(&id, &p).await?);
    }
    Ok(Json(json!({"subscriptions":views})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    request_id: String,
    terms: String,
    plan_id: String,
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
    let plan = app.subscription_purchases()?;
    if body.terms != TERMS
        || body.plan_id != plan
        || body.request_id.len() < 16
        || body.request_id.len() > 64
    {
        return Err(Error::Conflict);
    }
    let old: Option<String> = sqlx::query_scalar(
        "SELECT id FROM paypal_subscriptions WHERE workspace=$1 AND buyer=$2 AND request_id=$3",
    )
    .bind(&p.workspace)
    .bind(&p.id)
    .bind(&body.request_id)
    .fetch_optional(app.store.pool())
    .await?;
    if let Some(id) = old {
        let s = app.store.subscription(&id, &p).await?;
        if s.plan_id != body.plan_id {
            return Err(Error::Conflict);
        }
        return Ok(Json(app.store.subscription_view(&id, &p).await?));
    }
    let v = app
        .provider
        .subscription_plan(plan)
        .await
        .map_err(|_| Error::Invalid("Cannot verify subscription plan"))?;
    validate_plan(&v, plan)?;
    let s = Subscription {
        id: domain::random_id()?,
        workspace: p.workspace.clone(),
        buyer: p.id.clone(),
        plan_id: plan.into(),
        terms: TERMS.into(),
        created_at: domain::now(),
        create: Operation::begin()?,
        cancel: None,
        provider_id: None,
        approval_url: None,
        status: "CREATE_PENDING".into(),
        payment_review: None,
        anchor: None,
        observed_next: None,
        payment_proofs: Default::default(),
    };
    let inserted=sqlx::query("INSERT INTO paypal_subscriptions(id,workspace,buyer,request_id,record) VALUES($1,$2,$3,$4,$5) ON CONFLICT(workspace,buyer,request_id) DO NOTHING").bind(&s.id).bind(&p.workspace).bind(&p.id).bind(&body.request_id).bind(json!(s)).execute(app.store.pool()).await?.rows_affected()==1;
    let id: String = sqlx::query_scalar(
        "SELECT id FROM paypal_subscriptions WHERE workspace=$1 AND buyer=$2 AND request_id=$3",
    )
    .bind(&p.workspace)
    .bind(&p.id)
    .bind(&body.request_id)
    .fetch_one(app.store.pool())
    .await?;
    if inserted {
        match app
            .provider
            .create_subscription(&id, plan, &s.create.key)
            .await
        {
            Ok(v) => {
                app.store.observe_subscription(&id, &p, v).await?;
            }
            Err(_) => {
                sqlx::query("UPDATE paypal_subscriptions SET record=jsonb_set(record,'{create,state}','\"unknown\"') WHERE id=$1 AND record->'create'->>'state'='dispatching'").bind(&id).execute(app.store.pool()).await?;
            }
        }
    }
    Ok(Json(app.store.subscription_view(&id, &p).await?))
}
async fn read(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(app.store.subscription_view(&id, &p).await?))
}
async fn reconcile(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(app.reconcile_subscription(&id, &p).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancel {
    terms: String,
    reason: String,
}
async fn cancel(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Cancel>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let s = app.store.subscription(&id, &p).await?;
    if p.role != Role::Buyer || s.buyer != p.id {
        return Err(Error::Forbidden);
    }
    if body.terms != format!("cancel:{id}:stop-renewal-keep-paid-access")
        || body.reason.is_empty()
        || body.reason.chars().count() > 128
    {
        return Err(Error::Conflict);
    }
    let pid = s
        .provider_id
        .ok_or(Error::Invalid("Provider subscription unresolved"))?;
    let mut op = Operation::begin()?;
    op.observation = Some(json!({"reason":body.reason,"terms":body.terms}));
    let won=sqlx::query("UPDATE paypal_subscriptions SET record=jsonb_set(record,'{cancel}',$1) WHERE id=$2 AND record->'cancel'='null'::jsonb").bind(json!(op)).bind(&id).execute(app.store.pool()).await?.rows_affected()==1;
    if won {
        let result = app
            .provider
            .cancel_subscription(&pid, &body.reason, &op.key)
            .await;
        let state = if result.is_ok() {
            "observed"
        } else {
            "unknown"
        };
        sqlx::query("UPDATE paypal_subscriptions SET record=jsonb_set(record,'{cancel,state}',to_jsonb($1::text)) WHERE id=$2").bind(state).bind(&id).execute(app.store.pool()).await?;
    }
    Ok(Json(app.store.subscription_view(&id, &p).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Delegate {
    request_id: String,
    agent: String,
    services: Vec<String>,
    task_limit: u32,
    period_limit: u32,
    expires_at: u64,
    approve: bool,
}
async fn delegate(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Delegate>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    app.subscription_purchases()?;
    let s = app.store.subscription(&id, &p).await?;
    if p.role != Role::Buyer || s.buyer != p.id {
        return Err(Error::Forbidden);
    }
    if body.request_id.len() < 16
        || body.request_id.len() > 64
        || !body
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        || !body.approve
        || body.agent.is_empty()
        || body.agent.len() > 80
        || body.agent == p.id
        || body.services.is_empty()
        || body
            .services
            .iter()
            .any(|s| super::services::get(s).is_err())
        || body.task_limit == 0
        || body.task_limit > body.period_limit
        || body.period_limit > 10
        || body.expires_at <= domain::now()
        || body.expires_at > domain::now() + 366 * 86400
    {
        return Err(Error::Invalid(
            "Approve exact agent, services, task/cycle ceilings and expiry",
        ));
    }
    let did =
        domain::hash(&serde_json::to_vec(&(&p.workspace, &p.id, &id, &body.request_id)).unwrap())
            [..32]
            .to_string();
    let d = Delegation {
        id: did,
        agent: body.agent,
        services: body.services,
        task_limit: body.task_limit,
        period_limit: body.period_limit,
        expires_at: body.expires_at,
        revoked: false,
    };
    let mut intent = json!(d);
    intent["revoked"] = json!(false);
    let fingerprint = domain::hash(&serde_json::to_vec(&intent).unwrap());
    let mut record = intent;
    record["approval_fingerprint"] = json!(fingerprint);
    sqlx::query("INSERT INTO paypal_delegations(id,subscription_id,record) VALUES($1,$2,$3) ON CONFLICT DO NOTHING").bind(&d.id).bind(&id).bind(record).execute(app.store.pool()).await?;
    let original: Value = sqlx::query_scalar(
        "SELECT record FROM paypal_delegations WHERE id=$1 AND subscription_id=$2",
    )
    .bind(&d.id)
    .bind(&id)
    .fetch_one(app.store.pool())
    .await?;
    if original["approval_fingerprint"] != fingerprint {
        return Err(Error::Conflict);
    }
    Ok(Json(json!(decode::<Delegation>(original)?)))
}
async fn revoke(
    State(app): State<App>,
    headers: HeaderMap,
    Path((id, did)): Path<(String, String)>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let s = app.store.subscription(&id, &p).await?;
    if p.role != Role::Buyer || s.buyer != p.id {
        return Err(Error::Forbidden);
    }
    sqlx::query("UPDATE paypal_delegations SET record=jsonb_set(record,'{revoked}','true') WHERE id=$1 AND subscription_id=$2").bind(did).bind(&id).execute(app.store.pool()).await?;
    Ok(Json(
        json!({"revoked":true,"note":"Stops new allocations; already allocated work may complete"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Allocate {
    subscription_id: String,
    digest: String,
    delegation_id: Option<String>,
}
async fn allocate(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Allocate>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    app.subscription_purchases()?;
    let t = app
        .store
        .allocate(
            &id,
            &p,
            &body.subscription_id,
            &body.digest,
            body.delegation_id.as_deref(),
        )
        .await?;
    Ok(Json(super::observations::receipt(&t, false)))
}

#[cfg(test)]
mod tests;
