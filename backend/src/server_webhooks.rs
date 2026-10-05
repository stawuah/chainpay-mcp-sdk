//! Owner webhook routes (docs/guides/owner-webhooks.md). Owner session only:
//! a scoped agent connection can neither read nor change where an owner's
//! payment notifications go. With `OWNER_WEBHOOKS_ENABLED` off every route
//! answers 404.
use super::*;
use crate::storage::{
    RedeliverResult, WebhookDelivery, WebhookDeliveryState, WebhookSubscription,
    WebhookSubscriptionStatus,
};
use crate::webhooks::{self as hooks, OwnerWebhooks, dispatch, ssrf};
use axum::http::HeaderMap;
use serde::Deserialize;
use std::sync::Arc;

pub(super) const DISPATCH_PATH: &str = "/internal/cron/webhooks/dispatch";
/// Owner mutations per minute (register, rotate, disable, redeliver).
const WRITE_RATE_PER_MINUTE: u64 = 20;

/// The dispatcher authenticates itself with `CRON_SECRET`.
pub(super) fn is_self_authenticated(path: &str) -> bool {
    path == DISPATCH_PATH
}

pub(super) fn router() -> Router<BackendState> {
    Router::new()
        .route("/v1/webhooks", get(list).post(create))
        .route("/v1/webhooks/{subscription_id}/disable", post(disable))
        .route("/v1/webhooks/{subscription_id}/rotate", post(rotate))
        .route("/v1/webhooks/{subscription_id}/deliveries", get(deliveries))
        .route(
            "/v1/webhook-deliveries/{delivery_id}/redeliver",
            post(redeliver),
        )
        .route(DISPATCH_PATH, get(dispatch_now).post(dispatch_now))
}

fn enabled(state: &BackendState) -> Result<Arc<OwnerWebhooks>, ApiError> {
    state.webhooks.clone().ok_or(ApiError::NotFound)
}

async fn writable(state: &BackendState, principal: &Principal) -> Result<(), ApiError> {
    if !state
        .store
        .auth_rate(
            &format!("webhooks:{}", principal.wallet),
            now_ms(),
            WRITE_RATE_PER_MINUTE,
        )
        .await?
    {
        return Err(ApiError::RateLimited);
    }
    Ok(())
}

fn subscription_view(subscription: &WebhookSubscription, now: u64) -> Value {
    json!({
        "id": subscription.subscription_id,
        "url": subscription.url,
        "description": subscription.description,
        "status": subscription.status,
        "created_at_ms": subscription.created_at_ms,
        "updated_at_ms": subscription.updated_at_ms,
        "previous_secret_expires_at_ms": OwnerWebhooks::previous_secret_expiry(&subscription.secrets, now),
    })
}

fn delivery_view(delivery: &WebhookDelivery) -> Value {
    let scheduled = matches!(
        delivery.state,
        WebhookDeliveryState::Pending | WebhookDeliveryState::RetryScheduled
    );
    json!({
        "id": delivery.delivery_id,
        "event_id": delivery.event_id,
        "event_type": delivery.event_type,
        "receipt_address": delivery.receipt_address,
        "state": delivery.state,
        "attempts": delivery.attempts,
        "next_attempt_at_ms": scheduled.then_some(delivery.next_attempt_at_ms),
        "last_status": delivery.last_status,
        "last_error": delivery.last_error,
        "delivered_at_ms": delivery.delivered_at_ms,
        "created_at_ms": delivery.created_at_ms,
        "updated_at_ms": delivery.updated_at_ms,
    })
}

