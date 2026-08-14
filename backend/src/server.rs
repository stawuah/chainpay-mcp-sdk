use std::{
    net::SocketAddr,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderValue, Request, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use solana_transaction::versioned::VersionedTransaction;
use thiserror::Error;
use tokio::net::TcpListener;
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    trace::TraceLayer,
};

use crate::{
    api::{
        BackendConfigResponse, JsonRpcProxyRequest, PaymentRequestVerificationResponse,
        PaymentSubmissionRequest, SignedPaymentRequest, TransactionSubmissionRequest,
    },
    rpc::{LatestBlockhash, RpcClient, RpcConfig, RpcError, SimulationResult},
    status::{PaymentRecord, PaymentStatus, SimulationSummary, TransactionRecord},
    storage::{StatusStore, StorageError},
};

const DEFAULT_PROGRAM_ID: &str = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 8080;
const MAX_TRANSACTION_BYTES: usize = 1_048_576;
const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

#[derive(Debug, Clone)]
pub struct BackendConfig {
    pub host: String,
    pub port: u16,
    pub cluster: &'static str,
    pub program_id: String,
    pub rpc: RpcConfig,
    pub auth_token: String,
    pub allowed_origins: Vec<String>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("CHAINPAY_HTTP_PORT must be a valid TCP port")]
    InvalidPort,
    #[error("CHAINPAY_CLUSTER must be devnet for this MVP")]
    UnsupportedCluster,
    #[error("invalid RPC timeout configuration: {0}")]
    InvalidDuration(String),
    #[error("invalid status store configuration: {0}")]
    Storage(#[from] StorageError),
}

impl BackendConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let cluster = std::env::var("CHAINPAY_CLUSTER").unwrap_or_else(|_| "devnet".to_owned());
        if cluster != "devnet" {
            return Err(ConfigError::UnsupportedCluster);
        }

        let port = std::env::var("CHAINPAY_HTTP_PORT")
            .or_else(|_| std::env::var("PORT"))
            .ok()
            .map(|value| value.parse::<u16>().map_err(|_| ConfigError::InvalidPort))
            .transpose()?
            .unwrap_or(DEFAULT_PORT);

        let confirmation_timeout = parse_duration_secs("CHAINPAY_CONFIRMATION_TIMEOUT_SECS", 30)?;
        let poll_interval = parse_duration_ms("CHAINPAY_CONFIRMATION_POLL_MS", 500)?;
        let allowed_origins = std::env::var("CHAINPAY_ALLOWED_ORIGINS")
            .unwrap_or_else(|_| "http://localhost:5173".to_owned())
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(ToOwned::to_owned)
            .collect();

        Ok(Self {
            host: std::env::var("CHAINPAY_HTTP_HOST").unwrap_or_else(|_| DEFAULT_HOST.to_owned()),
            port,
            cluster: "devnet",
            program_id: std::env::var("CHAINPAY_PROGRAM_ID")
                .unwrap_or_else(|_| DEFAULT_PROGRAM_ID.to_owned()),
            rpc: RpcConfig {
                url: std::env::var("CHAINPAY_RPC_URL")
                    .unwrap_or_else(|_| "https://api.devnet.solana.com".to_owned()),
                commitment: std::env::var("CHAINPAY_COMMITMENT")
                    .unwrap_or_else(|_| "confirmed".to_owned()),
                confirmation_timeout,
                poll_interval,
            },
            auth_token: std::env::var("CHAINPAY_HTTP_AUTH_TOKEN").unwrap_or_default(),
            allowed_origins,
        })
    }

    pub fn address(&self) -> Result<SocketAddr, std::io::Error> {
        format!("{}:{}", self.host, self.port)
            .parse()
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))
    }
}

fn parse_duration_secs(name: &str, default: u64) -> Result<std::time::Duration, ConfigError> {
    let value = std::env::var(name)
        .ok()
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| ConfigError::InvalidDuration(name.to_owned()))
        })
        .transpose()?
        .unwrap_or(default);
    Ok(std::time::Duration::from_secs(value.max(1)))
}

