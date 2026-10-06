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
    let blockhash = match latest_blockhash(&state).await {
        Ok(hash) => hash,
        Err(response) => return response,
    };
    respond(routes::prepare(&cards, &caller, request, blockhash).await)
}

/// A fresh base-layer blockhash for the unsigned setup transactions.
async fn latest_blockhash(state: &BackendState) -> Result<[u8; 32], Response> {
    match state.rpc.latest_blockhash().await {
        Ok(latest) => bs58::decode(&latest.blockhash)
            .into_vec()
            .ok()
            .and_then(|v| <[u8; 32]>::try_from(v).ok())
            .ok_or_else(|| {
                CardsError::unavailable(
                    "rpc_unavailable",
                    "Solana RPC returned an invalid blockhash",
                )
                .into_response()
            }),
        Err(_) => Err(CardsError::unavailable(
            "rpc_unavailable",
            "Solana RPC is unavailable; retry",
        )
        .into_response()),
    }
}

/// The unsigned setup transactions of one of the caller's own cards, so an
/// owner can finish a setup that stopped partway (see [`routes::setup`]).
pub(super) async fn setup(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    connection: Option<Extension<ConnectionHash>>,
    Path(card_id): Path<String>,
) -> Response {
    let cards = cards_or_404!(state);
    if !cards.config.new_activation_enabled {
        return cards::activation::gate_error().into_response();
    }
    let caller = caller(&principal, connection.as_deref());
    let blockhash = match latest_blockhash(&state).await {
        Ok(hash) => hash,
        Err(response) => return response,
    };
    respond(routes::setup(&cards, &caller, &card_id, blockhash).await)
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
/// instruction, account or amount is refused. The blockhash may be fresh, and
/// the owner's wallet may add its own bounded priority fee (see
/// [`matches_prepared_setup`]).
pub(super) async fn validate_card_setup(
    state: &BackendState,
    wallet: &str,
    tx: &VersionedTransaction,
) -> Result<(), ApiError> {
    // Structure, signer and compute-budget bounds first, exactly as for every
    // other owner transaction: a malformed, duplicated or fee-draining
    // compute-budget instruction is refused here with its own reason.
    transactions::common(tx)?;
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
        if matches_prepared_setup(tx, &owner, &expected) {
            return Ok(());
        }
    }
    Err(refuse())
}

/// A setup message's meaning with the wallet's compute-budget instructions set
/// aside: fee payer, then each remaining instruction's program, metas and data.
fn setup_meaning(
    message: &solana_message::VersionedMessage,
) -> Option<(
    solana_address::Address,
    Vec<cards::program::DecodedInstruction>,
)> {
    let (payer, mut instructions) = cards::program::decode_message(message)?;
    instructions.retain(|(program, _, _)| !transactions::is_compute_budget_program(program));
    Some((payer, instructions))
}

