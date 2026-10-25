use super::{
    config::Config,
    domain::{self, Document, Error, Operation, Principal, Role, Task},
    observations,
    provider::Provider,
    store::Store,
};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

#[derive(Clone)]
pub struct App {
    pub ai: super::ai::Ai,
    pub store: Store,
    pub provider: Provider,
    pub config: Arc<Config>,
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let status = match &self {
            Error::Forbidden => StatusCode::FORBIDDEN,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Conflict => StatusCode::CONFLICT,
            Error::Storage(_) => StatusCode::SERVICE_UNAVAILABLE,
            Error::Invalid(s) if s.starts_with("Rate limit") => StatusCode::TOO_MANY_REQUESTS,
            Error::Invalid(_) => StatusCode::UNPROCESSABLE_ENTITY,
        };
        let message = if matches!(self, Error::Storage(_)) {
            "Storage unavailable; preserve the original operation".into()
        } else {
            self.to_string()
        };
        (status, Json(json!({"error":message}))).into_response()
    }
}

impl App {
    pub(crate) async fn principal(&self, headers: &HeaderMap) -> Result<Principal, Error> {
        let token = bearer(headers)?;
        let p = self.store.authenticate(token).await?;
        self.store
            .rate_limit(&format!("api:{}:{}", p.workspace, p.id), 120)
            .await?;
        Ok(p)
    }
    pub(crate) fn purchases(&self) -> Result<(), Error> {
        if !self.config.new_purchases {
            Err(Error::Invalid(
                "New purchases are paused; existing records remain available",
            ))
        } else {
            Ok(())
        }
    }
    pub async fn reconcile(&self, id: &str, p: &Principal) -> Result<Task, Error> {
        let task = self.store.get(id, p).await?;
        if let Some(order_id) = task.order_id {
            let value = self.provider.order(&order_id).await.map_err(|_| {
                Error::Invalid("PayPal observation unavailable; keep the original operation")
            })?;
            self.store
                .update(id, p, |t| observations::order(t, value))
                .await?;
        }
        let task = self.store.get(id, p).await?;
        if let Some(refund_id) = task.refund_id {
            let value = self.provider.refund(&refund_id).await.map_err(|_| {
                Error::Invalid("PayPal observation unavailable; keep the original operation")
            })?;
            self.store
                .update(id, p, |t| observations::refund(t, value))
                .await?;
        }
        let task = self.store.get(id, p).await?;
        for (index, refund) in task.refunds.iter().enumerate() {
            if let Some(refund_id) = &refund.provider_id {
                let value = self.provider.refund(refund_id).await.map_err(|_| {
                    Error::Invalid("Original refund observation unavailable; do not replace")
                })?;
                self.store
                    .update(id, p, |t| observations::ledger_refund(t, index, value))
                    .await?;
            }
        }
        self.store.get(id, p).await
    }