fn parse_duration_ms(name: &str, default: u64) -> Result<std::time::Duration, ConfigError> {
    let value = std::env::var(name)
        .ok()
        .map(|value| {
            value
                .parse::<u64>()
                .map_err(|_| ConfigError::InvalidDuration(name.to_owned()))
        })
        .transpose()?
        .unwrap_or(default);
    Ok(std::time::Duration::from_millis(value.max(50)))
}

#[derive(Clone)]
pub struct BackendState {
    pub config: BackendConfig,
    pub rpc: RpcClient,
    pub store: StatusStore,
}

impl BackendState {
    pub fn new(config: BackendConfig, store: StatusStore) -> Result<Self, RpcError> {
        let rpc = RpcClient::new(config.rpc.clone())?;
        Ok(Self { config, rpc, store })
    }
}

#[derive(Debug, Error)]
enum ApiError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("not found")]
    NotFound,
    #[error("RPC error: {0}")]
    Rpc(#[from] RpcError),
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Rpc(_) => StatusCode::BAD_GATEWAY,
            Self::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let body = Json(json!({
            "error": self.to_string(),
        }));
        (status, body).into_response()
    }
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    cluster: &'static str,
    program_id: String,
    rpc_proxy: &'static str,
}

#[derive(Debug, Serialize)]
struct BlockhashResponse {
    blockhash: String,
    #[serde(rename = "lastValidBlockHeight")]
    last_valid_block_height: u64,
}

pub fn build_router(state: BackendState) -> Router {
    let origins = state.config.allowed_origins.clone();
    let auth_state = state.clone();
    Router::new()
        .route("/healthz", get(health))
        .route("/v1/config", get(config))
        .route("/v1/payment-requests/verify", post(verify_payment_request))
        .route("/v1/rpc/latest-blockhash", get(latest_blockhash))
        .route("/v1/payments", post(submit_payment))
        .route("/v1/payments/{payment_id}", get(get_payment))
        .route("/v1/transactions/submit", post(submit_transaction))
        .route("/v1/transactions/{transaction_id}", get(get_transaction))
        .route("/rpc", post(proxy_rpc))
        .with_state(state)
        .layer(middleware::from_fn_with_state(auth_state, auth_middleware))
        .layer(cors_layer(&origins))
        .layer(DefaultBodyLimit::max(MAX_TRANSACTION_BYTES * 2 + 16_384))
        .layer(TraceLayer::new_for_http())
}

pub async fn run(state: BackendState) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let address = state.config.address()?;
    let listener = TcpListener::bind(address).await?;
    println!("ChainPay backend listening on http://{address}");
    println!("RPC proxy: http://{address}/rpc");
    println!("Payment API: http://{address}/v1/payments");
    axum::serve(listener, build_router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            eprintln!("failed to install Ctrl-C handler: {error}");
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => eprintln!("failed to install terminate handler: {error}"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

async fn auth_middleware(
    State(state): State<BackendState>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let path = request.uri().path();
    let wallet_signed_relay = path == "/rpc" || path == "/v1/transactions/submit";
    if request.method() == axum::http::Method::OPTIONS
        || path == "/healthz"
        || wallet_signed_relay
        || state.config.auth_token.is_empty()
    {
        return next.run(request).await;
    }

    let expected = format!("Bearer {}", state.config.auth_token);
    let authorized = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == expected);
    if authorized {
        next.run(request).await
    } else {
        ApiError::Unauthorized.into_response()
    }
}

fn cors_layer(origins: &[String]) -> CorsLayer {
    if origins.iter().any(|origin| origin == "*") {
        return CorsLayer::very_permissive();
    }

    let headers = origins
        .iter()
        .filter_map(|origin| origin.parse::<HeaderValue>().ok())
        .collect::<Vec<_>>();
    CorsLayer::new()
        .allow_origin(AllowOrigin::list(headers))
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE])
}

async fn health(State(state): State<BackendState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        cluster: state.config.cluster,
        program_id: state.config.program_id.clone(),
        rpc_proxy: "/rpc",
    })
}

