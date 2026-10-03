//! Axum glue for the private agent card connector (contracts.md §3). With
//! `CARDS_CONNECTOR_ENABLED` off every route answers 404, as if absent.
use super::*;
use crate::connectors::card_issuer::{
    self as cards, CardsConnector, checkout,
    routes::{self, Caller, CardsError},
};
use axum::{body::Bytes, http::HeaderMap};
use std::sync::Arc;

/// Token hash of a scoped MCP connection (never the token itself), attached
/// by the auth middleware for card agent identity.
#[derive(Clone, Debug)]
pub(super) struct ConnectionHash(pub Option<String>);

/// Paths that authenticate themselves (provider signature, cron or runner
/// secret) instead of an owner session.
pub(super) fn is_self_authenticated(path: &str) -> bool {
    matches!(
        path,
        "/v1/cards/lithic/asa"
            | "/v1/cards/lithic/events"
            | "/v1/cards/checkout/redeem"
            | "/internal/cron/cards/reconcile"
    )
}

fn connector(state: &BackendState) -> Result<Arc<CardsConnector>, Response> {
    state.cards.clone().ok_or_else(|| {
        (StatusCode::NOT_FOUND, Json(json!({"code":"not_found","message":"Not found","retryable":false,"evidenceState":"none"}))).into_response()
    })
}

fn caller(principal: &Principal, connection: Option<&ConnectionHash>) -> Caller {
    Caller {
        wallet: principal.wallet.clone(),
        scope: principal.scope.clone(),
        connection: connection.and_then(|c| c.0.clone()),
    }
}

fn respond(result: Result<Value, CardsError>) -> Response {
    match result {
        Ok(value) => (StatusCode::OK, Json(value)).into_response(),
        Err(error) => error.into_response(),
    }
}

fn parse_body<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, CardsError> {
    serde_json::from_slice(body).map_err(|_| {
        CardsError::bad(
            "invalid_body",
            "Request body does not match the contract schema",
        )
    })
}

macro_rules! cards_or_404 {
    ($state:expr) => {
        match connector(&$state) {
            Ok(cards) => cards,
            Err(response) => return response,
        }
    };
}

pub(super) async fn asa(
    State(state): State<BackendState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    cards::asa::handle(cards, headers, &body).await
}

pub(super) async fn events(
    State(state): State<BackendState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    cards::events::handle(cards, headers, &body).await
}

pub(super) async fn reconcile(State(state): State<BackendState>, headers: HeaderMap) -> Response {
    let cards = cards_or_404!(state);
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if !routes::bearer_matches(auth, cards.config.cron_secret.as_deref()) {
        return CardsError {
            status: StatusCode::UNAUTHORIZED,
            ..CardsError::forbidden("Cron authorization required")
        }
        .into_response();
    }
    let report = cards::reconcile::run(&cards, std::time::Duration::from_secs(50)).await;
    (StatusCode::OK, Json(json!(report))).into_response()
}

pub(super) async fn redeem(
    State(state): State<BackendState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if !routes::bearer_matches(auth, cards.config.runner_secret.as_deref()) {
        return CardsError {
            status: StatusCode::UNAUTHORIZED,
            ..CardsError::forbidden("Checkout runner authorization required")
        }
        .into_response();
    }
    respond(match parse_body(&body) {
        Ok(request) => checkout::redeem(&cards, request).await,
        Err(error) => Err(error),
    })
}

pub(super) async fn prepare(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    let request = match parse_body(&body) {
        Ok(request) => request,
        Err(error) => return error.into_response(),
    };
    let blockhash = match state.rpc.latest_blockhash().await {
        Ok(latest) => match bs58::decode(&latest.blockhash)
            .into_vec()
            .ok()
            .and_then(|v| <[u8; 32]>::try_from(v).ok())
        {
            Some(hash) => hash,
            None => {
                return CardsError::unavailable(
                    "rpc_unavailable",
                    "Solana RPC returned an invalid blockhash",
                )
                .into_response();
            }
        },
        Err(_) => {
            return CardsError::unavailable("rpc_unavailable", "Solana RPC is unavailable; retry")
                .into_response();
        }
    };
    respond(routes::prepare(&cards, &caller, request, blockhash).await)
}

pub(super) async fn list(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
) -> Response {
    let cards = cards_or_404!(state);
    respond(routes::list_cards(&cards, &caller(&principal, connection.as_deref())).await)
}

pub(super) async fn merchants(State(state): State<BackendState>) -> Response {
    let _cards = cards_or_404!(state);
    (StatusCode::OK, Json(routes::merchants())).into_response()
}

pub(super) async fn attestation(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
) -> Response {
    let cards = cards_or_404!(state);
    if principal.scope.is_some() {
        return CardsError::forbidden("Owner session required").into_response();
    }
    let mut status = cards.attestation().await;
    if status.checked_at_ms == 0 {
        status = cards.refresh_attestation().await;
    }
    (StatusCode::OK, Json(json!(status))).into_response()
}

