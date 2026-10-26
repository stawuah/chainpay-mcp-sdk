//! PayPal disputes against captured purchases, and the evidence pack a
//! merchant can submit once. Everything here is a provider observation; the
//! dispute outcome itself is decided by PayPal.
use super::{
    allowance::Allowance,
    domain::{self, Error, Operation, Principal, Role, Task, UnitState},
    money::Cents,
    observations,
    resolution::Action,
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

/// Small copy kept on the task so a receipt can show the dispute.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DisputeMark {
    pub id: String,
    pub status: String,
    pub evidence: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Dispute {
    pub id: String,
    pub workspace: String,
    pub task_id: String,
    pub capture_id: String,
    pub status: String,
    pub stage: String,
    pub reason: String,
    pub amount: Cents,
    pub created_at: u64,
    pub updated_at: u64,
    pub seller_response_due: Option<u64>,
    pub evidence: String,
    pub evidence_submitted_at: Option<u64>,
    pub evidence_digest: Option<String>,
    pub submit: Option<Operation>,
}
impl Dispute {
    fn view(&self) -> Value {
        json!({"id":self.id,"task_id":self.task_id,"capture_id":self.capture_id,"status":self.status,"stage":self.stage,"reason":self.reason,
            "amount_cents":self.amount,"amount":self.amount.decimal(),"currency":"USD","created_at":self.created_at,"updated_at":self.updated_at,
            "seller_response_due":self.seller_response_due,"evidence":self.evidence,"evidence_submitted_at":self.evidence_submitted_at,"evidence_digest":self.evidence_digest,"sandbox":true})
    }
    fn mark(&self) -> DisputeMark {
        DisputeMark {
            id: self.id.clone(),
            status: self.status.clone(),
            evidence: self.evidence.clone(),
        }
    }
}
fn epoch(v: &Value) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(v.as_str()?)
        .ok()
        .map(|d| d.timestamp().max(0) as u64)
}
fn decode(v: Value) -> Result<Dispute, Error> {
    serde_json::from_value(v).map_err(|_| Error::Invalid("Stored dispute is invalid"))
}
/// Reads the fields we keep from a PayPal dispute. The disputed transaction
/// must be this task's capture or the record is refused.
pub fn from_provider(task: &Task, value: &Value) -> Result<Dispute, Error> {
    let id = value["dispute_id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 64)
        .ok_or(Error::Invalid("Dispute ID missing"))?;
    let capture = task.capture_id.as_deref().ok_or(Error::Conflict)?;
    let transactions = value["disputed_transactions"]
        .as_array()
        .ok_or(Error::Conflict)?;
    if transactions.len() != 1 || transactions[0]["seller_transaction_id"] != capture {
        return Err(Error::Conflict);
    }
    let amount = &value["dispute_amount"];
    if amount["currency_code"] != "USD" {
        return Err(Error::Conflict);
    }
    let amount = Cents::parse(amount["value"].as_str().unwrap_or("")).map_err(Error::Invalid)?;
    Ok(Dispute {
        id: id.into(),
        workspace: task.workspace.clone(),
        task_id: task.id.clone(),
        capture_id: capture.into(),
        status: value["status"].as_str().unwrap_or("UNKNOWN").into(),
        stage: value["dispute_life_cycle_stage"]
            .as_str()
            .unwrap_or("UNKNOWN")
            .into(),
        reason: value["reason"].as_str().unwrap_or("UNKNOWN").into(),
        amount,
        created_at: epoch(&value["create_time"]).unwrap_or(0),
        updated_at: epoch(&value["update_time"]).unwrap_or(0),
        seller_response_due: epoch(&value["seller_response_due_date"]),
        evidence: "none".into(),
        evidence_submitted_at: None,
        evidence_digest: None,
        submit: None,
    })
}

/// Everything the merchant can show PayPal, built only from stored records.
pub fn evidence_pack(
    task: &Task,
    dispute: &Dispute,
    allowance: Option<&Allowance>,
    origin: &str,
) -> Value {
    let purchase = task.purchase.as_ref();
    let policy = purchase.map(|c| &c.policy);
    let approval = purchase.filter(|c| c.approval.is_some()).map(|c| {
        json!({"approval":c.approval,"approved_by":c.approved_by,"approval_requested_at":c.approval_requested_at,"approval_decided_at":c.approval_decided_at})
    });
    let delivery: Vec<Value> = task.units.iter().enumerate().map(|(i, u)| {
        json!({"unit":i,"state":u.state,"delivered_at":u.result.as_ref().and_then(|r| r["fulfilled_at"].as_u64())})
    }).collect();
    let events = |pick: fn(&Action) -> bool| -> Vec<Value> {
        task.resolution
            .iter()
            .filter(|e| pick(&e.intent.action))
            .map(|e| json!({"unit":e.intent.binding.unit,"action":e.intent.action,"reason":e.intent.reason,"at":e.timestamp}))
            .collect()
    };
    let mut refunds: Vec<Value> = task
        .refunds
        .iter()
        .map(|r| json!({"id":r.provider_id,"amount":r.amount.decimal(),"confirmed":r.confirmed}))
        .collect();
    if task.refund.is_some() || task.refund_confirmed {
        refunds.push(json!({"id":task.refund_id,"amount":task.refund_amount.decimal(),"confirmed":task.refund_confirmed}));
    }
    let delivered = task
        .units
        .iter()
        .filter(|u| u.state == UnitState::Delivered)
        .count();
    let failed = task
        .units
        .iter()
        .filter(|u| u.state == UnitState::Failed)
        .count();
    let mut notes = format!(
        "Purchase {} for {} USD was captured as {}. ",
        task.id,
        task.amount.decimal(),
        dispute.capture_id
    );
    if let Some(policy) = policy {
        notes.push_str(&format!(
            "The stored buyer allowance policy was {}{} . ",
            policy.rule,
            allowance
                .map(|a| format!(" for allowance \"{}\"", a.name))
                .unwrap_or_default()
        ));
    }
    if let Some(c) = purchase {
        match c.approval.as_deref() {
            Some(state) => notes.push_str(&format!(
                "The buyer reviewed this purchase in the ChainPay workspace and it was {state}. "
            )),
            None => notes.push_str(
                "The buyer pre-approved purchases of this kind without a per-purchase review. ",
            ),
        }
    }
    notes.push_str(&format!(
        "Of {} units, {} were marked delivered and {} failed by the merchant. ",
        task.units.len(),
        delivered,
        failed
    ));
    if refunds.is_empty() {
        notes.push_str("No refund has been issued.");
    } else {
        notes.push_str(&format!(
            "{} refund record(s) exist and are listed in this pack.",
            refunds.len()
        ));
    }
    let notes: String = notes.chars().take(2000).collect();
    let mut pack = json!({
        "dispute_id":dispute.id,"task_id":task.id,"capture_id":dispute.capture_id,
        "allowance":{"id":purchase.map(|c| c.allowance_id.as_str()),"name":allowance.map(|a| a.name.as_str()),"rule":policy.map(|p| p.rule.as_str()),"checks":policy.map(|p| &p.checks)},
        "approval":approval,
        "delivery":delivery,
        "buyer_review":events(|a| matches!(a, Action::Accept | Action::Challenge)),
        "rework":events(|a| *a == Action::Rework),
        "refunds":refunds,
        "receipt_digest":domain::hash(&serde_json::to_vec(&observations::receipt(task, true)).unwrap()),
        "public_receipt_url":task.share_token.as_ref().map(|t| format!("{origin}/paypal/receipt/{t}")),
        "notes":notes,
    });
    let digest = domain::hash(&serde_json::to_vec(&pack).unwrap());
    pack["digest"] = json!(digest);
    pack
}

impl Store {
    pub async fn disputes(&self, p: &Principal) -> Result<Vec<Dispute>, Error> {
        if p.role != Role::Merchant {
            return Err(Error::Forbidden);
        }
        let rows: Vec<Value> = sqlx::query_scalar("SELECT record FROM paypal_disputes WHERE workspace=$1 ORDER BY updated_at DESC,id LIMIT 100")
            .bind(&p.workspace).fetch_all(self.pool()).await?;
        rows.into_iter().map(decode).collect()
    }
    pub async fn dispute(&self, id: &str, p: &Principal) -> Result<Dispute, Error> {
        if p.role != Role::Merchant {
            return Err(Error::Forbidden);
        }
        let v: Option<Value> =
            sqlx::query_scalar("SELECT record FROM paypal_disputes WHERE id=$1 AND workspace=$2")
                .bind(id)
                .bind(&p.workspace)
                .fetch_optional(self.pool())
                .await?;
        decode(v.ok_or(Error::NotFound)?)
    }
    /// Keeps our evidence bookkeeping, takes PayPal's status fields.
    pub async fn upsert_dispute(&self, task: &Task, value: &Value) -> Result<Dispute, Error> {
        let fresh = from_provider(task, value)?;
        let mut tx = self.pool().begin().await?;
        // Serialize the initial insert too: SELECT FOR UPDATE cannot lock a missing row.
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 770025))")
            .bind(&fresh.id)
            .execute(&mut *tx)
            .await?;
        let old: Option<Value> =
            sqlx::query_scalar("SELECT record FROM paypal_disputes WHERE id=$1 FOR UPDATE")
                .bind(&fresh.id)
                .fetch_optional(&mut *tx)
                .await?;
        let d = match old {
            Some(old) => {
                let old = decode(old)?;
                if old.task_id != fresh.task_id || old.capture_id != fresh.capture_id {
                    return Err(Error::Conflict);
                }
                if fresh.updated_at < old.updated_at {
                    old
                } else {
                    Dispute {
                        status: fresh.status,
                        stage: fresh.stage,
                        reason: fresh.reason,
                        amount: fresh.amount,
                        updated_at: fresh.updated_at.max(old.updated_at),
                        seller_response_due: fresh.seller_response_due.or(old.seller_response_due),
                        ..old
                    }
                }
            }
            None => fresh,
        };
        sqlx::query("INSERT INTO paypal_disputes(id,workspace,task_id,capture_id,record,updated_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET record=EXCLUDED.record,updated_at=EXCLUDED.updated_at")
            .bind(&d.id).bind(&d.workspace).bind(&d.task_id).bind(&d.capture_id).bind(json!(d)).bind(d.updated_at as i64).execute(&mut *tx).await?;
        sqlx::query("UPDATE paypal_tasks SET record=jsonb_set(record,'{dispute}',$1) WHERE id=$2 AND workspace=$3")
            .bind(json!(d.mark())).bind(&d.task_id).bind(&d.workspace).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(d)
    }
    /// Bind the merchant-approved digest to the task and dispute while both are
    /// locked, so concurrent fulfilment/refunds cannot silently change the pack.
    async fn claim_evidence(
        &self,
        id: &str,
        p: &Principal,
        digest: &str,
        origin: &str,
    ) -> Result<(Dispute, Value, Option<String>), Error> {
        if p.role != Role::Merchant {
            return Err(Error::Forbidden);
        }
        let mut tx = self.pool().begin().await?;
        let record: Option<Value> = sqlx::query_scalar(
            "SELECT record FROM paypal_disputes WHERE id=$1 AND workspace=$2 FOR UPDATE",
        )
        .bind(id)
        .bind(&p.workspace)
        .fetch_optional(&mut *tx)
        .await?;
        let mut d = decode(record.ok_or(Error::NotFound)?)?;
        let task: Value = sqlx::query_scalar(
            "SELECT record FROM paypal_tasks WHERE id=$1 AND workspace=$2 FOR UPDATE",
        )
        .bind(&d.task_id)
        .bind(&p.workspace)
        .fetch_one(&mut *tx)
        .await?;
        let task: Task =
            serde_json::from_value(task).map_err(|_| Error::Invalid("Stored task is invalid"))?;
        let allowance: Option<Allowance> = match &task.purchase {
            Some(c) => {
                let value: Option<Value> =
                    sqlx::query_scalar("SELECT record FROM paypal_allowances WHERE id=$1")
                        .bind(&c.allowance_id)
                        .fetch_optional(&mut *tx)
                        .await?;
                value
                    .map(serde_json::from_value)
                    .transpose()
                    .map_err(|_| Error::Invalid("Stored allowance is invalid"))?
            }
            None => None,
        };
        let pack = evidence_pack(&task, &d, allowance.as_ref(), origin);
        if pack["digest"] != digest {
            return Err(Error::Conflict);
        }
        let key = if d.submit.is_some() {
            None
        } else {
            if d.status != "WAITING_FOR_SELLER_RESPONSE" {
                return Err(Error::Invalid(
                    "PayPal is not waiting for seller evidence on this dispute",
                ));
            }
            let op = Operation::begin()?;
            let key = op.key.clone();
            d.submit = Some(op);
            sqlx::query("UPDATE paypal_disputes SET record=$1 WHERE id=$2")
                .bind(json!(d))
                .bind(id)
                .execute(&mut *tx)
                .await?;
            Some(key)
        };
        tx.commit().await?;
        Ok((d, pack, key))
    }
    async fn update_dispute<R>(
        &self,
        id: &str,
        change: impl FnOnce(&mut Dispute) -> Result<R, Error>,
    ) -> Result<(Dispute, R), Error> {
        let mut tx = self.pool().begin().await?;
        let v: Option<Value> =
            sqlx::query_scalar("SELECT record FROM paypal_disputes WHERE id=$1 FOR UPDATE")
                .bind(id)
                .fetch_optional(&mut *tx)
                .await?;
        let mut d = decode(v.ok_or(Error::NotFound)?)?;
        let result = change(&mut d)?;
        sqlx::query("UPDATE paypal_disputes SET record=$1 WHERE id=$2")
            .bind(json!(d))
            .bind(id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE paypal_tasks SET record=jsonb_set(record,'{dispute}',$1) WHERE id=$2 AND workspace=$3")
            .bind(json!(d.mark())).bind(&d.task_id).bind(&d.workspace).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok((d, result))
    }
}