async fn config(State(state): State<BackendState>) -> Json<BackendConfigResponse> {
    Json(BackendConfigResponse {
        cluster: state.config.cluster,
        program_id: state.config.program_id.clone(),
        rpc_proxy: "/rpc",
    })
}

async fn verify_payment_request(
    State(state): State<BackendState>,
    Json(request): Json<SignedPaymentRequest>,
) -> Result<Json<PaymentRequestVerificationResponse>, ApiError> {
    let payload = request.payload;
    let canonical = serde_json::to_vec(&payload).map_err(|error| {
        ApiError::BadRequest(format!("cannot serialize payment request: {error}"))
    })?;
    let invoice_hash = hex_encode(&Sha256::digest(&canonical));
    let mut response = PaymentRequestVerificationResponse {
        valid: false,
        payload: payload.clone(),
        invoice_hash,
        reason: None,
    };

    if payload.version != 1 {
        response.reason = Some("unsupported payment request version".to_owned());
        return Ok(Json(response));
    }
    if payload.cluster != state.config.cluster {
        response.reason = Some("unsupported Solana cluster".to_owned());
        return Ok(Json(response));
    }
    if payload.invoice.trim().is_empty() || payload.nonce.trim().is_empty() {
        response.reason = Some("invoice and nonce are required".to_owned());
        return Ok(Json(response));
    }
    if payload.token_program != "spl-token" && payload.token_program != "token-2022" {
        response.reason = Some("unsupported token program".to_owned());
        return Ok(Json(response));
    }
    if payload
        .amount
        .parse::<u64>()
        .ok()
        .filter(|amount| *amount > 0)
        .is_none()
    {
        response.reason = Some("amount must be a positive u64 string".to_owned());
        return Ok(Json(response));
    }
    for (name, value) in [
        ("merchant", payload.merchant.as_str()),
        ("mint", payload.mint.as_str()),
        ("recipient", payload.recipient.as_str()),
    ] {
        if bs58::decode(value)
            .into_vec()
            .ok()
            .filter(|bytes| bytes.len() == 32)
            .is_none()
        {
            response.reason = Some(format!("{name} must be a valid Solana address"));
            return Ok(Json(response));
        }
    }
    if let Some(expiry) = &payload.expires_at_slot {
        let expiry = match expiry.parse::<u64>() {
            Ok(expiry) => expiry,
            Err(_) => {
                response.reason =
                    Some("expiresAtSlot must be an unsigned integer string".to_owned());
                return Ok(Json(response));
            }
        };
        if expiry <= state.rpc.current_slot().await? {
            response.reason = Some("payment request has expired".to_owned());
            return Ok(Json(response));
        }
    }

    let merchant_bytes = bs58::decode(&payload.merchant)
        .into_vec()
        .map_err(|error| ApiError::BadRequest(format!("invalid merchant address: {error}")))?;
    let signature_bytes = BASE64.decode(&request.signature).map_err(|error| {
        ApiError::BadRequest(format!("invalid payment request signature: {error}"))
    })?;
    let merchant_key = VerifyingKey::from_bytes(
        merchant_bytes
            .as_slice()
            .try_into()
            .map_err(|_| ApiError::BadRequest("merchant key must be 32 bytes".to_owned()))?,
    )
    .map_err(|error| ApiError::BadRequest(format!("invalid merchant key: {error}")))?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| {
        ApiError::BadRequest(format!("invalid payment request signature: {error}"))
    })?;
    if merchant_key.verify(&canonical, &signature).is_err() {
        response.reason = Some("payment request signature is invalid".to_owned());
        return Ok(Json(response));
    }

    response.valid = true;
    Ok(Json(response))
}

async fn latest_blockhash(
    State(state): State<BackendState>,
) -> Result<Json<BlockhashResponse>, ApiError> {
    let blockhash = state.rpc.latest_blockhash().await?;
    Ok(Json(to_blockhash_response(blockhash)))
}

async fn proxy_rpc(
    State(state): State<BackendState>,
    Json(request): Json<JsonRpcProxyRequest>,
) -> Result<Json<Value>, ApiError> {
    if request.jsonrpc != "2.0" || request.method.is_empty() {
        return Err(ApiError::BadRequest(
            "RPC requests must contain jsonrpc=2.0 and a method".to_owned(),
        ));
    }
    Ok(Json(state.rpc.forward_proxy(request).await?))
}