/// Whether `tx` means exactly one of `candidates`, as the owner's wallet may
/// have re-shaped it before signing.
///
/// Compare meaning, not bytes: the browser's web3.js re-sorts account keys
/// when it refreshes the blockhash (seen live: a second card's init_card was
/// refused because its PDAs sorted differently). And wallets such as Phantom
/// add their own SetComputeUnitLimit / SetComputeUnitPrice before signing
/// (seen live: every card setup from Phantom was refused). Those are set aside
/// here the same way the owner-action path sets them aside, and only after
/// `transactions::common` has refused any that carry accounts, repeat, or
/// would charge more than the relay's priority-fee cap. Every other
/// instruction, account, signer and amount still has to match.
pub(super) fn matches_prepared_setup(
    tx: &VersionedTransaction,
    owner: &solana_address::Address,
    candidates: &[Vec<solana_message::Instruction>],
) -> bool {
    let Some(submitted) = setup_meaning(&tx.message) else {
        return false;
    };
    let signers = tx.message.header().num_required_signatures;
    let blockhash = tx.message.recent_blockhash().to_bytes();
    candidates.iter().any(|instructions| {
        let candidate = cards::program::unsigned_transaction(owner, instructions, blockhash);
        candidate.message.header().num_required_signatures == signers
            && setup_meaning(&candidate.message).as_ref() == Some(&submitted)
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
        .route("/v1/cards/{card_id}/setup", get(setup))
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

#[cfg(test)]
mod tests {
    use super::*;
    use cards::program::{
        self, ISSUER_LITHIC_SANDBOX, PREFUND_LAMPORTS, init_card, set_compute_unit_limit,
        tests::resort_like_web3, unsigned_transaction,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use solana_message::{Instruction, Message, VersionedMessage};

    const COMPUTE_BUDGET: &str = "ComputeBudget111111111111111111111111111111";

    fn owner_key() -> SigningKey {
        SigningKey::from_bytes(&[21; 32])
    }

    fn owner() -> solana_address::Address {
        solana_address::Address::from(owner_key().verifying_key().to_bytes())
    }

    fn prepared_init() -> Vec<Instruction> {
        vec![init_card(
            &owner(),
            &[4; 32],
            ISSUER_LITHIC_SANDBOX,
            &[3; 32],
            PREFUND_LAMPORTS,
        )]
    }

    fn compute_price(micro_lamports: u64) -> Instruction {
        let mut data = vec![3u8];
        data.extend_from_slice(&micro_lamports.to_le_bytes());
        Instruction {
            program_id: program::addr(COMPUTE_BUDGET),
            accounts: vec![],
            data,
        }
    }

    /// What Phantom hands back: its own compute limit and price in front of the
    /// prepared instruction, keys re-sorted the way web3.js recompiles them,
    /// and the owner's signature.
    fn wallet_signed(instructions: &[Instruction]) -> VersionedTransaction {
        let tx = unsigned_transaction(&owner(), instructions, [9; 32]);
        let VersionedMessage::Legacy(legacy) = &tx.message else {
            unreachable!()
        };
        sign(VersionedMessage::Legacy(resort_like_web3(legacy)))
    }

    fn sign(message: VersionedMessage) -> VersionedTransaction {
        VersionedTransaction {
            signatures: vec![owner_key().sign(&message.serialize()).to_bytes().into()],
            message,
        }
    }

    /// The relay's full check for card setup, minus the registry lookup.
    fn accepted(tx: &VersionedTransaction) -> bool {
        transactions::common(tx).is_ok() && matches_prepared_setup(tx, &owner(), &[prepared_init()])
    }

    fn with_budget(budget: Vec<Instruction>) -> VersionedTransaction {
        wallet_signed(&[budget, prepared_init()].concat())
    }

    #[test]
    fn the_prepared_setup_transaction_is_accepted() {
        assert!(accepted(&wallet_signed(&prepared_init())));
    }

    #[test]
    fn a_phantom_priority_fee_is_accepted() {
        // Phantom's usual shape: a limit near the simulated use and a modest price.
        let tx = with_budget(vec![set_compute_unit_limit(83_000), compute_price(150_000)]);
        assert_eq!(tx.message.instructions().len(), 3);
        assert!(accepted(&tx));
        // A price alone (runtime default limit) is also fine.
        assert!(accepted(&with_budget(vec![compute_price(1_000)])));
    }

    #[test]
    fn a_compute_budget_instruction_with_accounts_is_refused() {
        let mut limit = set_compute_unit_limit(200_000);
        limit
            .accounts
            .push(solana_message::AccountMeta::new(owner(), true));
        assert!(!accepted(&with_budget(vec![limit])));
    }

    #[test]
    fn a_repeated_compute_budget_instruction_is_refused() {
        assert!(!accepted(&with_budget(vec![
            set_compute_unit_limit(200_000),
            set_compute_unit_limit(300_000),
        ])));
        assert!(!accepted(&with_budget(vec![
            compute_price(1_000),
            compute_price(2_000),
        ])));
    }

    #[test]
    fn an_over_cap_limit_or_fee_is_refused() {
        assert!(!accepted(&with_budget(vec![set_compute_unit_limit(
            1_400_001
        )])));
        // 1.4M units at 50 lamports each is 0.07 SOL, over the 0.01 SOL cap.
        assert!(!accepted(&with_budget(vec![
            set_compute_unit_limit(1_400_000),
            compute_price(50_000_000),
        ])));
        // The same rate is fine when the wallet asks for few units: the cap is
        // on what the owner pays, not on the rate.
        assert!(accepted(&with_budget(vec![
            set_compute_unit_limit(100_000),
            compute_price(50_000_000),
        ])));
    }

    #[test]
    fn an_unrelated_extra_instruction_is_still_refused() {
        let memo = Instruction {
            program_id: program::addr("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            accounts: vec![],
            data: b"hi".to_vec(),
        };
        assert!(!accepted(&with_budget(vec![
            set_compute_unit_limit(83_000),
            memo
        ])));
        // A system transfer out of the owner's wallet beside the setup.
        let transfer = Instruction {
            program_id: program::addr("11111111111111111111111111111111"),
            accounts: vec![
                solana_message::AccountMeta::new(owner(), true),
                solana_message::AccountMeta::new(solana_address::Address::from([8; 32]), false),
            ],
            data: [2u32.to_le_bytes().as_slice(), &1_000u64.to_le_bytes()].concat(),
        };
        assert!(!accepted(&wallet_signed(
            &[prepared_init(), vec![transfer]].concat()
        )));
    }

    #[test]
    fn only_compute_budget_instructions_never_match_a_setup() {
        let message = Message::new_with_blockhash(
            &[set_compute_unit_limit(83_000)],
            Some(&owner()),
            &solana_message::Hash::new_from_array([9; 32]),
        );
        let tx = sign(VersionedMessage::Legacy(message));
        assert!(!matches_prepared_setup(&tx, &owner(), &[prepared_init()]));
    }

    #[test]
    fn a_different_amount_is_still_refused() {
        let more = vec![init_card(
            &owner(),
            &[4; 32],
            ISSUER_LITHIC_SANDBOX,
            &[3; 32],
            PREFUND_LAMPORTS + 1,
        )];
        let tx = wallet_signed(&[vec![set_compute_unit_limit(83_000)], more].concat());
        assert!(!accepted(&tx));
    }
}