async fn list(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<Value>, ApiError> {
    enabled(&state)?;
    auth::owner(&principal, &principal.wallet)?;
    let now = now_ms();
    let rows = state
        .store
        .list_webhook_subscriptions(&principal.wallet)
        .await?;
    Ok(Json(json!({
        "subscriptions": rows.iter().map(|s| subscription_view(s, now)).collect::<Vec<_>>(),
        "max_active": hooks::MAX_ACTIVE_SUBSCRIPTIONS,
        "max_attempts": dispatch::MAX_ATTEMPTS,
    })))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CreateRequest {
    url: String,
    #[serde(default)]
    description: Option<String>,
}

async fn create(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<CreateRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let webhooks = enabled(&state)?;
    auth::owner(&principal, &principal.wallet)?;
    writable(&state, &principal).await?;
    let description = request
        .description
        .map(|d| d.trim().to_owned())
        .filter(|d| !d.is_empty());
    if description
        .as_deref()
        .is_some_and(|d| d.chars().count() > 80 || d.chars().any(char::is_control))
    {
        return Err(ApiError::BadRequest(
            "Label must be 80 characters or fewer".into(),
        ));
    }
    let url = ssrf::validate_url(&request.url)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    // Check the destination now too; it is checked again before every send.
    ssrf::resolve_public(webhooks.resolver.as_ref(), &url)
        .await
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let now = now_ms();
    let id = hooks::subscription_id();
    let secret = OwnerWebhooks::generate_secret();
    let subscription = WebhookSubscription {
        subscription_id: id.clone(),
        owner_wallet: principal.wallet.clone(),
        url: url.to_string(),
        description,
        status: WebhookSubscriptionStatus::Active,
        secrets: webhooks.initial_secrets(&id, &secret, now),
        created_at_ms: now,
        updated_at_ms: now,
    };
    if !state
        .store
        .create_webhook_subscription(subscription.clone(), hooks::MAX_ACTIVE_SUBSCRIPTIONS)
        .await?
    {
        return Err(ApiError::Conflict(format!(
            "You can have {} active endpoints. Disable one first.",
            hooks::MAX_ACTIVE_SUBSCRIPTIONS
        )));
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "subscription": subscription_view(&subscription, now),
            // Shown once. Only a sealed copy is stored.
            "secret": secret,
        })),
    ))
}

async fn disable(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(subscription_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    enabled(&state)?;
    auth::owner(&principal, &principal.wallet)?;
    writable(&state, &principal).await?;
    let now = now_ms();
    let subscription = state
        .store
        .disable_webhook_subscription(&principal.wallet, &subscription_id, now)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(
        json!({"subscription": subscription_view(&subscription, now)}),
    ))
}