async fn get_payment(
    State(state): State<BackendState>,
    Path(payment_id): Path<String>,
) -> Result<Json<PaymentRecord>, ApiError> {
    state
        .store
        .get_payment(&payment_id)
        .await
        .map(Json)
        .ok_or(ApiError::NotFound)
}

async fn get_transaction(
    State(state): State<BackendState>,
    Path(transaction_id): Path<String>,
) -> Result<Json<TransactionRecord>, ApiError> {
    state
        .store
        .get_transaction(&transaction_id)
        .await
        .map(Json)
        .ok_or(ApiError::NotFound)
}

async fn submit_payment(
    State(state): State<BackendState>,
    Json(request): Json<PaymentSubmissionRequest>,
) -> Result<Json<PaymentRecord>, ApiError> {
    validate_payment_request(&request, &state.config.program_id)?;
    if let Some(existing) = state
        .store
        .find_payment_by_idempotency(&request.idempotency_key)
        .await
    {
        return Ok(Json(existing));
    }

    let now = now_ms();
    let payment_id = deterministic_id("payment", &request.idempotency_key);
    let mut record = PaymentRecord {
        payment_id,
        idempotency_key: request.idempotency_key.clone(),
        mandate: request.mandate,
        invoice_hash: request.invoice_hash,
        receipt_address: request.receipt_address,
        agent: request.agent,
        mint: request.mint,
        recipient: Some(request.recipient.clone()),
        amount: request.amount,
        token_program: request.token_program,
        signature: None,
        slot: None,
        status: PaymentStatus::Prepared,
        simulation: None,
        error: None,
        created_at_ms: now,
        updated_at_ms: now,
    };
    state.store.put_payment(record.clone()).await?;

    let simulation = match state
        .rpc
        .simulate_signed_transaction(&request.signed_transaction)
        .await
    {
        Ok(simulation) => simulation,
        Err(error) => {
            record = fail_payment(record, error.to_string(), None);
            state.store.put_payment(record.clone()).await?;
            return Ok(Json(record));
        }
    };
    record.simulation = Some(simulation_summary(&simulation));
    if !simulation.ok {
        record = fail_payment(
            record,
            simulation
                .error
                .clone()
                .unwrap_or_else(|| "transaction simulation failed".to_owned()),
            Some(simulation),
        );
        state.store.put_payment(record.clone()).await?;
        return Ok(Json(record));
    }

    let signature = match state
        .rpc
        .send_transaction(&request.signed_transaction)
        .await
    {
        Ok(signature) => signature,
        Err(error) => {
            record = fail_payment(record, error.to_string(), None);
            state.store.put_payment(record.clone()).await?;
            return Ok(Json(record));
        }
    };
    record.signature = Some(signature.clone());
    record.status = PaymentStatus::Submitted;
    record.updated_at_ms = now_ms();
    state.store.put_payment(record.clone()).await?;

    match state.rpc.wait_for_finalized(&signature).await {
        Ok(status) => {
            record.status = PaymentStatus::Confirmed;
            record.slot = status.slot;
            record.updated_at_ms = now_ms();
        }
        Err(error) => {
            record = fail_payment(record, error.to_string(), None);
        }
    }
    state.store.put_payment(record.clone()).await?;
    Ok(Json(record))
}