impl App {
    async fn pack(&self, d: &Dispute, p: &Principal) -> Result<(Task, Value), Error> {
        let task = self.store.get(&d.task_id, p).await?;
        let allowance = match task.purchase.as_ref() {
            Some(c) => self.store.allowance_record(&c.allowance_id).await.ok(),
            None => None,
        };
        let pack = evidence_pack(&task, d, allowance.as_ref(), &self.config.public_origin);
        Ok((task, pack))
    }
    /// Verified inbox only: a CUSTOMER.DISPUTE.* event names a capture we know,
    /// so read the dispute back from PayPal and store it.
    pub(crate) async fn dispute_event(&self, event: &Value) -> Result<bool, Error> {
        if !event["event_type"]
            .as_str()
            .is_some_and(|t| t.starts_with("CUSTOMER.DISPUTE."))
        {
            return Ok(false);
        }
        let resource = &event["resource"];
        let ids: Vec<String> = resource["disputed_transactions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t["seller_transaction_id"].as_str())
            .map(str::to_string)
            .collect();
        let tasks = self.store.related(&ids).await?;
        if tasks.is_empty() {
            return Ok(false);
        }
        let id = resource["dispute_id"]
            .as_str()
            .ok_or(Error::Invalid("Dispute event ID missing"))?;
        let value = self
            .provider
            .dispute(id)
            .await
            .map_err(|_| Error::Invalid("Dispute read unavailable; event retained"))?;
        for task in tasks {
            if task.capture_id.is_some() {
                self.store.upsert_dispute(&task, &value).await?;
            }
        }
        Ok(true)
    }
}

pub fn router() -> Router<App> {
    Router::new()
        .route("/v1/paypal/disputes", get(list))
        .route("/v1/paypal/disputes/sync", post(sync))
        .route(
            "/v1/paypal/disputes/{id}/evidence",
            get(evidence_preview).post(submit),
        )
}
async fn list(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(
        json!({"disputes":app.store.disputes(&p).await?.iter().map(Dispute::view).collect::<Vec<_>>()}),
    ))
}
/// Asks PayPal about every captured task in the workspace, newest 100.
async fn sync(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    if p.role != Role::Merchant {
        return Err(Error::Forbidden);
    }
    app.store
        .rate_limit(&format!("disputes:{}", p.workspace), 4)
        .await?;
    for task in app.store.list(&p).await? {
        let Some(capture) = task.capture_id.as_deref() else {
            continue;
        };
        let found = app
            .provider
            .disputes_for_capture(capture)
            .await
            .map_err(|_| Error::Invalid("PayPal Disputes unavailable; check app enablement. Stored disputes are unchanged"))?;
        for item in found["items"].as_array().into_iter().flatten() {
            let Some(id) = item["dispute_id"].as_str() else {
                continue;
            };
            let value = app.provider.dispute(id).await.map_err(|_| {
                Error::Invalid("Dispute read unavailable; stored disputes are unchanged")
            })?;
            app.store.upsert_dispute(&task, &value).await?;
        }
    }
    Ok(Json(
        json!({"disputes":app.store.disputes(&p).await?.iter().map(Dispute::view).collect::<Vec<_>>()}),
    ))
}
async fn evidence_preview(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let d = app.store.dispute(&id, &p).await?;
    Ok(Json(app.pack(&d, &p).await?.1))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Submission {
    digest: String,
}
async fn submit(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Submission>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let (d, pack, key) = app
        .store
        .claim_evidence(&id, &p, &body.digest, &app.config.public_origin)
        .await?;
    if let Some(key) = key {
        let result = app
            .provider
            .provide_evidence(&id, pack["notes"].as_str().unwrap_or(""), &key)
            .await;
        let digest = pack["digest"].as_str().unwrap_or("").to_string();
        let (d, _) = app
            .store
            .update_dispute(&id, |d| {
                match &result {
                    Ok(v) => {
                        d.evidence = "submitted".into();
                        d.evidence_submitted_at = Some(domain::now());
                        d.evidence_digest = Some(digest.clone());
                        d.submit.as_mut().unwrap().observe(v.clone());
                    }
                    Err(_) => {
                        d.evidence = "unknown".into();
                        d.evidence_digest = Some(digest.clone());
                        d.submit.as_mut().unwrap().unknown();
                    }
                }
                Ok(())
            })
            .await?;
        return Ok(Json(d.view()));
    }
    Ok(Json(d.view()))
}

#[cfg(test)]
mod tests;