/// Public base-layer commitment for the card view (never private bytes).
async fn commitment(
    state: &BackendState,
    card: &crate::storage::StoredCardRecord,
) -> Option<Value> {
    let address = card.record["commitmentPda"].as_str()?;
    let account = state.rpc.account_info(address).await.ok()??;
    let decoded = cards::program::decode_commitment(&account.data).ok()?;
    (decoded.seq > 0).then(|| json!({"seq": decoded.seq.to_string(), "root": cards::program::hex(&decoded.root), "slot": decoded.written_slot.to_string()}))
}

pub(super) async fn get_card(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    let card = match routes::owned_card(&cards, &caller, &card_id).await {
        Ok(card) => card,
        Err(error) => return error.into_response(),
    };
    let commitment = commitment(&state, &card).await;
    (
        StatusCode::OK,
        Json(routes::card_view(&cards, &card, commitment)),
    )
        .into_response()
}

pub(super) async fn activate(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    respond(match parse_body(&body) {
        Ok(request) => routes::activate(&cards, &caller, &card_id, request).await,
        Err(error) => Err(error),
    })
}

pub(super) async fn freeze(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    respond(match parse_body(&body) {
        Ok(request) => routes::freeze(&cards, &caller, &card_id, request).await,
        Err(error) => Err(error),
    })
}

pub(super) async fn unfreeze_mirror(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    respond(match parse_body(&body) {
        Ok(request) => routes::unfreeze_mirror(&cards, &caller, &card_id, request).await,
        Err(error) => Err(error),
    })
}

pub(super) async fn embed(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
) -> Response {
    let cards = cards_or_404!(state);
    respond(
        routes::embed_session(&cards, &caller(&principal, connection.as_deref()), &card_id).await,
    )
}

#[derive(serde::Deserialize)]
pub(super) struct ActivityQuery {
    cursor: Option<String>,
    limit: Option<u32>,
}

pub(super) async fn activity(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
    Query(query): Query<ActivityQuery>,
) -> Response {
    let cards = cards_or_404!(state);
    respond(
        routes::activity(
            &cards,
            &caller(&principal, connection.as_deref()),
            &card_id,
            query.cursor.as_deref(),
            query.limit,
        )
        .await,
    )
}

pub(super) async fn statements(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
) -> Response {
    let cards = cards_or_404!(state);
    respond(routes::statements(&cards, &caller(&principal, connection.as_deref()), &card_id).await)
}

pub(super) async fn statement(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path((card_id, statement_id)): Path<(String, String)>,
) -> Response {
    let cards = cards_or_404!(state);
    respond(
        routes::statement(
            &cards,
            &caller(&principal, connection.as_deref()),
            &card_id,
            &statement_id,
        )
        .await,
    )
}

pub(super) async fn repayment(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
) -> Response {
    let _cards = cards_or_404!(state);
    if principal.scope.is_some() {
        return CardsError::forbidden("Owner session required").into_response();
    }
    // Workstream E (statement close + repayment verification) lands next.
    CardsError::not_implemented("Statement repayment verification is not available yet")
        .into_response()
}

pub(super) async fn checkout_intent(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    let card = match routes::agent_card(&cards, &caller, &card_id).await {
        Ok(card) => card,
        Err(error) => return error.into_response(),
    };
    respond(match parse_body(&body) {
        Ok(request) => checkout::issue(&cards, &caller, &card, request).await,
        Err(error) => Err(error),
    })
}

pub(super) async fn restore(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    respond(match parse_body(&body) {
        Ok(request) => routes::restore(&cards, &caller, &card_id, request).await,
        Err(error) => Err(error),
    })
}

pub(super) fn router() -> Router<BackendState> {
    let webhook_limit = DefaultBodyLimit::max(crate::connectors::inbox::MAX_WEBHOOK_BYTES);
    Router::new()
        .route("/v1/cards/lithic/asa", post(asa).layer(webhook_limit))
        .route("/v1/cards/lithic/events", post(events).layer(webhook_limit))
        .route(
            "/internal/cron/cards/reconcile",
            get(reconcile).post(reconcile),
        )
        .route("/v1/cards/checkout/redeem", post(redeem))
        .route("/v1/cards/merchants", get(merchants))
        .route("/v1/cards/tee/attestation", get(attestation))
        .route("/v1/cards/prepare", post(prepare))
        .route("/v1/cards", get(list))
        .route("/v1/cards/{card_id}", get(get_card))
        .route("/v1/cards/{card_id}/activate", post(activate))
        .route("/v1/cards/{card_id}/freeze", post(freeze))
        .route("/v1/cards/{card_id}/unfreeze-mirror", post(unfreeze_mirror))
        .route("/v1/cards/{card_id}/embed-session", post(embed))
        .route("/v1/cards/{card_id}/activity", get(activity))
        .route("/v1/cards/{card_id}/statements", get(statements))
        .route(
            "/v1/cards/{card_id}/statements/{statement_id}",
            get(statement),
        )
        .route(
            "/v1/cards/{card_id}/statements/{statement_id}/repayment",
            post(repayment),
        )
        .route(
            "/v1/cards/{card_id}/checkout-intents",
            post(checkout_intent),
        )
        .route("/v1/cards/{card_id}/recovery/restore", post(restore))
}