async fn submit_transaction(
    State(state): State<BackendState>,
    Json(request): Json<TransactionSubmissionRequest>,
) -> Result<Json<TransactionRecord>, ApiError> {
    validate_transaction_request(&request)?;
    if let Some(existing) = state
        .store
        .find_transaction_by_idempotency(&request.idempotency_key)
        .await
    {
        return Ok(Json(existing));
    }

    let now = now_ms();
    let mut record = TransactionRecord {
        transaction_id: deterministic_id("transaction", &request.idempotency_key),
        idempotency_key: request.idempotency_key.clone(),
        signature: None,
        slot: None,
        status: PaymentStatus::Prepared,
        simulation: None,
        error: None,
        created_at_ms: now,
        updated_at_ms: now,
    };
    state.store.put_transaction(record.clone()).await?;

    let simulation = match state
        .rpc
        .simulate_signed_transaction(&request.signed_transaction)
        .await
    {
        Ok(simulation) => simulation,
        Err(error) => {
            record = fail_transaction(record, error.to_string(), None);
            state.store.put_transaction(record.clone()).await?;
            return Ok(Json(record));
        }
    };
    record.simulation = Some(simulation_summary(&simulation));
    if !simulation.ok {
        record = fail_transaction(
            record,
            simulation
                .error
                .clone()
                .unwrap_or_else(|| "transaction simulation failed".to_owned()),
            Some(simulation),
        );
        state.store.put_transaction(record.clone()).await?;
        return Ok(Json(record));
    }

    let signature = match state
        .rpc
        .send_transaction(&request.signed_transaction)
        .await
    {
        Ok(signature) => signature,
        Err(error) => {
            record = fail_transaction(record, error.to_string(), None);
            state.store.put_transaction(record.clone()).await?;
            return Ok(Json(record));
        }
    };
    record.signature = Some(signature.clone());
    record.status = PaymentStatus::Submitted;
    record.updated_at_ms = now_ms();
    state.store.put_transaction(record.clone()).await?;

    match state.rpc.wait_for_finalized(&signature).await {
        Ok(status) => {
            record.status = PaymentStatus::Confirmed;
            record.slot = status.slot;
            record.updated_at_ms = now_ms();
        }
        Err(error) => {
            record = fail_transaction(record, error.to_string(), None);
        }
    }
    state.store.put_transaction(record.clone()).await?;
    Ok(Json(record))
}

fn validate_payment_request(
    request: &PaymentSubmissionRequest,
    program_id: &str,
) -> Result<(), ApiError> {
    validate_string(&request.idempotency_key, "idempotency_key")?;
    validate_string(&request.mandate, "mandate")?;
    validate_string(&request.invoice_hash, "invoice_hash")?;
    validate_string(&request.recipient, "recipient")?;
    validate_string(&request.signed_transaction, "signed_transaction")?;
    let invoice_hash = request.invoice_hash.trim().trim_start_matches("0x");
    if invoice_hash.len() != 64 || !invoice_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest(
            "invoice_hash must be exactly 32 bytes encoded as hexadecimal".to_owned(),
        ));
    }
    if request.signed_transaction.len() > MAX_TRANSACTION_BYTES * 2 {
        return Err(ApiError::BadRequest(
            "signed_transaction is too large".to_owned(),
        ));
    }
    let transaction = decode_transaction(&request.signed_transaction)?;
    validate_chainpay_transaction(&transaction, request, program_id)?;
    Ok(())
}