async fn rotate(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(subscription_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let webhooks = enabled(&state)?;
    auth::owner(&principal, &principal.wallet)?;
    writable(&state, &principal).await?;
    let current = state
        .store
        .get_webhook_subscription(&principal.wallet, &subscription_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if current.status != WebhookSubscriptionStatus::Active {
        return Err(ApiError::Conflict(
            "This endpoint is disabled. Add a new endpoint instead.".into(),
        ));
    }
    let now = now_ms();
    let secret = OwnerWebhooks::generate_secret();
    let (secrets, overlap) =
        webhooks.rotated_secrets(&subscription_id, &current.secrets, &secret, now);
    let subscription = state
        .store
        .rotate_webhook_secrets(&principal.wallet, &subscription_id, secrets, now)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(json!({
        "subscription": subscription_view(&subscription, now),
        "secret": secret,
        "previous_secret_expires_at_ms": overlap,
    })))
}

#[derive(Deserialize)]
pub(super) struct DeliveriesQuery {
    #[serde(default)]
    limit: Option<usize>,
}

async fn deliveries(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(subscription_id): Path<String>,
    Query(query): Query<DeliveriesQuery>,
) -> Result<Json<Value>, ApiError> {
    enabled(&state)?;
    auth::owner(&principal, &principal.wallet)?;
    // Another owner's endpoint reads as absent, not as an empty history.
    state
        .store
        .get_webhook_subscription(&principal.wallet, &subscription_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rows = state
        .store
        .list_webhook_deliveries(
            &principal.wallet,
            &subscription_id,
            query.limit.unwrap_or(25),
        )
        .await?;
    Ok(Json(
        json!({"deliveries": rows.iter().map(delivery_view).collect::<Vec<_>>()}),
    ))
}

async fn redeliver(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(delivery_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    enabled(&state)?;
    auth::owner(&principal, &principal.wallet)?;
    writable(&state, &principal).await?;
    match state
        .store
        .redeliver_webhook(&principal.wallet, &delivery_id, now_ms())
        .await?
    {
        RedeliverResult::Scheduled(delivery) => {
            Ok(Json(json!({"delivery": delivery_view(&delivery)})))
        }
        RedeliverResult::NotFound => Err(ApiError::NotFound),
        RedeliverResult::InFlight => Err(ApiError::Conflict(
            "This delivery is already queued or being sent.".into(),
        )),
        RedeliverResult::EndpointDisabled => Err(ApiError::Conflict(
            "This endpoint is disabled, so nothing can be sent to it.".into(),
        )),
    }
}

/// Bearer `CRON_SECRET`. One bounded pass; the report holds counts only.
async fn dispatch_now(State(state): State<BackendState>, headers: HeaderMap) -> Response {
    let Some(webhooks) = state.webhooks.clone() else {
        return ApiError::NotFound.into_response();
    };
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if !crate::connectors::card_issuer::routes::bearer_matches(
        auth,
        webhooks.cron_secret.as_deref(),
    ) {
        return ApiError::Unauthorized.into_response();
    }
    let report = dispatch::run(&state, webhooks, std::time::Duration::from_secs(50)).await;
    (StatusCode::OK, Json(json!(report))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connectors::inbox::{StandardWebhooks, WebhookVerifier};
    use crate::storage::{DeliveryOutcome, WebhookEvent};
    use crate::webhooks::test_support::{self, CRON};
    use crate::webhooks::{ReceiptReady, dispatch::LEASE_MS};
    use std::sync::{
        Mutex,
        atomic::{AtomicU8, Ordering},
    };

    const OWNER: &str = "OwnerA1111111111111111111111111111111111111";
    const OTHER: &str = "OwnerB2222222222222222222222222222222222222";

    /// A controlled receiver: verifies nothing itself, records what arrived.
    #[derive(Default)]
    struct Receiver {
        /// 0 = 204, 1 = 500, 2 = 429 + Retry-After 120, 3 = store, then answer
        /// after the sender's timeout, 4 = 302 to elsewhere.
        mode: AtomicU8,
        seen: Mutex<Vec<(HeaderMap, Vec<u8>)>>,
    }

    async fn receiver() -> (Arc<Receiver>, SocketAddr, tokio::task::JoinHandle<()>) {
        let shared = Arc::new(Receiver::default());
        let inner = shared.clone();
        let app = Router::new().fallback(move |headers: HeaderMap, body: axum::body::Bytes| {
            let inner = inner.clone();
            async move {
                inner.seen.lock().unwrap().push((headers, body.to_vec()));
                match inner.mode.load(Ordering::SeqCst) {
                    0 => StatusCode::NO_CONTENT.into_response(),
                    1 => (StatusCode::INTERNAL_SERVER_ERROR, "boom").into_response(),
                    2 => (
                        StatusCode::TOO_MANY_REQUESTS,
                        [(header::RETRY_AFTER, "120")],
                    )
                        .into_response(),
                    3 => {
                        tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
                        StatusCode::OK.into_response()
                    }
                    _ => (
                        StatusCode::FOUND,
                        [(header::LOCATION, "http://169.254.169.254/")],
                    )
                        .into_response(),
                }
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (shared, address, task)
    }

    fn state_with(hooks: OwnerWebhooks) -> BackendState {
        let mut state =
            BackendState::new(BackendConfig::from_env().unwrap(), StatusStore::in_memory())
                .unwrap();
        state.webhooks = Some(Arc::new(hooks));
        state
    }

    fn owner(wallet: &str) -> Principal {
        Principal {
            wallet: wallet.into(),
            scope: None,
        }
    }

    async fn register(state: &BackendState, wallet: &str) -> (String, String) {
        let (status, Json(body)) = create(
            State(state.clone()),
            Extension(owner(wallet)),
            Json(CreateRequest {
                url: "https://hooks.example.com/chainpay".into(),
                description: Some("Books".into()),
            }),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        (
            body["subscription"]["id"].as_str().unwrap().to_owned(),
            body["secret"].as_str().unwrap().to_owned(),
        )
    }

    async fn emit(state: &BackendState, wallet: &str, receipt: &str) -> WebhookEvent {
        let hooks = state.webhooks.clone().unwrap();
        let event = hooks.receipt_ready_event(
            wallet,
            &ReceiptReady {
                operation_id: format!("payment_{receipt}"),
                operation_kind: "payment",
                cluster: "devnet".into(),
                receipt_address: receipt.into(),
                mint: Some("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU".into()),
                amount: Some(4_500_000),
                decimals: Some(6),
            },
            now_ms(),
        );
        assert_eq!(
            state
                .store
                .emit_webhook_events(std::slice::from_ref(&event))
                .await
                .unwrap(),
            1
        );
        event
    }

    /// One attempt of whatever is due by `at`, as the dispatcher makes it.
    async fn attempt(state: &BackendState, at: u64) -> Vec<DeliveryOutcome> {
        let hooks = state.webhooks.clone().unwrap();
        let claimed = state
            .store
            .claim_webhook_deliveries(at, 10, LEASE_MS, "t", dispatch::MAX_ATTEMPTS)
            .await
            .unwrap();
        let mut outcomes = Vec::new();
        for item in claimed {
            let outcome = dispatch::deliver(&hooks, &item, at).await;
            assert!(
                state
                    .store
                    .complete_webhook_delivery(&item.delivery.delivery_id, "t", &outcome, at)
                    .await
                    .unwrap()
            );
            outcomes.push(outcome);
        }
        outcomes
    }

    /// The documented receiver check, with the receiver's clock at the
    /// moment of sending (attempts below run at simulated future times).
    fn verified(secret: &str, headers: &HeaderMap, body: &[u8]) -> String {
        let now: i64 = headers["webhook-timestamp"]
            .to_str()
            .unwrap()
            .parse()
            .unwrap();
        StandardWebhooks::new(secret)
            .unwrap()
            .verify(headers, body, now)
            .expect("signature and timestamp verify")
            .event_id
    }

    #[tokio::test]
    async fn receiver_outcomes_map_to_delivery_states_and_keep_the_event_id() {
        let (receiver, address, task) = receiver().await;
        let (hooks, transport) = test_support::webhooks(address);
        let state = state_with(hooks);
        let (subscription, secret) = register(&state, OWNER).await;
        let event = emit(&state, OWNER, "Rcpt1").await;

        // 500: retry scheduled with the status; the payment is untouched.
        receiver.mode.store(1, Ordering::SeqCst);
        let now = now_ms();
        let outcome = attempt(&state, now).await;
        assert!(
            matches!(&outcome[..], [DeliveryOutcome::Retry { status: Some(500), next_attempt_at_ms, .. }] if *next_attempt_at_ms >= now + 48_000)
        );

        // 429 + Retry-After: the next attempt waits at least that long.
        receiver.mode.store(2, Ordering::SeqCst);
        let later = now + 24 * 3_600_000;
        let outcome = attempt(&state, later).await;
        assert!(
            matches!(&outcome[..], [DeliveryOutcome::Retry { status: Some(429), next_attempt_at_ms, .. }] if *next_attempt_at_ms >= later + 120_000)
        );

        // Receiver stores the event but answers after the timeout: a retry
        // with the same event id, which the receiver dedupes.
        receiver.mode.store(3, Ordering::SeqCst);
        let later = later + 24 * 3_600_000;
        let outcome = attempt(&state, later).await;
        assert!(
            matches!(&outcome[..], [DeliveryOutcome::Retry { status: None, error, .. }] if error.contains("may still have processed"))
        );

        // 2xx: delivered.
        receiver.mode.store(0, Ordering::SeqCst);
        let later = later + 24 * 3_600_000;
        assert!(matches!(
            &attempt(&state, later).await[..],
            [DeliveryOutcome::Delivered { status: 204 }]
        ));
        let Json(history) = deliveries(
            State(state.clone()),
            Extension(owner(OWNER)),
            Path(subscription.clone()),
            Query(DeliveriesQuery { limit: None }),
        )
        .await
        .unwrap();
        assert_eq!(history["deliveries"][0]["state"], "delivered");
        assert_eq!(history["deliveries"][0]["attempts"], 4);

        // Every attempt: same id, same bytes, a valid signature; a receiver
        // that dedupes by webhook-id processes the event once.
        let seen = receiver.seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 4);
        let mut processed = std::collections::HashSet::new();
        for (headers, body) in &seen {
            assert_eq!(body, event.body.as_bytes());
            assert_eq!(headers["content-type"], "application/json");
            processed.insert(verified(&secret, headers, body));
        }
        assert_eq!(
            processed.into_iter().collect::<Vec<_>>(),
            vec![event.event_id.clone()]
        );
        // Every connection went to the address checked at dispatch.
        assert!(
            transport
                .pinned
                .lock()
                .unwrap()
                .iter()
                .all(|a| a.to_string() == "93.184.216.34:443")
        );

        // Manual redelivery: same event id, a new attempt.
        let Json(again) = redeliver(
            State(state.clone()),
            Extension(owner(OWNER)),
            Path(history["deliveries"][0]["id"].as_str().unwrap().to_owned()),
        )
        .await
        .unwrap();
        assert_eq!(again["delivery"]["state"], "pending");
        assert!(matches!(
            &attempt(&state, now_ms()).await[..],
            [DeliveryOutcome::Delivered { .. }]
        ));
        let seen = receiver.seen.lock().unwrap();
        assert_eq!(verified(&secret, &seen[4].0, &seen[4].1), event.event_id);
        task.abort();
    }

    #[tokio::test]
    async fn redirects_and_dns_changes_are_refused_at_dispatch() {
        let (receiver, address, task) = receiver().await;
        let (hooks, _, resolver) = test_support::webhooks_with_resolver(address);
        let state = state_with(hooks);
        register(&state, OWNER).await;
        emit(&state, OWNER, "Rcpt2").await;
        receiver.mode.store(4, Ordering::SeqCst);
        let outcome = attempt(&state, now_ms()).await;
        assert!(
            matches!(&outcome[..], [DeliveryOutcome::Retry { status: Some(302), error, .. }] if error.contains("redirects are not followed"))
        );
        // The host now resolves to the metadata address: nothing is sent.
        *resolver.0.lock().unwrap() = vec!["169.254.169.254".parse().unwrap()];
        let sent = receiver.seen.lock().unwrap().len();
        let outcome = attempt(&state, now_ms() + 86_400_000).await;
        assert!(
            matches!(&outcome[..], [DeliveryOutcome::Exhausted { status: None, error }] if error.contains("not a public"))
        );
        assert_eq!(receiver.seen.lock().unwrap().len(), sent);
        // Registration refuses unsafe destinations outright.
        for url in [
            "http://hooks.example.com/",
            "https://127.0.0.1/",
            "https://[::1]/",
            "https://169.254.169.254/latest/meta-data/",
            "https://localhost/",
            "https://user:pw@hooks.example.com/",
            "https://hooks.example.com/", // resolves to the metadata address now
        ] {
            let result = create(
                State(state.clone()),
                Extension(owner(OTHER)),
                Json(CreateRequest {
                    url: url.into(),
                    description: None,
                }),
            )
            .await;
            assert!(matches!(result, Err(ApiError::BadRequest(_))), "{url}");
        }
        task.abort();
    }

    #[tokio::test]
    async fn crashed_and_overlapping_dispatchers_lose_nothing_and_send_once() {
        let (receiver, address, task) = receiver().await;
        let (hooks, _) = test_support::webhooks(address);
        let state = state_with(hooks);
        let (_, secret) = register(&state, OWNER).await;
        let mut ids = Vec::new();
        for n in 0..6 {
            ids.push(emit(&state, OWNER, &format!("Crash{n}")).await.event_id);
        }
        // A dispatcher leased two rows and died before recording anything.
        let crashed = state
            .store
            .claim_webhook_deliveries(now_ms(), 2, 1, "dead", dispatch::MAX_ATTEMPTS)
            .await
            .unwrap();
        assert_eq!(crashed.len(), 2);
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        // Two scheduler invocations overlap.
        let hooks = state.webhooks.clone().unwrap();
        let (a, b) = tokio::join!(
            dispatch::run(&state, hooks.clone(), std::time::Duration::from_secs(30)),
            dispatch::run(&state, hooks.clone(), std::time::Duration::from_secs(30))
        );
        assert_eq!(a.delivered + b.delivered, 6);
        assert_eq!(a.claimed + b.claimed, 6);
        let seen = receiver.seen.lock().unwrap();
        assert_eq!(seen.len(), 6, "each event sent exactly once");
        let mut got: Vec<_> = seen.iter().map(|(h, b)| verified(&secret, h, b)).collect();
        got.sort();
        ids.sort();
        assert_eq!(got, ids);
        // The dead dispatcher's late result is refused.
        assert!(
            !state
                .store
                .complete_webhook_delivery(
                    &crashed[0].delivery.delivery_id,
                    "dead",
                    &DeliveryOutcome::Exhausted {
                        status: None,
                        error: "late".into()
                    },
                    now_ms()
                )
                .await
                .unwrap()
        );
        task.abort();
    }

    #[tokio::test]
    async fn every_route_is_owner_scoped() {
        let (_, address, task) = receiver().await;
        let (hooks, _) = test_support::webhooks(address);
        let state = state_with(hooks);
        let (subscription, _) = register(&state, OWNER).await;
        emit(&state, OWNER, "Scoped").await;
        let Json(rows) = deliveries(
            State(state.clone()),
            Extension(owner(OWNER)),
            Path(subscription.clone()),
            Query(DeliveriesQuery { limit: None }),
        )
        .await
        .unwrap();
        let delivery = rows["deliveries"][0]["id"].as_str().unwrap().to_owned();

        // Another owner sees nothing and changes nothing.
        let Json(listed) = list(State(state.clone()), Extension(owner(OTHER)))
            .await
            .unwrap();
        assert_eq!(listed["subscriptions"], json!([]));
        assert!(matches!(
            disable(
                State(state.clone()),
                Extension(owner(OTHER)),
                Path(subscription.clone())
            )
            .await,
            Err(ApiError::NotFound)
        ));
        assert!(matches!(
            rotate(
                State(state.clone()),
                Extension(owner(OTHER)),
                Path(subscription.clone())
            )
            .await,
            Err(ApiError::NotFound)
        ));
        assert!(matches!(
            deliveries(
                State(state.clone()),
                Extension(owner(OTHER)),
                Path(subscription.clone()),
                Query(DeliveriesQuery { limit: None })
            )
            .await,
            Err(ApiError::NotFound)
        ));
        assert!(matches!(
            redeliver(
                State(state.clone()),
                Extension(owner(OTHER)),
                Path(delivery.clone())
            )
            .await,
            Err(ApiError::NotFound)
        ));

        // An agent connection for the same wallet is refused on every route.
        let agent = Principal {
            wallet: OWNER.into(),
            scope: Some(json!({"version":1})),
        };
        assert!(matches!(
            list(State(state.clone()), Extension(agent.clone())).await,
            Err(ApiError::Forbidden(_))
        ));
        assert!(matches!(
            create(
                State(state.clone()),
                Extension(agent.clone()),
                Json(CreateRequest {
                    url: "https://hooks.example.com/".into(),
                    description: None
                })
            )
            .await,
            Err(ApiError::Forbidden(_))
        ));
        assert!(matches!(
            disable(
                State(state.clone()),
                Extension(agent.clone()),
                Path(subscription.clone())
            )
            .await,
            Err(ApiError::Forbidden(_))
        ));
        assert!(matches!(
            rotate(
                State(state.clone()),
                Extension(agent.clone()),
                Path(subscription.clone())
            )
            .await,
            Err(ApiError::Forbidden(_))
        ));
        assert!(matches!(
            deliveries(
                State(state.clone()),
                Extension(agent.clone()),
                Path(subscription.clone()),
                Query(DeliveriesQuery { limit: None })
            )
            .await,
            Err(ApiError::Forbidden(_))
        ));
        assert!(matches!(
            redeliver(
                State(state.clone()),
                Extension(agent),
                Path(delivery.clone())
            )
            .await,
            Err(ApiError::Forbidden(_))
        ));

        // The owner still can.
        let Json(rotated) = rotate(
            State(state.clone()),
            Extension(owner(OWNER)),
            Path(subscription.clone()),
        )
        .await
        .unwrap();
        assert!(rotated["secret"].as_str().unwrap().starts_with("whsec_"));
        assert!(rotated["previous_secret_expires_at_ms"].as_u64().is_some());
        let Json(listed) = list(State(state.clone()), Extension(owner(OWNER)))
            .await
            .unwrap();
        assert_eq!(listed["subscriptions"].as_array().unwrap().len(), 1);
        assert!(
            !listed.to_string().contains("envelope"),
            "sealed secrets never leave storage"
        );
        let Json(disabled) = disable(
            State(state.clone()),
            Extension(owner(OWNER)),
            Path(subscription.clone()),
        )
        .await
        .unwrap();
        assert_eq!(disabled["subscription"]["status"], "disabled");
        assert!(matches!(
            rotate(
                State(state.clone()),
                Extension(owner(OWNER)),
                Path(subscription)
            )
            .await,
            Err(ApiError::Conflict(_))
        ));

        // Through the real router: owner routes need a session, the
        // dispatcher needs CRON_SECRET, and switched-off reads as absent.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let served = state.clone();
        let api = tokio::spawn(async move {
            axum::serve(
                listener,
                build_router(served).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap()
        });
        let http = reqwest::Client::new();
        assert_eq!(
            http.get(format!("{base}/v1/webhooks"))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            http.post(format!("{base}{DISPATCH_PATH}"))
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        assert_eq!(
            http.post(format!("{base}{DISPATCH_PATH}"))
                .bearer_auth("wrong-secret-of-length")
                .send()
                .await
                .unwrap()
                .status(),
            401
        );
        let ok = http
            .post(format!("{base}{DISPATCH_PATH}"))
            .bearer_auth(CRON)
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), 200);
        let report: Value = ok.json().await.unwrap();
        assert!(report["claimed"].is_number());
        api.abort();
        let mut off = state.clone();
        off.webhooks = None;
        assert!(matches!(
            list(State(off.clone()), Extension(owner(OWNER))).await,
            Err(ApiError::NotFound)
        ));
        assert_eq!(
            dispatch_now(State(off), HeaderMap::new()).await.status(),
            StatusCode::NOT_FOUND
        );
        task.abort();
    }

    #[tokio::test]
    async fn endpoints_are_capped_per_owner() {
        let (_, address, task) = receiver().await;
        let (hooks, _) = test_support::webhooks(address);
        let state = state_with(hooks);
        for _ in 0..hooks::MAX_ACTIVE_SUBSCRIPTIONS {
            register(&state, OWNER).await;
        }
        let refused = create(
            State(state.clone()),
            Extension(owner(OWNER)),
            Json(CreateRequest {
                url: "https://hooks.example.com/".into(),
                description: None,
            }),
        )
        .await;
        assert!(matches!(refused, Err(ApiError::Conflict(_))));
        // Another owner is unaffected.
        register(&state, OTHER).await;
        task.abort();
    }
}
