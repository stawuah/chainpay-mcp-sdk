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
    async fn principal(&self, headers: &HeaderMap) -> Result<Principal, Error> {
        let token = bearer(headers)?;
        let p = self.store.authenticate(token).await?;
        self.store
            .rate_limit(&format!("api:{}:{}", p.workspace, p.id), 120)
            .await?;
        Ok(p)
    }
    fn purchases(&self) -> Result<(), Error> {
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
        self.store.get(id, p).await
    }

    /// Inbox workers only perform reads; they can never dispatch a charge/refund.
    pub async fn process_events(&self) -> Result<(), Error> {
        for event in self.store.pending_events().await? {
            let resource = &event["resource"];
            let mut ids = Vec::new();
            for value in [
                resource.get("id"),
                resource.get("custom_id"),
                resource.pointer("/supplementary_data/related_ids/order_id"),
                resource.pointer("/supplementary_data/related_ids/capture_id"),
            ] {
                if let Some(id) = value.and_then(Value::as_str) {
                    ids.push(id.to_string());
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
                // Recover a lost create response via the verified event's order ID.
                if task.order_id.is_none()
                    && event["event_type"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("CHECKOUT.ORDER."))
                {
                    if let Some(order_id) = resource["id"].as_str() {
                        match self.provider.order(order_id).await {
                            Ok(value) => {
                                self.store
                                    .update(&task.id, &p, |t| observations::order(t, value))
                                    .await?;
                            }
                            Err(_) => {
                                resolved = false;
                                continue;
                            }
                        }
                    }
                }
                if event["event_type"] == "PAYMENT.CAPTURE.REFUNDED" && task.refund.is_some() {
                    if let Some(refund_id) = resource["id"].as_str() {
                        match self.provider.refund(refund_id).await {
                            Ok(value) => {
                                self.store
                                    .update(&task.id, &p, |t| observations::refund(t, value))
                                    .await?;
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

pub fn router(app: App) -> Router {
    let origin: axum::http::HeaderValue =
        app.config.public_origin.parse().expect("validated origin");
    Router::new()
        .route("/healthz",get(|| async { Json(json!({"status":"ready","service":"chainpay-paypal","sandbox":true,"provider_acceptance":"unverified"})) }))
        .route("/v1/paypal/session",get(session).delete(logout))
        .route("/v1/paypal/offers",get(offers))
        .route("/v1/paypal/tasks",get(list).post(quote))
        .route("/v1/paypal/tasks/{id}",get(read))
        .route("/v1/paypal/tasks/{id}/checkout",post(checkout))
        .route("/v1/paypal/tasks/{id}/capture",post(capture))
        .route("/v1/paypal/tasks/{id}/reconcile",post(reconcile))
        .route("/v1/paypal/tasks/{id}/refund-proposal",get(refund_proposal))
        .route("/v1/paypal/tasks/{id}/refund",post(refund))
        .route("/v1/paypal/tasks/{id}/share",post(share).delete(unshare))
        .route("/v1/paypal/receipts/{token}",get(public_receipt))
        .route("/v1/paypal/webhooks",post(webhook))
        .layer(DefaultBodyLimit::max(200_000))
        .layer(CorsLayer::new().allow_origin(origin).allow_methods([axum::http::Method::GET,axum::http::Method::POST,axum::http::Method::DELETE]).allow_headers([header::AUTHORIZATION,header::CONTENT_TYPE]))
        .layer(axum::middleware::map_response(|mut response: Response| async move {
            response.headers_mut().insert(header::CACHE_CONTROL,"no-store".parse().unwrap());
            response.headers_mut().insert(header::REFERRER_POLICY,"no-referrer".parse().unwrap());
            response
        }))
        .with_state(app)
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
        json!({"offers":[{"id":domain::OFFER_VERSION,"name":"Evidence-linked document summary","unit_price":"4.00","currency":"USD","max_documents":10,"delivery":"Summary and claims with exact source excerpts per readable document","sandbox":true}]}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Quote {
    request_id: String,
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
    let fingerprint = domain::hash(
        &serde_json::to_vec(&body.documents).map_err(|_| Error::Invalid("Invalid inputs"))?,
    );
    let task = Task::quote(&p, body.documents)?;
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
        .update(&id, &p, |t| t.start_checkout(&p, &body.digest))
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
    Ok(StatusCode::OK)
}

#[cfg(test)]
mod tests;