fn validate_chainpay_transaction(
    bytes: &[u8],
    request: &PaymentSubmissionRequest,
    program_id: &str,
) -> Result<(), ApiError> {
    let transaction: VersionedTransaction = bincode::deserialize(bytes).map_err(|error| {
        ApiError::BadRequest(format!(
            "signed_transaction is not a Solana transaction: {error}"
        ))
    })?;
    transaction.sanitize().map_err(|error| {
        ApiError::BadRequest(format!("signed_transaction failed sanitization: {error}"))
    })?;
    transaction.verify_and_hash_message().map_err(|error| {
        ApiError::BadRequest(format!(
            "signed_transaction signatures are invalid: {error}"
        ))
    })?;

    const EXECUTE_PAYMENT: [u8; 8] = [86, 4, 7, 7, 120, 139, 232, 139];
    let keys = transaction.message.static_account_keys();
    for instruction in transaction.message.instructions() {
        let Some(program) = keys.get(instruction.program_id_index as usize) else {
            continue;
        };
        if program.to_string() != program_id || !instruction.data.starts_with(&EXECUTE_PAYMENT) {
            continue;
        }
        if instruction.data.len() != 112 {
            return Err(ApiError::BadRequest(
                "execute_payment instruction has an invalid data length".to_owned(),
            ));
        }
        if instruction.accounts.len() < 8 {
            return Err(ApiError::BadRequest(
                "execute_payment instruction is missing required accounts".to_owned(),
            ));
        }
        let account = |position: usize| -> Result<String, ApiError> {
            let index = *instruction.accounts.get(position).ok_or_else(|| {
                ApiError::BadRequest("execute_payment account list is incomplete".to_owned())
            })? as usize;
            keys.get(index).map(ToString::to_string).ok_or_else(|| {
                ApiError::BadRequest("execute_payment uses an unresolved lookup account".to_owned())
            })
        };
        if account(2)? != request.mandate {
            return Err(ApiError::BadRequest(
                "signed transaction mandate does not match the request".to_owned(),
            ));
        }
        if hex_encode(&instruction.data[8..40])
            != request.invoice_hash.trim().trim_start_matches("0x")
        {
            return Err(ApiError::BadRequest(
                "signed transaction invoice hash does not match the request".to_owned(),
            ));
        }
        if let Some(receipt) = &request.receipt_address {
            if account(3)? != *receipt {
                return Err(ApiError::BadRequest(
                    "signed transaction receipt does not match the request".to_owned(),
                ));
            }
        }
        if let Some(agent) = &request.agent {
            if account(4)? != *agent {
                return Err(ApiError::BadRequest(
                    "signed transaction agent does not match the request".to_owned(),
                ));
            }
        }
        if let Some(mint) = &request.mint {
            if account(5)? != *mint {
                return Err(ApiError::BadRequest(
                    "signed transaction mint does not match the request".to_owned(),
                ));
            }
        }
        if account(7)? != request.recipient {
            return Err(ApiError::BadRequest(
                "signed transaction recipient does not match the request".to_owned(),
            ));
        }
        if let Some(token_program) = &request.token_program {
            let expected = match token_program.as_str() {
                "spl-token" => SPL_TOKEN_PROGRAM_ID,
                "token-2022" => TOKEN_2022_PROGRAM_ID,
                _ => {
                    return Err(ApiError::BadRequest(
                        "token_program must be spl-token or token-2022".to_owned(),
                    ));
                }
            };
            if account(8)? != expected {
                return Err(ApiError::BadRequest(
                    "signed transaction token program does not match the request".to_owned(),
                ));
            }
        }
        if let Some(amount) = request.amount {
            let encoded_amount = u64::from_le_bytes(instruction.data[104..112].try_into().unwrap());
            if encoded_amount != amount {
                return Err(ApiError::BadRequest(
                    "signed transaction amount does not match the request".to_owned(),
                ));
            }
        }
        return Ok(());
    }

    Err(ApiError::BadRequest(
        "signed transaction does not contain a ChainPay execute_payment instruction".to_owned(),
    ))
}

fn validate_transaction_request(request: &TransactionSubmissionRequest) -> Result<(), ApiError> {
    validate_string(&request.idempotency_key, "idempotency_key")?;
    validate_string(&request.signed_transaction, "signed_transaction")?;
    if request.signed_transaction.len() > MAX_TRANSACTION_BYTES * 2 {
        return Err(ApiError::BadRequest(
            "signed_transaction is too large".to_owned(),
        ));
    }
    decode_transaction(&request.signed_transaction)?;
    Ok(())
}

fn validate_string(value: &str, name: &str) -> Result<(), ApiError> {
    if value.trim().is_empty() {
        return Err(ApiError::BadRequest(format!("{name} must not be empty")));
    }
    Ok(())
}

fn decode_transaction(encoded: &str) -> Result<Vec<u8>, ApiError> {
    BASE64
        .decode(encoded)
        .map_err(|error| {
            ApiError::BadRequest(format!("signed_transaction is not valid base64: {error}"))
        })
        .and_then(|bytes| {
            if bytes.len() > MAX_TRANSACTION_BYTES {
                Err(ApiError::BadRequest(
                    "signed_transaction is too large".to_owned(),
                ))
            } else {
                Ok(bytes)
            }
        })
}