    /// Inbox workers only perform reads; they can never dispatch a charge/refund.
    pub async fn process_events(&self) -> Result<(), Error> {
        for event in self.store.pending_events().await? {
            if self.subscription_event(&event).await.unwrap_or(false)
                || self.dispute_event(&event).await.unwrap_or(false)
                || self.vault_event(&event).await.unwrap_or(false)
            {
                self.store
                    .mark_event(event["id"].as_str().unwrap_or(""))
                    .await?;
                continue;
            }
            let resource = &event["resource"];
            let mut ids = Vec::new();
            for value in [
                resource.get("id"),
                resource.get("custom_id"),
                resource.get("invoice_id"),
                resource.pointer("/supplementary_data/related_ids/order_id"),
                resource.pointer("/supplementary_data/related_ids/capture_id"),
            ] {
                if let Some(id) = value.and_then(Value::as_str) {
                    ids.push(id.to_string());
                }
            }
            if let Some(units) = resource["purchase_units"].as_array() {
                for unit in units {
                    if let Some(id) = unit["custom_id"].as_str() {
                        ids.push(id.to_string());
                    }
                }
            }
            // Refund events may carry their capture only in an 'up' link.
            if let Some(links) = resource["links"].as_array() {
                for link in links {
                    if link["rel"] == "up" {
                        if let Some(href) = link["href"].as_str() {
                            if let Ok(url) = url::Url::parse(href) {
                                if matches!(
                                    url.host_str(),
                                    Some("api.sandbox.paypal.com" | "api-m.sandbox.paypal.com")
                                ) && url.path().starts_with("/v2/payments/captures/")
                                {
                                    if let Some(id) =
                                        url.path_segments().and_then(|mut s| s.next_back())
                                    {
                                        ids.push(id.into());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let tasks = self.store.related(&ids).await?;
            let mut resolved = !tasks.is_empty();
            for task in tasks {
                let p = Principal {
                    id: task.principal.clone(),
                    workspace: task.workspace.clone(),
                    role: Role::Merchant,
                };
                if event["event_type"] == "PAYMENT.CAPTURE.REFUNDED" {
                    let observation = if let Some(id) = resource["id"].as_str() {
                        self.provider.refund(id).await.ok()
                    } else {
                        None
                    };
                    if observation.is_none() {
                        // Transport failure is not evidence of an unmatched refund. Keep the
                        // verified event pending and retry only the provider read later.
                        resolved = false;
                        continue;
                    }
                    let mut known = false;
                    if let Some(value) = observation {
                        let index = task.refunds.iter().position(|r| {
                            r.operation.as_ref().is_some_and(|op| {
                                value["invoice_id"].as_str() == Some(op.key.as_str())
                            }) || r
                                .provider_id
                                .as_deref()
                                .is_some_and(|id| value["id"].as_str() == Some(id))
                        });
                        if let Some(index) = index {
                            known = self
                                .store
                                .update(&task.id, &p, |t| {
                                    observations::ledger_refund(t, index, value.clone())
                                })
                                .await
                                .is_ok();
                        } else if task
                            .refund_id
                            .as_deref()
                            .is_some_and(|id| value["id"].as_str() == Some(id))
                            || task.refund.as_ref().is_some_and(|op| {
                                value["invoice_id"].as_str() == Some(op.key.as_str())
                            })
                        {
                            known = self
                                .store
                                .update(&task.id, &p, |t| observations::refund(t, value))
                                .await
                                .is_ok();
                        }
                    }
                    if !known {
                        self.store.update(&task.id,&p,|t| { t.payment_review=Some("Verified webhook reports an unmatched refund; merchant review required".into()); Ok(()) }).await?;
                        resolved = false;
                    }
                }
                if matches!(
                    event["event_type"].as_str(),
                    Some("PAYMENT.CAPTURE.REVERSED" | "PAYMENT.CAPTURE.DENIED")
                ) {
                    self.store.update(&task.id, &p, |t| { t.payment_review = Some("Verified webhook reports an external payment change; merchant review required".into()); Ok(()) }).await?;
                }
                // Recover a lost create response via the verified event's order ID.
                if task.order_id.is_none()
                    && event["event_type"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("CHECKOUT.ORDER."))
                {
                    if let Some(order_id) = resource["id"].as_str() {
                        match self.provider.order(order_id).await {
                            Ok(value) => {
                                if self
                                    .store
                                    .update(&task.id, &p, |t| observations::order(t, value))
                                    .await
                                    .is_err()
                                {
                                    resolved = false;
                                    continue;
                                }
                            }
                            Err(_) => {
                                resolved = false;
                                continue;
                            }
                        }
                    }
                }
                if self.reconcile(&task.id, &p).await.is_err() {
                    resolved = false;
                }
            }
            // Unmatched events remain available: the related state may be in flight.
            if resolved {
                self.store
                    .mark_event(event["id"].as_str().unwrap_or(""))
                    .await?;
            }
        }
        Ok(())
    }
}

/// Ready means the configuration passed and the database answers. It never
/// claims the provider accepted anything.
async fn healthz(State(app): State<App>) -> impl IntoResponse {
    let db = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        sqlx::query("SELECT 1").execute(app.store.pool()),
    )
    .await;
    match db {
        Ok(Ok(_)) => (
            StatusCode::OK,
            Json(
                json!({"status":"ready","service":"chainpay-paypal","sandbox":true,"provider_acceptance":"unverified"}),
            ),
        ),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"unavailable","service":"chainpay-paypal","reason":"database"})),
        ),
    }
}

pub fn router(app: App) -> Router {
    let origin: axum::http::HeaderValue =
        app.config.public_origin.parse().expect("validated origin");
    Router::new()
        .merge(super::subscriptions::router())
        .merge(super::allowance::router())
        .merge(super::catalog::router())
        .merge(super::disputes::router())
        .route("/healthz", get(healthz))
        .route("/v1/paypal/session", get(session).delete(logout))
        .route("/v1/paypal/offers", get(offers))
        .route("/v1/paypal/preflight", post(preflight))
        .route("/v1/paypal/recommend-service", post(recommend_service))
        .route("/v1/paypal/analytics", get(analytics))
        .route("/v1/paypal/analytics/ask", post(analytics_ask))
        .route("/v1/paypal/tasks/{id}/reporting", post(reporting))
        .route("/v1/paypal/tasks", get(list).post(quote))
        .route("/v1/paypal/tasks/{id}", get(read))
        .route("/v1/paypal/tasks/{id}/checkout", post(checkout))
        .route("/v1/paypal/tasks/{id}/capture", post(capture))
        .route("/v1/paypal/tasks/{id}/reconcile", post(reconcile))
        .route("/v1/paypal/tasks/{id}/process", post(process))
        .route("/v1/paypal/tasks/{id}/explain", post(explain))
        .route(
            "/v1/paypal/tasks/{id}/refund-proposal",
            get(refund_proposal),
        )
        .route("/v1/paypal/tasks/{id}/refund", post(refund))
        .route("/v1/paypal/tasks/{id}/resolution", post(decision))
        .route("/v1/paypal/tasks/{id}/rework", post(rework))
        .route(
            "/v1/paypal/tasks/{id}/resolution-refunds",
            post(resolution_proposal),
        )
        .route(
            "/v1/paypal/tasks/{id}/resolution-refunds/approve",
            post(resolution_refund),
        )
        .route("/v1/paypal/tasks/{id}/share", post(share).delete(unshare))
        .route("/v1/paypal/receipts/{token}", get(public_receipt))
        .route("/v1/paypal/webhooks", post(webhook))
        .route("/internal/cron/paypal/events", post(cron_events))
        .layer(DefaultBodyLimit::max(200_000))
        .layer(
            CorsLayer::new()
                .allow_origin(origin)
                .allow_methods([
                    axum::http::Method::GET,
                    axum::http::Method::POST,
                    axum::http::Method::DELETE,
                ])
                .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]),
        )
        .layer(axum::middleware::map_response(
            |mut response: Response| async move {
                response
                    .headers_mut()
                    .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
                response
                    .headers_mut()
                    .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
                response
            },
        ))
        .with_state(app)
}

