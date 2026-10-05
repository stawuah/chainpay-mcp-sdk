//! Axum glue for the private agent card connector (contracts.md §3). With
//! `CARDS_CONNECTOR_ENABLED` off every route answers 404, as if absent.
use super::*;
use crate::connectors::card_issuer::{
    self as cards, CardsConnector, checkout,
    routes::{self, Caller, CardsError},
};
use axum::{body::Bytes, http::HeaderMap};
use solana_transaction::versioned::VersionedTransaction;
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
            | "/internal/ops/cards/metrics"
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
    // Selective gate: a new card is a newly initiated, risk-increasing
    // operation. Checked before any RPC or issuer call.
    if !cards.config.new_activation_enabled {
        return cards::activation::gate_error().into_response();
    }
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

/// Public base-layer commitment for the card view (never private bytes),
/// read back at finalized commitment and judged against the checkpoint
/// ChainPay scheduled: its seq, policy version and period must match before
/// the view says `confirmed`. `None` when nothing could be read, so the view
/// falls back to the stored record.
async fn commitment(
    cards: &CardsConnector,
    card: &crate::storage::StoredCardRecord,
) -> Option<Value> {
    match cards::activation::read_commitment(cards, card).await {
        cards::activation::Readback::Account(actual) => {
            Some(cards::activation::commitment_readback_view(card, &actual))
        }
        _ => None,
    }
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
    let commitment = commitment(&cards, &card).await;
    (
        StatusCode::OK,
        Json(routes::card_view(
            &cards,
            &card,
            commitment,
            Some(&cards.attestation().await),
        )),
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
    connection: Option<Extension<ConnectionHash>>,
    Path((card_id, statement_id)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    // `method: magicblock_private_payments` selects the opt-in private path (contracts.md §7.3); a body
    // without it is the transparent receipt path, unchanged.
    let private = serde_json::from_slice::<Value>(&body)
        .ok()
        .is_some_and(|v| v["method"] == cards::private_repay::METHOD);
    respond(if private {
        match parse_body(&body) {
            Ok(request) => {
                cards::private_repay::submit(&cards, &caller, &card_id, &statement_id, request)
                    .await
            }
            Err(error) => Err(error),
        }
    } else {
        match parse_body(&body) {
            Ok(request) => {
                cards::statements::submit_repayment(
                    &cards,
                    &caller,
                    &card_id,
                    &statement_id,
                    request,
                )
                .await
            }
            Err(error) => Err(error),
        }
    })
}

pub(super) async fn private_repayment(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path((card_id, statement_id)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    respond(match parse_body(&body) {
        Ok(request) => {
            cards::private_repay::prepare(&cards, &caller, &card_id, &statement_id, request).await
        }
        Err(error) => Err(error),
    })
}

pub(super) async fn close_statement(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    respond(match parse_body(&body) {
        Ok(request) => cards::statements::close_now(&cards, &caller, &card_id, request).await,
        Err(error) => Err(error),
    })
}

#[derive(serde::Deserialize)]
pub(super) struct SaltQuery {
    seq: Option<String>,
}

pub(super) async fn disclosure_salt(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
    Query(query): Query<SaltQuery>,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    let card = match routes::owned_card(&cards, &caller, &card_id).await {
        Ok(card) => card,
        Err(error) => return error.into_response(),
    };
    let on_chain = commitment(&cards, &card)
        .await
        .and_then(|c| c["seq"].as_str().and_then(|s| s.parse().ok()));
    respond(
        routes::disclosure_salt(&cards, &caller, &card_id, query.seq.as_deref(), on_chain).await,
    )
}

pub(super) async fn recovery_reconcile(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
    body: Bytes,
) -> Response {
    let cards = cards_or_404!(state);
    let caller = caller(&principal, connection.as_deref());
    respond(match parse_body(&body) {
        Ok(request) => {
            cards::recovery::reconcile_after_restore(&cards, &caller, &card_id, request).await
        }
        Err(error) => Err(error),
    })
}

/// `GET /internal/ops/cards/metrics` (bearer `CRON_SECRET`): opaque counters,
/// ASA latency percentiles and durable gauges recomputed from storage.
pub(super) async fn ops_metrics(State(state): State<BackendState>, headers: HeaderMap) -> Response {
    let cards = cards_or_404!(state);
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if !routes::bearer_matches(auth, cards.config.cron_secret.as_deref()) {
        return CardsError {
            status: StatusCode::UNAUTHORIZED,
            ..CardsError::forbidden("Ops authorization required")
        }
        .into_response();
    }
    (
        StatusCode::OK,
        Json(cards::reconcile::ops_metrics(&cards).await),
    )
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

// ------------------------------------------------- card setup submission

/// A base-layer transaction for `card_policy` or the delegation program (the
/// card's escrow top-up). Routed through `/v1/transactions/submit` like every
/// other owner transaction, but validated against the card registry instead
/// of the ChainPay owner-action rules.
pub(super) fn is_card_setup(tx: &VersionedTransaction) -> bool {
    let keys = tx.message.static_account_keys();
    let program = cards::program::program_id();
    let delegation = cards::program::addr(cards::program::DELEGATION_PROGRAM);
    tx.message.instructions().iter().any(|ix| {
        keys.get(ix.program_id_index as usize)
            .is_some_and(|key| *key == program || *key == delegation)
    })
}

/// Accept only the exact transactions `/v1/cards/prepare` produced for one of
/// the caller's own cards (`init_card`, `delegate_card`, escrow top-up),
/// re-derived from the registry, with the caller as fee payer. Any other
/// instruction, account or amount is refused. The blockhash may be fresh.
pub(super) async fn validate_card_setup(
    state: &BackendState,
    wallet: &str,
    tx: &VersionedTransaction,
) -> Result<(), ApiError> {
    let refuse = || {
        ApiError::BadRequest(
            "Relay accepts only the card setup transactions prepared for your own card".into(),
        )
    };
    let cards = state.cards.as_ref().ok_or_else(refuse)?;
    let owner: solana_address::Address = wallet.parse().map_err(|_| refuse())?;
    if tx.message.static_account_keys().first() != Some(&owner) {
        return Err(ApiError::BadRequest(
            "Owner must sign and pay transaction fees".into(),
        ));
    }
    let blockhash = tx.message.recent_blockhash().to_bytes();
    // Compare meaning, not bytes: the browser's web3.js re-sorts account keys
    // when it refreshes the blockhash (seen live: a second card's init_card
    // was refused because its PDAs sorted differently).
    let submitted = cards::program::decode_message(&tx.message).ok_or_else(refuse)?;
    let signers = tx.message.header().num_required_signatures;
    let rows = cards
        .store
        .list_card_records_for_owner(
            crate::storage::CardKind::Cards,
            wallet,
            cards::CONNECTOR,
            cards::CARD_LIST_REFERENCE,
            None,
            50,
        )
        .await?;
    for row in &rows {
        let (Some(card_id), Some(issuer)) = (
            row.record["cardId"]
                .as_str()
                .and_then(cards::program::unhex::<32>),
            cards.card_issuer(row),
        ) else {
            continue;
        };
        let Some(salt) = cards::program::unhex::<32>(&issuer.ref_salt) else {
            continue;
        };
        let accounts = cards::program::CardAccounts::derive(&owner, &card_id);
        let expected = [
            vec![cards::program::init_card(
                &owner,
                &card_id,
                cards.config.issuer_code,
                &cards::program::issuer_card_ref_hash(&issuer.card_token, &salt),
                cards::program::PREFUND_LAMPORTS,
            )],
            vec![cards::program::delegate_card(&owner, &card_id)],
            vec![cards::program::top_up_escrow(
                &owner,
                &accounts.policy,
                cards::program::ESCROW_TOP_UP_LAMPORTS,
            )],
        ];
        for instructions in expected {
            let candidate = cards::program::unsigned_transaction(&owner, &instructions, blockhash);
            if candidate.message.header().num_required_signatures == signers
                && cards::program::decode_message(&candidate.message).as_ref() == Some(&submitted)
            {
                return Ok(());
            }
        }
    }
    Err(refuse())
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
            "/v1/cards/{card_id}/statements/{statement_id}/repayment/private",
            post(private_repayment),
        )
        .route(
            "/v1/cards/{card_id}/checkout-intents",
            post(checkout_intent),
        )
        .route("/v1/cards/{card_id}/recovery/restore", post(restore))
        .route(
            "/v1/cards/{card_id}/recovery/reconcile",
            post(recovery_reconcile),
        )
        .route(
            "/v1/cards/{card_id}/statements/close",
            post(close_statement),
        )
        .route("/v1/cards/{card_id}/disclosure-salt", get(disclosure_salt))
        .route("/internal/ops/cards/metrics", get(ops_metrics))
}