fn simulation_summary(simulation: &SimulationResult) -> SimulationSummary {
    SimulationSummary {
        ok: simulation.ok,
        logs: simulation.logs.clone(),
        units_consumed: simulation.units_consumed,
        error: simulation.error.clone(),
    }
}

fn fail_payment(
    mut record: PaymentRecord,
    error: String,
    simulation: Option<SimulationResult>,
) -> PaymentRecord {
    record.status = PaymentStatus::Failed;
    record.error = Some(error);
    if let Some(simulation) = simulation {
        record.simulation = Some(simulation_summary(&simulation));
    }
    record.updated_at_ms = now_ms();
    record
}

fn fail_transaction(
    mut record: TransactionRecord,
    error: String,
    simulation: Option<SimulationResult>,
) -> TransactionRecord {
    record.status = PaymentStatus::Failed;
    record.error = Some(error);
    if let Some(simulation) = simulation {
        record.simulation = Some(simulation_summary(&simulation));
    }
    record.updated_at_ms = now_ms();
    record
}

fn deterministic_id(prefix: &str, input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    format!("{prefix}_{}", hex_encode(&digest))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn to_blockhash_response(blockhash: LatestBlockhash) -> BlockhashResponse {
    BlockhashResponse {
        blockhash: blockhash.blockhash,
        last_valid_block_height: blockhash.last_valid_block_height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use serde_json::json;

    #[test]
    fn deterministic_ids_are_stable_and_namespaced() {
        assert_eq!(
            deterministic_id("payment", "invoice-1"),
            deterministic_id("payment", "invoice-1")
        );
        assert_ne!(
            deterministic_id("payment", "invoice-1"),
            deterministic_id("transaction", "invoice-1")
        );
    }

    #[test]
    fn rejects_invalid_signed_transactions_before_rpc() {
        let request = TransactionSubmissionRequest {
            idempotency_key: "tx-1".into(),
            signed_transaction: "not-base64".into(),
        };
        assert!(validate_transaction_request(&request).is_err());
    }

    #[tokio::test]
    async fn relays_a_signed_transaction_through_simulation_and_finality() {
        async fn mock_rpc(Json(request): Json<Value>) -> Json<Value> {
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let result = match method {
                "simulateTransaction" => json!({
                    "context": { "slot": 42 },
                    "value": { "err": null, "logs": ["Program success"], "unitsConsumed": 100 }
                }),
                "sendTransaction" => json!("5NfQmockSignature"),
                "getSignatureStatuses" => json!({
                    "context": { "slot": 43 },
                    "value": [{ "slot": 43, "err": null, "confirmationStatus": "finalized" }]
                }),
                _ => json!({}),
            };
            Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
        }

        let rpc_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let rpc_address = rpc_listener.local_addr().unwrap();
        let rpc_task = tokio::spawn(async move {
            axum::serve(rpc_listener, Router::new().fallback(mock_rpc))
                .await
                .unwrap();
        });

        let mut config = BackendConfig::from_env().unwrap();
        config.auth_token.clear();
        config.rpc.url = format!("http://{rpc_address}");
        config.allowed_origins = vec!["*".to_owned()];
        let state = BackendState::new(config, StatusStore::in_memory()).unwrap();
        let api_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_address = api_listener.local_addr().unwrap();
        let api_task = tokio::spawn(async move {
            axum::serve(api_listener, build_router(state))
                .await
                .unwrap();
        });

        let response = reqwest::Client::new()
            .post(format!("http://{api_address}/v1/transactions/submit"))
            .json(&json!({
                "idempotency_key": "test-transaction",
                "signed_transaction": BASE64.encode([1_u8, 2, 3]),
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let record: TransactionRecord = response.json().await.unwrap();
        assert_eq!(record.status, PaymentStatus::Confirmed);
        assert_eq!(record.signature.as_deref(), Some("5NfQmockSignature"));
        assert_eq!(record.slot, Some(43));

        let stored = reqwest::get(format!(
            "http://{api_address}/v1/transactions/{}",
            record.transaction_id
        ))
        .await
        .unwrap();
        assert_eq!(stored.status(), StatusCode::OK);

        api_task.abort();
        rpc_task.abort();
    }
}
