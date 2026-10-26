//! Installation-wide read evidence, never a payment state transition.
use super::{
    config::Config,
    domain::{self, Error, Principal, Role},
    money::reporting_amount,
    routes::App,
    store::Store,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;

const OVERLAP: i64 = 3 * 3600;
const WINDOW: i64 = 86400;
const LEASE: i64 = 120;
pub fn authorize(config: &Config, p: &Principal) -> Result<(), Error> {
    if p.role != Role::Merchant
        || config.reporting_workspace.as_deref() != Some(p.workspace.as_str())
    {
        return Err(Error::Forbidden);
    }
    Ok(())
}
#[derive(Clone, Debug)]
struct Claim {
    workspace: String,
    token: String,
    start: i64,
    end: i64,
    page: i32,
}
fn date(n: i64) -> String {
    chrono::DateTime::from_timestamp(n, 0)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
fn identity(raw: &Value) -> Result<String, Error> {
    let i = &raw["transaction_info"];
    for k in [
        "transaction_id",
        "transaction_event_code",
        "transaction_initiation_date",
    ] {
        if !i[k]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 128)
        {
            return Err(Error::Invalid(
                "Reporting row lacks a stable identity; page not advanced",
            ));
        }
    }
    Ok(domain::hash(
        json!([
            i["transaction_id"],
            i["transaction_event_code"],
            i["transaction_initiation_date"],
            i["paypal_reference_id"],
            i["paypal_reference_id_type"],
            i["invoice_id"],
            i["custom_field"],
            i["ending_balance"],
            i["available_balance"]
        ])
        .to_string()
        .as_bytes(),
    ))
}
fn references(raw: &Value) -> Vec<String> {
    let i = &raw["transaction_info"];
    [
        i.get("transaction_id"),
        i.get("paypal_reference_id"),
        i.get("invoice_id"),
        i.get("custom_field"),
        raw.pointer("/cart_info/paypal_invoice_id"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_str)
    .filter(|s| !s.is_empty() && s.len() <= 128)
    .map(str::to_owned)
    .collect()
}
fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
}
fn projection(
    id: &str,
    raw: &Value,
    checked: i64,
    observations: i64,
    matches: Vec<String>,
) -> Value {
    let i = &raw["transaction_info"];
    json!({"id":id,"transaction_id":text_field(i,"transaction_id"),"event_code":text_field(i,"transaction_event_code"),"provider_status":text_field(i,"transaction_status"),"initiated_at":text_field(i,"transaction_initiation_date"),"updated_at":text_field(i,"transaction_updated_date"),"references":references(raw),"balance_affecting":null,"amount":reporting_amount(&i["transaction_amount"]),"fee":reporting_amount(&i["fee_amount"]),"net":null,"checked_at":checked,"observation_count":observations,"changed":observations>1,"status":match matches.len(){0=>"unmatched",1=>"matched",_=>"ambiguous"},"matches":matches})
}
impl Store {
    async fn reporting_claim(&self, workspace: &str) -> Result<Claim, Error> {
        let now = domain::now() as i64;
        let mut tx = self.pool().begin().await?;
        sqlx::query("INSERT INTO paypal_reporting_cursor(workspace,coverage_start,window_start,window_end) VALUES($1,$2,$2,$3) ON CONFLICT DO NOTHING").bind(workspace).bind(now-WINDOW).bind(now).execute(&mut *tx).await?;
        let r = sqlx::query("SELECT * FROM paypal_reporting_cursor WHERE workspace=$1 FOR UPDATE")
            .bind(workspace)
            .fetch_one(&mut *tx)
            .await?;
        if r.get::<Option<i64>, _>("lease_until")
            .is_some_and(|t| t > now)
        {
            return Err(Error::Conflict);
        }
        let completed: bool = r.get("completed");
        let start = if completed {
            r.get::<i64, _>("window_end") - OVERLAP
        } else {
            r.get("window_start")
        };
        let end = if completed {
            now.min(start + WINDOW)
        } else {
            r.get("window_end")
        };
        let claim = Claim {
            workspace: workspace.into(),
            token: domain::random_id()?,
            start,
            end,
            // Older cursors have no page-count baseline: replay their fixed window.
            page: if completed || r.get::<Option<i32>, _>("expected_pages").is_none() {
                1
            } else {
                r.get("next_page")
            },
        };
        sqlx::query("UPDATE paypal_reporting_cursor SET window_start=$2,window_end=$3,next_page=$4,completed=FALSE,expected_pages=CASE WHEN $4=1 THEN NULL ELSE expected_pages END,lease_token=$5,lease_until=$6 WHERE workspace=$1").bind(workspace).bind(start).bind(end).bind(claim.page).bind(&claim.token).bind(now+LEASE).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(claim)
    }
    async fn reporting_release(&self, c: &Claim) -> Result<(), Error> {
        sqlx::query("UPDATE paypal_reporting_cursor SET lease_token=NULL,lease_until=NULL WHERE workspace=$1 AND lease_token=$2").bind(&c.workspace).bind(&c.token).execute(self.pool()).await?;
        Ok(())
    }
    /// Fenced page commit: rows, observation history and continuation are one transaction.
    async fn reporting_commit(&self, c: &Claim, report: Value) -> Result<bool, Error> {
        let rows = report["transaction_details"]
            .as_array()
            .ok_or(Error::Invalid("Invalid reporting page"))?;
        let total = report["total_pages"]
            .as_i64()
            .filter(|v| *v >= 0 && *v <= i32::MAX as i64)
            .ok_or(Error::Invalid("Missing reporting pagination"))?;
        if rows.len() > 100
            || report["page"].as_i64() != Some(c.page as i64)
            || (total == 0 && !rows.is_empty())
            || (total > c.page as i64 && rows.is_empty())
        {
            return Err(Error::Invalid(
                "Inconsistent reporting page; cursor preserved",
            ));
        }
        let complete = c.page as i64 >= total;
        let now = domain::now() as i64;
        let mut tx = self.pool().begin().await?;
        let valid = sqlx::query("SELECT expected_pages FROM paypal_reporting_cursor WHERE workspace=$1 AND lease_token=$2 AND lease_until>$3 AND next_page=$4 AND completed=FALSE FOR UPDATE").bind(&c.workspace).bind(&c.token).bind(now).bind(c.page).fetch_optional(&mut *tx).await?;
        let valid = valid.ok_or(Error::Conflict)?;
        if valid
            .get::<Option<i32>, _>("expected_pages")
            .is_some_and(|pages| i64::from(pages) != total)
        {
            // A late insertion/deletion can shift page boundaries. Keep imported evidence,
            // but replay this same fixed window rather than claim complete coverage.
            sqlx::query("UPDATE paypal_reporting_cursor SET next_page=1,expected_pages=NULL WHERE workspace=$1 AND lease_token=$2")
                .bind(&c.workspace).bind(&c.token).execute(&mut *tx).await?;
            tx.commit().await?;
            return Err(Error::Invalid(
                "Reporting pagination changed; resume this window from page one",
            ));
        }
        if total < i64::from(c.page) && !(total == 0 && c.page == 1) {
            return Err(Error::Invalid(
                "Inconsistent reporting page; cursor preserved",
            ));
        }
        for raw in rows {
            let id = identity(raw)?;
            let hash = domain::hash(raw.to_string().as_bytes());
            sqlx::query("INSERT INTO paypal_reporting_rows(workspace,id,raw,observation_hash,first_seen,checked_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(workspace,id) DO UPDATE SET raw=EXCLUDED.raw,observation_hash=EXCLUDED.observation_hash,checked_at=EXCLUDED.checked_at").bind(&c.workspace).bind(&id).bind(raw).bind(&hash).bind(now).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO paypal_reporting_observations(workspace,row_id,hash,raw,first_seen,checked_at) VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT(workspace,row_id,hash) DO UPDATE SET checked_at=EXCLUDED.checked_at").bind(&c.workspace).bind(&id).bind(hash).bind(raw).bind(now).execute(&mut *tx).await?;
        }
        sqlx::query("UPDATE paypal_reporting_cursor SET next_page=$3,completed=$4,expected_pages=$7,watermark=CASE WHEN $4 THEN window_end ELSE watermark END,checked_at=$5,lease_until=$6 WHERE workspace=$1 AND lease_token=$2").bind(&c.workspace).bind(&c.token).bind(if complete {c.page}else{c.page.checked_add(1).ok_or(Error::Invalid("Reporting page overflow"))?}).bind(complete).bind(now).bind(now+LEASE).bind(total as i32).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(complete)
    }
    async fn reporting_matches(&self, workspace: &str, raw: &Value) -> Result<Vec<String>, Error> {
        let ids = references(raw);
        // No latest-100 task cutoff. Multiple exact owners stay ambiguous.
        Ok(sqlx::query_scalar("SELECT 'task:'||id FROM paypal_tasks WHERE workspace=$1 AND (id=ANY($2) OR record->>'order_id'=ANY($2) OR record->>'capture_id'=ANY($2) OR record->>'refund_id'=ANY($2) OR record->'refund'->>'key'=ANY($2) OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(record->'refunds','[]'::jsonb)) r WHERE r->>'provider_id'=ANY($2) OR r->'operation'->>'key'=ANY($2))) UNION SELECT 'subscription:'||s.id FROM paypal_subscriptions s WHERE s.workspace=$1 AND (s.record->>'provider_id'=ANY($2) OR EXISTS(SELECT 1 FROM paypal_subscription_periods p WHERE p.subscription_id=s.id AND p.payment_id=ANY($2))) ORDER BY 1").bind(workspace).bind(&ids).fetch_all(self.pool()).await?)
    }
    pub async fn reporting_row(&self, workspace: &str, id: &str) -> Result<Value, Error> {
        let r = sqlx::query("SELECT raw,checked_at,(SELECT count(*) FROM paypal_reporting_observations o WHERE o.workspace=r.workspace AND o.row_id=r.id) observations FROM paypal_reporting_rows r WHERE workspace=$1 AND id=$2").bind(workspace).bind(id).fetch_optional(self.pool()).await?.ok_or(Error::NotFound)?;
        let raw: Value = r.get("raw");
        let matches = self.reporting_matches(workspace, &raw).await?;
        let mut row = projection(
            id,
            &raw,
            r.get("checked_at"),
            r.get("observations"),
            matches,
        );
        // PayPal supplies no unique row key. A changed same-composite observation may
        // be a late update or a collision; expose each variant, never sum or discard it.
        let history = sqlx::query("SELECT hash,raw,first_seen,checked_at FROM paypal_reporting_observations WHERE workspace=$1 AND row_id=$2 ORDER BY first_seen,hash LIMIT 101").bind(workspace).bind(id).fetch_all(self.pool()).await?;
        row["history_truncated"] = json!(history.len() > 100);
        row["observation_ambiguity"] = json!(r.get::<i64, _>("observations") > 1);
        row["observations"] = json!(
            history
                .iter()
                .take(100)
                .map(|h| {
                    let raw: Value = h.get("raw");
                    let mut item = projection(id, &raw, h.get("checked_at"), 1, vec![]);
                    item["hash"] = json!(h.get::<String, _>("hash"));
                    item["first_seen"] = json!(h.get::<i64, _>("first_seen"));
                    item
                })
                .collect::<Vec<_>>()
        );
        Ok(row)
    }
    async fn reporting_inbox(&self, workspace: &str, after: &str) -> Result<Value, Error> {
        let cursor:Option<Value> = sqlx::query_scalar("SELECT jsonb_build_object('coverage_start',coverage_start,'window_start',window_start,'window_end',window_end,'next_page',next_page,'completed',completed,'watermark',watermark,'checked_at',checked_at,'lease_until',lease_until) FROM paypal_reporting_cursor WHERE workspace=$1").bind(workspace).fetch_optional(self.pool()).await?;
        let ids:Vec<String> = sqlx::query_scalar("SELECT id FROM paypal_reporting_rows WHERE workspace=$1 AND id>$2 ORDER BY id LIMIT 101").bind(workspace).bind(after).fetch_all(self.pool()).await?;
        let next = if ids.len() > 100 {
            ids.get(99).cloned()
        } else {
            None
        };
        let mut rows = Vec::new();
        for id in ids.iter().take(100) {
            rows.push(self.reporting_row(workspace, id).await?);
        }
        Ok(
            json!({"cursor":cursor,"rows":rows,"next":next,"note":"Observation matching is not settlement or fulfillment. Reporting may lag three hours; coverage is incomplete. Changed or unmatched rows require review. Amounts are provider evidence; merchant proceeds are separate from buyer receipt cost. No cross-currency or balance/non-balance totals are inferred."}),
        )
    }
}
pub async fn sync(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    authorize(&app.config, &p)?;
    app.store
        .rate_limit(&format!("reporting-sync:{}", p.workspace), 4)
        .await?;
    let mut c = app.store.reporting_claim(&p.workspace).await?;
    let result = async {
        for _ in 0..2 {
            let page=app.provider.transactions(&date(c.start),&date(c.end),c.page as u32).await.map_err(|_|Error::Invalid("Transaction Search unavailable; enable it on the sandbox app. Cursor preserved; resume this window."))?;
            if app.store.reporting_commit(&c,page).await? { break; }
            c.page+=1;
        }
        Ok::<_,Error>(())
    }.await;
    app.store.reporting_release(&c).await?;
    result?;
    Ok(Json(app.store.reporting_inbox(&p.workspace, "").await?))
}
#[derive(Deserialize)]
pub struct InboxQuery {
    #[serde(default)]
    after: String,
}
pub async fn inbox(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<InboxQuery>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    authorize(&app.config, &p)?;
    app.store
        .rate_limit(&format!("reporting-read:{}", p.workspace), 30)
        .await?;
    if q.after.len() > 64 {
        return Err(Error::Invalid("Invalid inbox cursor"));
    }
    Ok(Json(
        app.store.reporting_inbox(&p.workspace, &q.after).await?,
    ))
}
pub async fn explain(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    authorize(&app.config, &p)?;
    app.store
        .rate_limit(&format!("reporting-ai:{}", p.workspace), 10)
        .await?;
    let row = app.store.reporting_row(&p.workspace, &id).await?;
    Ok(Json(app.ai.explain_reporting(row).await?))
}

#[cfg(test)]
mod tests {
    use super::super::{
        ai::Ai,
        domain::{Document, Task},
        provider::Provider,
    };
    use super::*;
    use std::sync::Arc;
    fn config(workspace: Option<String>) -> Config {
        Config {
            reporting_workspace: workspace,
            allowances: false,
            wallet_login: false,
            relay_url: None,
            extra_origins: vec![],
            database_url: "unused".into(),
            client_id: "fixture".into(),
            client_secret: "fixture".into(),
            webhook_id: "fixture".into(),
            public_origin: "http://127.0.0.1:5197".into(),
            new_purchases: false,
            subscriptions: false,
            subscription_plan: None,
        }
    }
    fn raw(id: &str) -> Value {
        json!({"transaction_info":{"transaction_id":id,"transaction_event_code":"T0006","transaction_initiation_date":"2026-10-24T10:00:00Z","transaction_status":"S","transaction_amount":{"value":"12.00","currency_code":"USD"},"fee_amount":{"value":"-0.55","currency_code":"USD"}},"payer_info":{"email_address":"private@example.test"}})
    }
    fn page(n: i32, total: i32, rows: Vec<Value>) -> Value {
        json!({"page":n,"total_pages":total,"transaction_details":rows})
    }
    #[test]
    fn authorization_is_explicit_role_and_installation_scope() {
        for configured in [None, Some("installation".into())] {
            let c = config(configured.clone());
            for role in [Role::Buyer, Role::Agent, Role::Merchant] {
                for workspace in ["installation", "unrelated"] {
                    let p = Principal {
                        id: "fixture".into(),
                        workspace: workspace.into(),
                        role: role.clone(),
                    };
                    assert_eq!(
                        authorize(&c, &p).is_ok(),
                        configured.is_some()
                            && workspace == "installation"
                            && role == Role::Merchant
                    );
                }
            }
        }
    }
    #[test]
    fn identity_and_signed_amounts_preserve_distinct_evidence() {
        let a = raw("same");
        for (key, value) in [
            ("transaction_event_code", "T1107"),
            ("paypal_reference_id", "OTHER"),
            ("transaction_initiation_date", "2026-10-24T11:00:00Z"),
            ("invoice_id", "invoice-other"),
        ] {
            let mut b = a.clone();
            b["transaction_info"][key] = value.into();
            assert_ne!(identity(&a).unwrap(), identity(&b).unwrap());
        }
        let mut b = a.clone();
        b["transaction_info"]["transaction_status"] = "V".into();
        assert_eq!(identity(&a).unwrap(), identity(&b).unwrap());
        for (s, currency) in [
            ("-0.55", "USD"),
            ("12", "JPY"),
            ("123.456", "KWD"),
            ("9007199254740993.00", "USD"),
        ] {
            let v = json!({"value":s,"currency_code":currency});
            assert_eq!(reporting_amount(&v), Some(v));
        }
        for s in ["+1.00", "1e3", "NaN", " 1.00", "1.", "-.5", "1.0.0"] {
            assert!(reporting_amount(&json!({"value":s,"currency_code":"USD"})).is_none());
        }
        let v = projection("row", &a, 1, 1, vec![]);
        assert!(v["net"].is_null());
        assert!(!v.to_string().contains("private@example"));
    }
    #[test]
    fn projection_does_not_forward_untyped_provider_fields() {
        let mut raw = raw("A");
        raw["transaction_info"]["transaction_status"] = json!({"email": "private@example.test"});
        raw["transaction_info"]["transaction_updated_date"] = json!(["private@example.test"]);
        let row = projection("row", &raw, 1, 1, vec![]);
        assert!(row["provider_status"].is_null());
        assert!(row["updated_at"].is_null());
        assert!(!row.to_string().contains("private@example.test"));
    }

    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn changing_pagination_restarts_without_advancing_coverage_or_losing_rows() {
        let store = Store::connect(&std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let workspace = domain::random_id().unwrap();
        let mut c = store.reporting_claim(&workspace).await.unwrap();
        // An empty intermediate page is inconsistent, not proof that nothing was paid.
        assert!(
            store
                .reporting_commit(&c, page(1, 3, vec![]))
                .await
                .is_err()
        );
        assert_eq!(
            store.reporting_inbox(&workspace, "").await.unwrap()["cursor"]["next_page"],
            1
        );
        assert!(
            !store
                .reporting_commit(&c, page(1, 3, vec![raw("A")]))
                .await
                .unwrap()
        );
        c.page = 2;
        assert!(
            store
                .reporting_commit(&c, page(2, 1, vec![raw("B")]))
                .await
                .is_err()
        );
        store.reporting_release(&c).await.unwrap();
        let inbox = store.reporting_inbox(&workspace, "").await.unwrap();
        assert_eq!(inbox["cursor"]["next_page"], 1);
        assert_eq!(inbox["cursor"]["completed"], false);
        assert!(inbox["cursor"]["watermark"].is_null());
        assert_eq!(inbox["rows"].as_array().unwrap().len(), 1);
        let resumed = store.reporting_claim(&workspace).await.unwrap();
        assert_eq!(
            (resumed.start, resumed.end, resumed.page),
            (c.start, c.end, 1)
        );
        assert!(
            store
                .reporting_commit(&resumed, page(1, 1, vec![raw("A"), raw("B")]))
                .await
                .unwrap()
        );
        store.reporting_release(&resumed).await.unwrap();
        let inbox = store.reporting_inbox(&workspace, "").await.unwrap();
        assert_eq!(inbox["cursor"]["completed"], true);
        assert_eq!(inbox["rows"].as_array().unwrap().len(), 2);
        assert_eq!(inbox["rows"][0]["observation_count"], 1);
    }

    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn atomic_pages_crash_replay_expired_leases_and_observation_changes() {
        let url = std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap();
        let store = Store::connect(&url).await.unwrap();
        let workspace = domain::random_id().unwrap();
        let c = store.reporting_claim(&workspace).await.unwrap();
        assert!(matches!(
            store.reporting_claim(&workspace).await,
            Err(Error::Conflict)
        ));
        // Failure after inserting a valid row but before commit must roll it back with cursor.
        assert!(
            store
                .reporting_commit(&c, page(1, 3, vec![raw("A"), json!({})]))
                .await
                .is_err()
        );
        assert!(
            store.reporting_inbox(&workspace, "").await.unwrap()["rows"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .reporting_commit(&c, json!({"page":1,"transaction_details":[]}))
                .await
                .is_err()
        );
        // Simulated crash before page commit: expire lease and reclaim same fixed window/page.
        sqlx::query("UPDATE paypal_reporting_cursor SET lease_until=0 WHERE workspace=$1")
            .bind(&workspace)
            .execute(store.pool())
            .await
            .unwrap();
        let mut resumed = Store::connect(&url)
            .await
            .unwrap()
            .reporting_claim(&workspace)
            .await
            .unwrap();
        assert_eq!(
            (resumed.start, resumed.end, resumed.page),
            (c.start, c.end, 1)
        );
        assert!(matches!(
            store.reporting_commit(&c, page(1, 3, vec![raw("A")])).await,
            Err(Error::Conflict)
        ));
        assert!(
            !store
                .reporting_commit(&resumed, page(1, 3, vec![raw("A")]))
                .await
                .unwrap()
        );
        // Lost response after commit: reconnect resumes page 2, not page 1 or page 3.
        sqlx::query("UPDATE paypal_reporting_cursor SET lease_until=0 WHERE workspace=$1")
            .bind(&workspace)
            .execute(store.pool())
            .await
            .unwrap();
        resumed = store.reporting_claim(&workspace).await.unwrap();
        assert_eq!(resumed.page, 2);
        assert!(
            store.reporting_inbox(&workspace, "").await.unwrap()["cursor"]["watermark"].is_null()
        );
        assert!(
            !store
                .reporting_commit(&resumed, page(2, 3, vec![raw("A")]))
                .await
                .unwrap()
        );
        resumed.page = 3;
        assert!(
            store
                .reporting_commit(&resumed, page(3, 3, vec![]))
                .await
                .unwrap()
        );
        store.reporting_release(&resumed).await.unwrap();
        let row = store
            .reporting_row(&workspace, &identity(&raw("A")).unwrap())
            .await
            .unwrap();
        assert_eq!(row["observation_count"], 1);
        let overlap = store.reporting_claim(&workspace).await.unwrap();
        assert_eq!(overlap.start, c.end - OVERLAP);
        let mut changed = raw("A");
        changed["transaction_info"]["transaction_status"] = "V".into();
        let mut distinct = raw("A");
        distinct["transaction_info"]["transaction_event_code"] = "T1107".into();
        assert!(
            store
                .reporting_commit(&overlap, page(1, 1, vec![changed, distinct]))
                .await
                .unwrap()
        );
        let inbox = store.reporting_inbox(&workspace, "").await.unwrap();
        assert_eq!(inbox["rows"].as_array().unwrap().len(), 2);
        let row = store
            .reporting_row(&workspace, &identity(&raw("A")).unwrap())
            .await
            .unwrap();
        assert_eq!(row["observation_count"], 2);
        assert_eq!(row["changed"], true);
        assert!(matches!(
            store
                .reporting_row("unrelated", row["id"].as_str().unwrap())
                .await,
            Err(Error::NotFound)
        ));
    }
    #[tokio::test]
    #[ignore = "requires isolated PAYPAL_TEST_DATABASE_URL"]
    async fn exact_workspace_matches_and_read_only_cited_ai_routes() {
        use axum::{Router, routing::post};
        let store = Store::connect(&std::env::var("PAYPAL_TEST_DATABASE_URL").unwrap())
            .await
            .unwrap();
        let p = Principal {
            id: domain::random_id().unwrap(),
            workspace: domain::random_id().unwrap(),
            role: Role::Merchant,
        };
        let buyer = Principal {
            role: Role::Buyer,
            ..p.clone()
        };
        let mut t = Task::quote(
            &buyer,
            vec![Document {
                name: "doc".into(),
                text: "fixture text".into(),
            }],
        )
        .unwrap();
        t.capture_id = Some("CAPTURE".into());
        t.refund_id = Some("REFUND".into());
        store
            .create(&t, &domain::random_id().unwrap(), "fixture")
            .await
            .unwrap();
        for id in ["CAPTURE", "REFUND", t.id.as_str()] {
            assert_eq!(
                store
                    .reporting_matches(&p.workspace, &raw(id))
                    .await
                    .unwrap(),
                vec![format!("task:{}", t.id)]
            );
        }
        assert!(
            store
                .reporting_matches("other", &raw("CAPTURE"))
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            store
                .reporting_matches(&p.workspace, &raw("UNKNOWN"))
                .await
                .unwrap()
                .is_empty()
        );
        let mut another = Task::quote(
            &buyer,
            vec![Document {
                name: "doc".into(),
                text: "fixture text".into(),
            }],
        )
        .unwrap();
        another.capture_id = t.capture_id.clone();
        store
            .create(&another, &domain::random_id().unwrap(), "fixture")
            .await
            .unwrap();
        assert_eq!(
            store
                .reporting_matches(&p.workspace, &raw("CAPTURE"))
                .await
                .unwrap()
                .len(),
            2
        );
        let claim = store.reporting_claim(&p.workspace).await.unwrap();
        store
            .reporting_commit(&claim, page(1, 1, vec![raw("CAPTURE")]))
            .await
            .unwrap();
        let rowid = identity(&raw("CAPTURE")).unwrap();
        let model=Router::new().route("/model",post(|Json(body):Json<Value>| async move {
            let evidence:Value=serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            assert!(!evidence.to_string().contains("private@example"));assert_eq!(evidence["status"],"ambiguous");
            Json(json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"explanation":"Two exact references require review; settlement is not established.","citations":[evidence["id"]]}).to_string()}}]}))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let model_server = tokio::spawn(async move { axum::serve(listener, model).await.unwrap() });
        let cfg = config(Some(p.workspace.clone()));
        let app = App {
            ai: Ai::fixture(format!("{base}/model")),
            provider: Provider::fixture(base, &cfg),
            config: Arc::new(cfg),
            store: store.clone(),
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!(
            "http://{}/v1/paypal/reporting",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, super::super::routes::router(app))
                .await
                .unwrap()
        });
        let client = reqwest::Client::new();
        for (role, workspace, allowed) in [
            (Role::Merchant, p.workspace.clone(), true),
            (Role::Buyer, p.workspace.clone(), false),
            (Role::Agent, p.workspace.clone(), false),
            (Role::Merchant, "other".into(), false),
        ] {
            let principal = Principal {
                id: p.id.clone(),
                workspace,
                role,
            };
            let token = store.issue_access(&principal, 600).await.unwrap();
            let status = client
                .get(format!("{base}/inbox"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .status();
            assert_eq!(status.as_u16(), if allowed { 200 } else { 403 });
            let response = client
                .post(format!("{base}/rows/{rowid}/explain"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), if allowed { 200 } else { 403 });
            if allowed {
                let v: Value = response.json().await.unwrap();
                assert_eq!(v["citations"], json!([rowid]));
            } else {
                assert_eq!(
                    client
                        .post(format!("{base}/sync"))
                        .bearer_auth(&token)
                        .send()
                        .await
                        .unwrap()
                        .status(),
                    403
                );
            }
        }
        let stored: Value = sqlx::query_scalar("SELECT record FROM paypal_tasks WHERE id=$1")
            .bind(&t.id)
            .fetch_one(store.pool())
            .await
            .unwrap();
        assert_eq!(stored, serde_json::to_value(t).unwrap());
        model_server.abort();
        server.abort();
    }
}