async fn process(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, Error> {
    let p = app.principal(&headers).await?;
    let (task, _) = app.store.update(&id, &p, |_| Ok(())).await?;
    if task.purchase.is_some() {
        return Err(Error::Invalid(
            "Catalog purchases are fulfilled by the merchant, not processed here",
        ));
    }
    if !task.verified_funded() {
        return Err(Error::Invalid(
            "A verified capture is required before processing",
        ));
    }
    // On Vercel the function is frozen as soon as it answers, so a spawned job
    // would never finish. Run it inside the request there; an interrupted unit
    // is picked up again by "Run or recover this paid task" after its lease.
    #[cfg(feature = "vercel")]
    if let Err(error) = app.ai.run(&app.store, &id, &p).await {
        eprintln!("PayPal task {id} processing stopped: {error:?}");
    }
    #[cfg(not(feature = "vercel"))]
    tokio::spawn(async move {
        if let Err(error) = app.ai.run(&app.store, &id, &p).await {
            eprintln!("PayPal task {id} processing stopped: {error:?}");
        }
    });
    Ok(StatusCode::ACCEPTED)
}
async fn explain(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(app.ai.explain(&app.store, &id, &p).await?))
}

async fn analytics(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(super::analytics::projection(
        &app.store.list(&p).await?,
    )))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Question {
    question: String,
}
async fn analytics_ask(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<Question>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(app.ai.analyze(&app.store, &p, &body.question).await?))
}
async fn reporting(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let task = app.store.get(&id, &p).await?;
    app.store
        .rate_limit(&format!("reporting:{}", p.workspace), 4)
        .await?;
    let start = crate::webhooks::iso8601(task.created_at.saturating_sub(60) * 1000);
    let end = crate::webhooks::iso8601(domain::now().min(task.created_at + 30 * 86400) * 1000);
    let ids: Vec<&str> = [
        task.order_id.as_deref(),
        task.capture_id.as_deref(),
        task.refund_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    .collect();
    let mut matches = Vec::new();
    let mut truncated = false;
    for page in 1..=5 {
        let report=app.provider.transactions(&start,&end,page).await.map_err(|_| Error::Invalid("PayPal Reporting unavailable; check app enablement. Existing payment evidence is unchanged"))?;
        let rows = report["transaction_details"]
            .as_array()
            .ok_or(Error::Invalid("Reporting response incomplete"))?;
        for row in rows {
            let info = &row["transaction_info"];
            if info["transaction_id"]
                .as_str()
                .is_some_and(|id| ids.contains(&id))
            {
                matches.push(json!({"transaction_id":info["transaction_id"],"status":info["transaction_status"],"event_code":info["transaction_event_code"],"amount":info["transaction_amount"],"fee":info["fee_amount"]}));
            }
        }
        let pages = report["total_pages"]
            .as_u64()
            .ok_or(Error::Invalid("Reporting pagination unavailable"))?;
        if u64::from(page) >= pages {
            break;
        }
        if page == 5 {
            truncated = true;
        }
    }
    Ok(Json(
        json!({"checked_at":domain::now(),"range_start":start,"range_end":end,"transactions":matches,"truncated":truncated,"source":"PayPal Transaction Search","note":"Reporting may lag three hours. Absence is not failure. This bounded report does not change capture or refund state."}),
    ))
}

fn bearer(headers: &HeaderMap) -> Result<&str, Error> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(Error::Forbidden)
}
async fn session(State(app): State<App>, headers: HeaderMap) -> Result<Json<Principal>, Error> {
    Ok(Json(app.principal(&headers).await?))
}
async fn logout(State(app): State<App>, headers: HeaderMap) -> Result<StatusCode, Error> {
    app.principal(&headers).await?;
    app.store.revoke(bearer(&headers)?).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn offers() -> Json<Value> {
    Json(
        json!({"offers":super::services::catalog().into_iter().map(|s| json!({"id":s.id,"name":s.name,"unit_price":s.unit_price.decimal(),"currency":"USD","min_documents":s.min_documents,"max_documents":s.max_documents,"allowance_units_per_output":s.allowance_units_per_output,"delivery":s.delivery,"requires_requirements":s.requires_requirements,"sandbox":true})).collect::<Vec<_>>()}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreflightInput {
    service_id: String,
    documents: Vec<Document>,
    requirements: Option<String>,
}
async fn preflight(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<PreflightInput>,
) -> Result<Json<super::services::Preflight>, Error> {
    let p = app.principal(&headers).await?;
    if !matches!(p.role, Role::Buyer | Role::Agent) {
        return Err(Error::Forbidden);
    }
    Ok(Json(super::services::preflight(
        &body.service_id,
        &body.documents,
        body.requirements.as_deref(),
    )?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Objective {
    objective: String,
}
async fn recommend_service(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<Objective>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    if !matches!(p.role, Role::Buyer | Role::Agent) {
        return Err(Error::Forbidden);
    }
    Ok(Json(
        app.ai.recommend(&app.store, &p, &body.objective).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Quote {
    request_id: String,
    #[serde(default)]
    service_id: Option<String>,
    #[serde(default)]
    requirements: Option<String>,
    documents: Vec<Document>,
}
async fn quote(
    State(app): State<App>,
    headers: HeaderMap,
    Json(body): Json<Quote>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    app.purchases()?;
    app.store
        .rate_limit(&format!("quote:{}", p.workspace), 10)
        .await?;
    let fingerprint = if body.service_id.as_deref().unwrap_or(domain::OFFER_VERSION)
        == domain::OFFER_VERSION
        && body.requirements.is_none()
    {
        domain::hash(
            &serde_json::to_vec(&body.documents).map_err(|_| Error::Invalid("Invalid inputs"))?,
        )
    } else {
        domain::hash(
            &serde_json::to_vec(&(
                body.service_id.as_deref().unwrap_or(domain::OFFER_VERSION),
                &body.requirements,
                &body.documents,
            ))
            .map_err(|_| Error::Invalid("Invalid inputs"))?,
        )
    };
    let task = Task::quote_service(
        &p,
        body.documents,
        body.service_id.as_deref().unwrap_or(domain::OFFER_VERSION),
        body.requirements,
    )?;
    Ok(Json(observations::receipt(
        &app.store
            .create(&task, &body.request_id, &fingerprint)
            .await?,
        false,
    )))
}
async fn list(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(
        json!({"tasks":app.store.list(&p).await?.iter().map(|t| observations::receipt(t,false)).collect::<Vec<_>>()}),
    ))
}
async fn read(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(observations::receipt(
        &app.store.get(&id, &p).await?,
        false,
    )))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    digest: String,
}
async fn checkout(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Approval>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    app.purchases()?;
    let (task, key) = app
        .store
        .update(&id, &p, |t| {
            t.buyer(&p)?;
            if t.purchase.is_none() && !t.captured && t.order.is_none() && !super::services::preflight(&t.offer_version, &t.documents, t.requirements.as_deref())?.ready {
                return Err(Error::Invalid("Input preflight failed: every source needs at least 30 alphanumeric characters; check inputs before checkout"));
            }
            t.start_checkout(&p, &body.digest)
        })
        .await?;
    if let Some(key) = key {
        match app.provider.create_order(&id, task.amount, &key).await {
            Ok(value) => {
                app.store
                    .update(&id, &p, |t| observations::order(t, value))
                    .await?;
            }
            Err(_) => {
                app.store
                    .update(&id, &p, |t| {
                        t.order.as_mut().unwrap().unknown();
                        Ok(())
                    })
                    .await?;
            }
        }
    }
    Ok(Json(observations::receipt(
        &app.store.get(&id, &p).await?,
        false,
    )))
}
async fn capture(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Approval>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let task = app.store.get(&id, &p).await?;
    task.buyer(&p)?;
    if body.digest != task.quote_digest || task.approved_at.is_none() {
        return Err(Error::Conflict);
    }
    let task = app.reconcile(&id, &p).await?;
    if task.captured {
        return Ok(Json(observations::receipt(&task, false)));
    }
    let (task, key) = app
        .store
        .update(&id, &p, |t| {
            t.buyer(&p)?;
            if t.capture.is_some() {
                return Ok(None);
            }
            if t.order
                .as_ref()
                .and_then(|o| o.observation.as_ref())
                .and_then(|v| v["status"].as_str())
                != Some("APPROVED")
            {
                return Err(Error::Invalid(
                    "PayPal buyer approval has not been observed",
                ));
            }
            let op = Operation::begin()?;
            let key = op.key.clone();
            t.capture = Some(op);
            Ok(Some(key))
        })
        .await?;
    if let Some(key) = key {
        match app
            .provider
            .capture_order(task.order_id.as_deref().ok_or(Error::Conflict)?, &key)
            .await
        {
            Ok(value) => {
                app.store
                    .update(&id, &p, |t| observations::order(t, value))
                    .await?;
            }
            Err(_) => {
                app.store
                    .update(&id, &p, |t| {
                        t.capture.as_mut().unwrap().unknown();
                        Ok(())
                    })
                    .await?;
            }
        }
    }
    Ok(Json(observations::receipt(
        &app.store.get(&id, &p).await?,
        false,
    )))
}
async fn reconcile(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    Ok(Json(observations::receipt(
        &app.reconcile(&id, &p).await?,
        false,
    )))
}
async fn refund_proposal(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let task = app.store.get(&id, &p).await?;
    let (amount, digest) = task.refund_proposal()?;
    Ok(Json(
        json!({"amount":amount.decimal(),"currency":"USD","digest":digest,"capture_id":task.capture_id,
        "reason":"Refund the failed document units; successful outputs remain charged.","requires_merchant_approval":true}),
    ))
}
async fn refund(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Approval>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let (task, key) = app
        .store
        .update(&id, &p, |t| t.approve_refund(&p, &body.digest))
        .await?;
    if let Some(key) = key {
        match app
            .provider
            .refund_capture(
                task.capture_id.as_deref().ok_or(Error::Conflict)?,
                task.refund_amount,
                &key,
            )
            .await
        {
            Ok(value) => {
                app.store
                    .update(&id, &p, |t| observations::refund(t, value))
                    .await?;
            }
            Err(_) => {
                app.store
                    .update(&id, &p, |t| {
                        t.refund.as_mut().unwrap().unknown();
                        Ok(())
                    })
                    .await?;
            }
        }
    }
    Ok(Json(observations::receipt(
        &app.store.get(&id, &p).await?,
        false,
    )))
}
async fn share(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let (task, _) = app
        .store
        .update(&id, &p, |t| {
            t.buyer(&p)?;
            if t.share_token.is_none() {
                t.share_token = Some(format!("{}{}", domain::random_id()?, domain::random_id()?));
            }
            Ok(())
        })
        .await?;
    Ok(Json(json!({"token":task.share_token})))
}
async fn unshare(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<StatusCode, Error> {
    let p = app.principal(&headers).await?;
    app.store
        .update(&id, &p, |t| {
            t.buyer(&p)?;
            t.share_token = None;
            Ok(())
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn public_receipt(
    State(app): State<App>,
    Path(token): Path<String>,
) -> Result<Json<Value>, Error> {
    Ok(Json(observations::receipt(
        &app.store.shared(&token).await?,
        true,
    )))
}
async fn webhook(
    State(app): State<App>,
    headers: HeaderMap,
    Json(event): Json<Value>,
) -> Result<StatusCode, Error> {
    if !app
        .provider
        .verify_webhook(&headers, event.clone())
        .await
        .map_err(|_| Error::Invalid("Webhook verification unavailable or invalid"))?
    {
        return Err(Error::Forbidden);
    }
    app.store.insert_event(&event).await?;
    // No background loop on Vercel: apply the event now. Anything that cannot
    // be resolved yet stays in the inbox for the cron pass.
    #[cfg(feature = "vercel")]
    if app.process_events().await.is_err() {
        eprintln!("PayPal inbox reconciliation incomplete; events retained");
    }
    Ok(StatusCode::OK)
}

/// One inbox pass for a scheduler, the Vercel stand-in for the 15-second loop
/// in the standalone binary. Off (404) unless CHAINPAY_PAYPAL_CRON_SECRET is set.
async fn cron_events(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    use sha2_010::{Digest, Sha256};
    let secret = std::env::var("CHAINPAY_PAYPAL_CRON_SECRET").unwrap_or_default();
    if secret.len() < 16 {
        return Err(Error::NotFound);
    }
    let given = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("");
    // Hash both sides so the comparison takes the same time whatever was sent.
    if Sha256::digest(given.as_bytes()) != Sha256::digest(secret.as_bytes()) {
        return Err(Error::Forbidden);
    }
    let complete = app.process_events().await.is_ok();
    Ok(Json(json!({"inbox_pass":"done","complete":complete})))
}

#[cfg(test)]
mod tests;

async fn decision(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<super::resolution::Intent>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let (task, _) = app.store.update(&id, &p, |t| t.decide(&p, body)).await?;
    Ok(Json(observations::receipt(&task, false)))
}
async fn rework(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<super::resolution::Intent>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let (task, _) = app.store.update(&id, &p, |t| t.rework(&p, body)).await?;
    Ok(Json(observations::receipt(&task, false)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolutionProposal {
    request_id: String,
    bindings: Vec<super::resolution::Binding>,
    reason: String,
}
async fn resolution_proposal(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ResolutionProposal>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let (task, _) = app
        .store
        .update(&id, &p, |t| {
            t.propose_resolution_refund(&p, &body.request_id, body.bindings, body.reason)
        })
        .await?;
    Ok(Json(observations::receipt(&task, false)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ResolutionApproval {
    request_id: String,
    digest: String,
}
async fn resolution_refund(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<ResolutionApproval>,
) -> Result<Json<Value>, Error> {
    let p = app.principal(&headers).await?;
    let (task, index) = app
        .store
        .update(&id, &p, |t| {
            t.approve_resolution_refund(&p, &body.request_id, &body.digest)
        })
        .await?;
    if let Some(index) = index {
        let refund = &task.refunds[index];
        match app
            .provider
            .resolution_refund(
                task.capture_id.as_deref().ok_or(Error::Conflict)?,
                refund.amount,
                &refund.operation.as_ref().unwrap().key,
            )
            .await
        {
            Ok(value) => {
                app.store
                    .update(&id, &p, |t| observations::ledger_refund(t, index, value))
                    .await?;
            }
            Err(_) => {
                app.store
                    .update(&id, &p, |t| {
                        t.refunds[index].operation.as_mut().unwrap().unknown();
                        Ok(())
                    })
                    .await?;
            }
        }
    }
    Ok(Json(observations::receipt(
        &app.store.get(&id, &p).await?,
        false,
    )))
}
