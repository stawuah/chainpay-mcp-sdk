#[path = "server_delivery.rs"]
mod delivery_routes;
#[path = "server_recovery.rs"]
mod recovery;
#[path = "server_transactions.rs"]
mod transactions;
use transactions::owner as validate_owner_transaction;
#[path = "server_auth.rs"]
mod auth;
use auth::Principal;
use axum::Extension;
use std::{
    net::{IpAddr, SocketAddr},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
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
    cors::{AllowHeaders, AllowOrigin, CorsLayer},
    trace::TraceLayer,
};

use crate::{
    api::{
        BackendConfigResponse, JsonRpcProxyRequest, ListX402PaymentsQuery,
        ManagedPaymentSubmissionRequest, ManagedSignerChallengeRequest,
        ManagedSignerChallengeResponse, ManagedSignerProvisionRequest,
        PaymentRequestVerificationResponse, PaymentSubmissionRequest, PayshCatalogResponse,
        SignedPaymentRequest, TransactionSubmissionRequest, TrustedSellerPublicConfig,
        X402JobListResponse, X402JobResponse, X402PaymentMetadata, X402ProofRequest,
    },
    catalog::{self, CatalogError},
    delivery::TrustedSellerMapping,
    rpc::{LatestBlockhash, RpcAccount, RpcClient, RpcConfig, RpcError},
    signer::{PrivySignerProvider, SignerConfigError, SignerProviderError},
    status::{
        ManagedSignerChallenge, ManagedSignerRecord, ManagedSignerStatus, PaymentRecord,
        PaymentStatus, SigningMode, TransactionRecord, X402PaymentRecord, X402PaymentStatus,
    },
    storage::{StatusStore, StorageError},
};

const DEFAULT_PROGRAM_ID: &str = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
const DEFAULT_HOST: &str = "0.0.0.0";
const DEFAULT_PORT: u16 = 8080;
const MAX_TRANSACTION_BYTES: usize = 4_096;
const SPL_TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM_ID: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MANAGED_SIGNER_CHALLENGE_TTL_MS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Clone)]
pub struct BackendConfig {
    pub host: String,
    pub port: u16,
    pub cluster: &'static str,
    pub program_id: String,
    pub rpc: RpcConfig,
    pub auth_token: String,
    pub allowed_origins: Vec<String>,
    /// Number of reverse proxies in front of this process. 0 means the socket
    /// peer is the client. Any value above 0 makes the rate-limit identity come
    /// from `X-Forwarded-For` instead, counting that many hops from the right.
    pub trusted_proxy_hops: usize,
    pub trusted_sellers: Vec<TrustedSellerMapping>,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("CHAINPAY_HTTP_PORT must be a valid TCP port")]
    InvalidPort,
    #[error("CHAINPAY_CLUSTER must be devnet for this MVP")]
    UnsupportedCluster,
    #[error("invalid RPC timeout configuration: {0}")]
    InvalidDuration(String),
    #[error("CHAINPAY_TRUSTED_PROXY_HOPS must be a non-negative integer")]
    InvalidTrustedProxyHops,
    #[error("invalid status store configuration: {0}")]
    Storage(#[from] StorageError),
    #[error("invalid trusted seller configuration: {0}")]
    InvalidTrustedSellers(String),
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
        let trusted_proxy_hops = std::env::var("CHAINPAY_TRUSTED_PROXY_HOPS")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| {
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| ConfigError::InvalidTrustedProxyHops)
            })
            .transpose()?
            .unwrap_or(0);

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
            trusted_proxy_hops,
            trusted_sellers: crate::delivery::trusted_sellers_from_env()
                .map_err(ConfigError::InvalidTrustedSellers)?,
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
    pub signer_provider: Option<PrivySignerProvider>,
}

#[derive(Debug, Error)]
pub enum BackendStateError {
    #[error("RPC configuration error: {0}")]
    Rpc(#[from] RpcError),
    #[error("managed signer configuration error: {0}")]
    Signer(#[from] SignerConfigError),
    #[error("CHAINPAY_HTTP_AUTH_TOKEN is required when managed signing is enabled")]
    MissingManagedPaymentAuth,
}

impl BackendState {
    pub fn new(config: BackendConfig, store: StatusStore) -> Result<Self, BackendStateError> {
        let rpc = RpcClient::new(config.rpc.clone())?;
        let signer_provider = PrivySignerProvider::from_env()?;
        if signer_provider.is_some() && config.auth_token.is_empty() {
            return Err(BackendStateError::MissingManagedPaymentAuth);
        }
        Ok(Self {
            config,
            rpc,
            store,
            signer_provider,
        })
    }
}

#[derive(Debug, Error)]
enum ApiError {
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("operation conflict: {0}")]
    Conflict(String),
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("rate limit exceeded")]
    RateLimited,
    #[error("not found")]
    NotFound,
    #[error("RPC error: {0}")]
    Rpc(#[from] RpcError),
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
    #[error("managed signer provider error: {0}")]
    SignerProvider(#[from] SignerProviderError),
    #[error("managed signer service is not configured")]
    ManagedSignerUnavailable,
    #[error("catalog unavailable: {0}")]
    Catalog(#[from] CatalogError),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
            Self::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Rpc(RpcError::Busy) => StatusCode::TOO_MANY_REQUESTS,
            Self::Rpc(_) => StatusCode::BAD_GATEWAY,
            Self::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::SignerProvider(_) => StatusCode::BAD_GATEWAY,
            Self::ManagedSignerUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Self::Catalog(_) => StatusCode::BAD_GATEWAY,
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
    managed_signing: &'static str,
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
        .route("/v1/auth/principal", get(auth::principal))
        .route(
            "/v1/auth/challenge",
            get(auth::challenge).post(auth::challenge),
        )
        .route(
            "/v1/auth/session",
            get(auth::session).post(auth::login).delete(auth::logout),
        )
        .route("/healthz", get(health))
        .route("/v1/config", get(config))
        .route("/v1/payment-requests/verify", post(verify_payment_request))
        .route(
            "/v1/managed-signers/challenge",
            post(create_managed_signer_challenge),
        )
        .route(
            "/v1/managed-signers/provision",
            post(provision_managed_signer),
        )
        .route("/v1/managed-payments", post(submit_managed_payment))
        .route("/v1/rpc/latest-blockhash", get(latest_blockhash))
        .route("/v1/payments", post(submit_payment))
        .route("/v1/payments/{payment_id}", get(get_payment))
        .route(
            "/v1/payments/{payment_id}/x402",
            get(recovery::x402_context),
        )
        .route(
            "/v1/payments/{payment_id}/recover",
            post(recovery::recover_payment),
        )
        .route(
            "/v1/transactions/{transaction_id}/recover",
            post(recovery::recover_transaction),
        )
        .route(
            "/v1/operations/cancel-unstarted",
            post(recovery::cancel_unstarted),
        )
        .route(
            "/v1/receipts/{receipt_address}",
            get(get_payment_by_receipt),
        )
        .route(
            "/v1/delivery-attestations",
            post(delivery_routes::create_delivery_attestation),
        )
        .route(
            "/v1/delivery-attestations/{receipt_address}",
            get(delivery_routes::get_delivery_attestation),
        )
        .route("/v1/x402-payments", get(list_x402_payments))
        .route("/v1/x402-payments/proof", post(record_x402_proof))
        .route("/v1/catalog/paysh", get(fetch_paysh_catalog))
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
    axum::serve(
        listener,
        build_router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
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

/// Client IP taken from `X-Forwarded-For`, counting `hops` trusted proxies in
/// from the right. Returns `None` when no proxy is declared, the header is
/// absent or malformed, or the position does not hold a valid IP — callers fall
/// back to the socket peer. Entries left of the position were appended by
/// whoever spoke to the outermost proxy and carry no authority.
fn forwarded_client_ip(headers: &axum::http::HeaderMap, hops: usize) -> Option<String> {
    if hops == 0 {
        return None;
    }
    let raw = headers.get("x-forwarded-for")?.to_str().ok()?;
    let entries = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    let index = entries.len().checked_sub(hops)?;
    let candidate = entries.get(index)?;
    candidate.parse::<IpAddr>().ok().map(|ip| ip.to_string())
}

async fn auth_middleware(
    State(state): State<BackendState>,
    mut request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    // Behind a reverse proxy the socket peer is the proxy for every caller, which
    // collapses per-peer rate limits into one shared bucket. Only consult
    // `X-Forwarded-For` when the deployment declares how many proxies sit in
    // front, and then only the entry those proxies wrote. Everything to the left
    // of it is caller-supplied and is never trusted.
    let socket_peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<SocketAddr>>()
        .map(|value| value.0.ip().to_string());
    let peer = forwarded_client_ip(request.headers(), state.config.trusted_proxy_hops)
        .or(socket_peer)
        .unwrap_or_else(|| "unknown-peer".into());
    request.headers_mut().insert(
        "x-chainpay-peer",
        HeaderValue::from_str(&peer).unwrap_or(HeaderValue::from_static("unknown-peer")),
    );
    let path = request.uri().path();
    if request.method() == axum::http::Method::OPTIONS
        || matches!(
            path,
            "/healthz"
                | "/v1/config"
                | "/rpc"
                | "/v1/rpc/latest-blockhash"
                | "/v1/auth/challenge"
                | "/v1/auth/session"
        )
        || delivery_routes::is_public_delivery_path(request.method(), path)
    {
        let mut response = next.run(request).await;
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        return response;
    }
    match auth::identify(&state, request.headers()).await {
        Ok(principal) => {
            let mut request = request;
            request.extensions_mut().insert(principal);
            let mut response = next.run(request).await;
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(error) => {
            let mut response = error.into_response();
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
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
            axum::http::Method::DELETE,
        ])
        // Mirror requested headers so browser RPC clients (web3.js sends
        // `solana-client`) and MCP Accept values can preflight without a
        // one-header-at-a-time allowlist. Origins stay locked above.
        .allow_headers(AllowHeaders::mirror_request())
}

async fn health(State(state): State<BackendState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        cluster: state.config.cluster,
        program_id: state.config.program_id.clone(),
        rpc_proxy: "/rpc",
        managed_signing: if state.signer_provider.is_some() {
            "privy"
        } else {
            "disabled"
        },
    })
}

async fn config(State(state): State<BackendState>) -> Json<BackendConfigResponse> {
    Json(BackendConfigResponse {
        cluster: state.config.cluster,
        program_id: state.config.program_id.clone(),
        rpc_proxy: "/rpc",
        trusted_sellers: state
            .config
            .trusted_sellers
            .iter()
            .map(|mapping| TrustedSellerPublicConfig {
                cluster: mapping.cluster.clone(),
                program_id: mapping.program_id.clone(),
                sellers: mapping.sellers.clone(),
                recipient_token_account: mapping.recipient_token_account.clone(),
            })
            .collect(),
    })
}

async fn verify_payment_request(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<SignedPaymentRequest>,
) -> Result<Json<PaymentRequestVerificationResponse>, ApiError> {
    if let Some(scope) = &principal.scope {
        if !scope["tools"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == "verify_payment_request"))
        {
            return Err(ApiError::Unauthorized);
        }
    }
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
    if !state.store.auth_rate("public-rpc", now_ms(), 600).await? {
        return Err(ApiError::RateLimited);
    }
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
    if !state.store.auth_rate("public-rpc", now_ms(), 600).await? {
        return Err(ApiError::RateLimited);
    }
    let params = request
        .params
        .as_ref()
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::BadRequest("RPC params must be an array".into()))?;
    if serde_json::to_vec(params)
        .map_err(|_| ApiError::Unauthorized)?
        .len()
        > 4096
    {
        return Err(ApiError::BadRequest("RPC params too large".into()));
    }
    if request.method == "getProgramAccounts" {
        if params.first().and_then(Value::as_str) != Some(&state.config.program_id) {
            return Err(ApiError::BadRequest(
                "Only ChainPay program discovery is allowed".into(),
            ));
        }
        let filters = params
            .get(1)
            .and_then(|v| v["filters"].as_array())
            .ok_or_else(|| ApiError::BadRequest("Bounded ChainPay filters required".into()))?;
        let size = filters.iter().find_map(|v| v["dataSize"].as_u64());
        if !matches!(size, Some(106 | 235 | 282))
            || (size != Some(106)
                && !filters.iter().any(|v| {
                    v["memcmp"]["offset"] == 8
                        && v["memcmp"]["bytes"]
                            .as_str()
                            .is_some_and(|v| validate_solana_address(v, "filter").is_ok())
                }))
        {
            return Err(ApiError::BadRequest(
                "Owner/mandate discovery filter required".into(),
            ));
        }
    }
    if request.method == "getSignaturesForAddress"
        && !params
            .get(1)
            .and_then(|v| v["limit"].as_u64())
            .is_some_and(|v| v > 0 && v <= 100)
    {
        return Err(ApiError::BadRequest("History limit must be 1..100".into()));
    }
    if matches!(
        request.method.as_str(),
        "getMultipleAccounts" | "getSignatureStatuses"
    ) && !params
        .first()
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty() && v.len() <= 20)
    {
        return Err(ApiError::BadRequest("RPC batch limit is 20".into()));
    }
    Ok(Json(state.rpc.forward_proxy(request).await?))
}

async fn get_payment(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(payment_id): Path<String>,
) -> Result<Json<PaymentRecord>, ApiError> {
    let record = match state.store.get_payment(&payment_id).await? {
        Some(record) => record,
        None => {
            let (owner, _, initial) = state
                .store
                .operation_record(&payment_id)
                .await?
                .ok_or(ApiError::NotFound)?;
            if owner != principal.wallet {
                return Err(ApiError::Unauthorized);
            }
            serde_json::from_value(initial).map_err(|_| ApiError::NotFound)?
        }
    };
    recovery::authorize_payment(&state, &principal, &record, "get_payment").await?;
    Ok(Json(recovery::payment(&state, record).await?))
}

async fn get_payment_by_receipt(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(receipt_address): Path<String>,
) -> Result<Json<PaymentRecord>, ApiError> {
    validate_string(&receipt_address, "receipt_address")?;
    let record = state
        .store
        .find_payment_by_receipt(&receipt_address)
        .await?
        .ok_or(ApiError::NotFound)?;
    recovery::authorize_payment(&state, &principal, &record, "get_payment").await?;
    Ok(Json(recovery::payment(&state, record).await?))
}

async fn get_transaction(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(transaction_id): Path<String>,
) -> Result<Json<TransactionRecord>, ApiError> {
    auth::owner(&principal, &principal.wallet)?;
    let reservation = state.store.operation_record(&transaction_id).await?;
    let owner = match &reservation {
        Some((owner, _, _)) => owner.clone(),
        None => state
            .store
            .get_auth(
                &format!("transaction-owner:{transaction_id}"),
                now_ms(),
                false,
            )
            .await?
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or(ApiError::Unauthorized)?,
    };
    if owner != principal.wallet {
        return Err(ApiError::Unauthorized);
    }
    let record = match state.store.get_transaction(&transaction_id).await? {
        Some(r) => r,
        None => serde_json::from_value(reservation.ok_or(ApiError::NotFound)?.2)
            .map_err(|_| ApiError::NotFound)?,
    };
    Ok(Json(recovery::transaction(&state, record).await?))
}

async fn create_managed_signer_challenge(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<ManagedSignerChallengeRequest>,
) -> Result<Json<ManagedSignerChallengeResponse>, ApiError> {
    if state.signer_provider.is_none() {
        return Err(ApiError::ManagedSignerUnavailable);
    }
    auth::owner(&principal, &request.owner_wallet)?;
    validate_solana_address(&request.owner_wallet, "owner_wallet")?;
    validate_solana_address(&request.mandate_pda, "mandate_pda")?;
    if transactions::future_mandate(
        &state.config.program_id,
        &principal.wallet,
        &request.mint,
        &request.mandate_nonce,
    )? != request.mandate_pda
    {
        return Err(ApiError::Forbidden(
            "Future mandate PDA must bind this owner, mint and nonce".into(),
        ));
    }
    if state
        .rpc
        .account_info(&request.mandate_pda)
        .await?
        .is_some()
    {
        auth::mandate(&state, &principal, &request.mandate_pda, "create_mandate").await?;
    }

    let mut nonce = [0_u8; 32];
    getrandom::fill(&mut nonce).map_err(|error| {
        ApiError::BadRequest(format!(
            "could not create a secure authorization challenge: {error}"
        ))
    })?;
    let now = now_ms();
    let expires_at_ms = now.saturating_add(MANAGED_SIGNER_CHALLENGE_TTL_MS);
    let challenge_id = format!("challenge_{}", hex_encode(&Sha256::digest(nonce)));
    let message = format!(
        "ChainPay autonomous payment authorization\nCluster: devnet\nOwner: {}\nMandate: {}\nChallenge: {}\nExpires: {}\n\nAuthorize ChainPay to provision one provider-held signer for this mandate. This does not transfer tokens or reveal a private key.",
        request.owner_wallet,
        request.mandate_pda,
        BASE64.encode(nonce),
        expires_at_ms,
    );
    state
        .store
        .put_managed_signer_challenge(ManagedSignerChallenge {
            challenge_id: challenge_id.clone(),
            owner_wallet: request.owner_wallet,
            mandate_pda: request.mandate_pda,
            message: message.clone(),
            expires_at_ms,
            consumed_at_ms: None,
            created_at_ms: now,
        })
        .await?;

    Ok(Json(ManagedSignerChallengeResponse {
        challenge_id,
        message,
        expires_at_ms,
    }))
}

async fn provision_managed_signer(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<ManagedSignerProvisionRequest>,
) -> Result<Json<ManagedSignerRecord>, ApiError> {
    let provider = state
        .signer_provider
        .as_ref()
        .ok_or(ApiError::ManagedSignerUnavailable)?;
    validate_string(&request.challenge_id, "challenge_id")?;
    validate_string(&request.signature, "signature")?;
    let challenge = state
        .store
        .get_managed_signer_challenge(&request.challenge_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    auth::owner(&principal, &challenge.owner_wallet)?;
    if state
        .rpc
        .account_info(&challenge.mandate_pda)
        .await?
        .is_some()
    {
        auth::mandate(&state, &principal, &challenge.mandate_pda, "create_mandate").await?;
    }
    verify_wallet_message_signature(
        &challenge.owner_wallet,
        challenge.message.as_bytes(),
        &request.signature,
    )?;

    if challenge.consumed_at_ms.is_some() {
        return Ok(Json(
            recovery::recover_provision(&state, &challenge.owner_wallet, &challenge.mandate_pda)
                .await?,
        ));
    }
    let now = now_ms();
    if challenge.expires_at_ms < now {
        return Err(ApiError::BadRequest(
            "managed signer challenge has expired".to_owned(),
        ));
    }
    if !state
        .store
        .consume_managed_signer_challenge(&challenge.challenge_id, now)
        .await?
    {
        return Err(ApiError::BadRequest(
            "managed signer challenge is expired or already consumed".to_owned(),
        ));
    }

    if let Some(existing) = state
        .store
        .find_managed_signer_by_mandate(&challenge.mandate_pda)
        .await?
    {
        if existing.owner_wallet != challenge.owner_wallet {
            return Err(ApiError::BadRequest(
                "mandate is already assigned to another owner".to_owned(),
            ));
        }
        return Ok(Json(existing));
    }

    let operation_id = deterministic_id(
        "provision",
        &format!("{}:{}", challenge.owner_wallet, challenge.mandate_pda),
    );
    let (won,_,_,_)=state.store.claim_operation(&operation_id,&challenge.owner_wallet,json!({"mandate":challenge.mandate_pda}),json!({"challenge":challenge.challenge_id,"provider_request_reference":crate::signer::external_id(&challenge.owner_wallet,&challenge.mandate_pda)})).await?;
    if !won {
        return Ok(Json(
            recovery::recover_provision(&state, &challenge.owner_wallet, &challenge.mandate_pda)
                .await?,
        ));
    }

    let provisioned = provider.provision(&challenge.owner_wallet, &challenge.mandate_pda).await.map_err(|_|ApiError::Conflict(format!("Signer provisioning outcome is uncertain. Reconcile provider reference {} before retrying; no second wallet will be requested.",crate::signer::external_id(&challenge.owner_wallet,&challenge.mandate_pda))))?;
    let signer = ManagedSignerRecord {
        signer_id: format!("signer_{}", random_hex_32()?),
        owner_wallet: challenge.owner_wallet,
        public_key: provisioned.public_key,
        provider: "privy".to_owned(),
        provider_wallet_id: provisioned.provider_wallet_id,
        provider_policy_id: provisioned.provider_policy_id,
        mandate_pda: challenge.mandate_pda,
        signing_mode: SigningMode::Delegated,
        status: ManagedSignerStatus::Provisioning,
        created_at_ms: now,
        updated_at_ms: now,
        revoked_at_ms: None,
    };
    state.store.put_managed_signer(signer.clone()).await?;
    Ok(Json(signer))
}

async fn submit_managed_payment(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<ManagedPaymentSubmissionRequest>,
) -> Result<Json<PaymentRecord>, ApiError> {
    let provider = state
        .signer_provider
        .as_ref()
        .ok_or(ApiError::ManagedSignerUnavailable)?;
    let amount = request
        .amount
        .ok_or_else(|| ApiError::BadRequest("amount is required".to_owned()))?;
    let payment = PaymentSubmissionRequest {
        idempotency_key: format!("{}:{}", principal.wallet, request.idempotency_key),
        mandate: request.mandate.clone(),
        invoice_hash: request.invoice_hash.clone(),
        receipt_address: request.receipt_address.clone(),
        signed_transaction: request.unsigned_transaction.clone(),
        agent: Some(request.agent.clone()),
        mint: Some(request.mint.clone()),
        recipient: request.recipient.clone(),
        amount: Some(amount),
        token_program: Some(request.token_program.clone()),
        x402: request.x402.clone(),
    };
    validate_managed_payment_request(
        &request.unsigned_transaction,
        &payment,
        &state.config.program_id,
    )?;
    if let Some(existing) =
        recovery::existing_payment(&state, &principal, &payment, SigningMode::Delegated).await?
    {
        return resume_managed_payment(&state, provider, &principal, &request, payment, existing)
            .await;
    }
    auth::mandate(
        &state,
        &principal,
        &payment.mandate,
        if payment.x402.is_some() {
            "execute_x402_payment"
        } else {
            "execute_payment"
        },
    )
    .await?;
    validate_live_payment(&state, &payment).await?;
    let (won, record) =
        recovery::reserve_payment(&state, &principal, &payment, SigningMode::Delegated).await?;
    if !won {
        return resume_managed_payment(&state, provider, &principal, &request, payment, record)
            .await;
    }
    persist_payment(&state, &record, payment.x402.as_ref()).await?;
    sign_and_settle_managed(&state, provider, &request, payment, record).await
}

async fn resume_managed_payment(
    state: &BackendState,
    provider: &PrivySignerProvider,
    principal: &Principal,
    request: &ManagedPaymentSubmissionRequest,
    payment: PaymentSubmissionRequest,
    existing: PaymentRecord,
) -> Result<Json<PaymentRecord>, ApiError> {
    let existing = recovery::payment(state, existing).await?;
    if !recovery::known_unsent(&existing) || existing.signature.is_some() {
        return Ok(Json(existing));
    }
    auth::mandate(
        state,
        principal,
        &payment.mandate,
        if payment.x402.is_some() {
            "execute_x402_payment"
        } else {
            "execute_payment"
        },
    )
    .await?;
    validate_live_payment(state, &payment).await?;
    persist_payment(state, &existing, payment.x402.as_ref()).await?;
    sign_and_settle_managed(state, provider, request, payment, existing).await
}

async fn sign_and_settle_managed(
    state: &BackendState,
    provider: &PrivySignerProvider,
    request: &ManagedPaymentSubmissionRequest,
    payment: PaymentSubmissionRequest,
    record: PaymentRecord,
) -> Result<Json<PaymentRecord>, ApiError> {
    let mut signer = state
        .store
        .find_managed_signer_by_public_key(&request.agent)
        .await?
        .ok_or(ApiError::NotFound)?;
    if signer.mandate_pda != payment.mandate
        || !matches!(
            signer.status,
            ManagedSignerStatus::Provisioning | ManagedSignerStatus::Active
        )
    {
        return Err(ApiError::BadRequest(
            "managed signer is not active for this mandate".to_owned(),
        ));
    }
    verify_managed_mandate(&state.rpc, &signer, &payment, &state.config.program_id).await?;
    let signed_transaction = provider
        .sign_transaction(&signer.provider_wallet_id, &request.unsigned_transaction)
        .await?;
    validate_provider_signed_transaction(
        &request.unsigned_transaction,
        &signed_transaction,
        &payment,
        &state.config.program_id,
    )?;
    if signer.status == ManagedSignerStatus::Provisioning {
        signer.status = ManagedSignerStatus::Active;
        signer.updated_at_ms = now_ms();
        state.store.put_managed_signer(signer).await?;
    }
    settle_payment(
        state,
        PaymentSubmissionRequest {
            signed_transaction,
            ..payment
        },
        record,
    )
    .await
}

async fn submit_payment(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<PaymentSubmissionRequest>,
) -> Result<Json<PaymentRecord>, ApiError> {
    validate_payment_request(&request, &state.config.program_id)?;
    let mut request = request;
    request.idempotency_key = format!("{}:{}", principal.wallet, request.idempotency_key);
    if let Some(existing) =
        recovery::existing_payment(&state, &principal, &request, SigningMode::Human).await?
    {
        if recovery::known_unsent(&existing) {
            auth::mandate(
                &state,
                &principal,
                &request.mandate,
                if request.x402.is_some() {
                    "execute_x402_payment"
                } else {
                    "execute_payment"
                },
            )
            .await?;
            validate_live_payment(&state, &request).await?;
            return settle_payment(&state, request, existing).await;
        }
        return Ok(Json(existing));
    }
    auth::mandate(
        &state,
        &principal,
        &request.mandate,
        if request.x402.is_some() {
            "execute_x402_payment"
        } else {
            "execute_payment"
        },
    )
    .await?;
    validate_live_payment(&state, &request).await?;
    let (won, record) =
        recovery::reserve_payment(&state, &principal, &request, SigningMode::Human).await?;
    if !won {
        if recovery::known_unsent(&record) {
            return settle_payment(&state, request, record).await;
        }
        return Ok(Json(recovery::payment(&state, record).await?));
    }
    settle_payment(&state, request, record).await
}

async fn settle_payment(
    state: &BackendState,
    request: PaymentSubmissionRequest,
    mut record: PaymentRecord,
) -> Result<Json<PaymentRecord>, ApiError> {
    // J6a: re-read pause/revoke/expiry immediately before broadcast, not only at reservation.
    validate_live_payment(state, &request).await?;
    record.signature = Some(recovery::signature(&request.signed_transaction)?);
    record.status = PaymentStatus::Submitted;
    record.updated_at_ms = now_ms();
    persist_payment(state, &record, request.x402.as_ref()).await?;
    if let Err(error) = state
        .rpc
        .send_transaction(&request.signed_transaction)
        .await
    {
        record = recovery::classify_send(state, record, &error).await?;
        persist_payment(state, &record, request.x402.as_ref()).await?;
        return Ok(Json(
            state
                .store
                .get_payment(&record.payment_id)
                .await?
                .unwrap_or(record),
        ));
    }
    // The durable signature remains authoritative even if the RPC response is lost.
    Ok(Json(recovery::payment(state, record).await?))
}

async fn persist_payment(
    state: &BackendState,
    payment: &PaymentRecord,
    metadata: Option<&X402PaymentMetadata>,
) -> Result<(), ApiError> {
    state.store.put_payment(payment.clone()).await?;
    let Some(metadata) = metadata else {
        return Ok(());
    };
    let status = match payment.status {
        PaymentStatus::Prepared => X402PaymentStatus::Prepared,
        PaymentStatus::Submitted => X402PaymentStatus::Submitted,
        PaymentStatus::Confirmed => X402PaymentStatus::Confirmed,
        PaymentStatus::Failed => X402PaymentStatus::Failed,
    };
    state
        .store
        .put_x402(X402PaymentRecord {
            x402_payment_id: deterministic_id("x402", &payment.idempotency_key),
            idempotency_key: payment.idempotency_key.clone(),
            resource: metadata.resource.clone(),
            payment_id: Some(payment.payment_id.clone()),
            receipt_address: payment.receipt_address.clone(),
            transaction_signature: payment.signature.clone(),
            status,
            challenge: metadata.challenge.clone(),
            proof: None,
            response_status: None,
            error: payment.error.clone(),
            created_at_ms: payment.created_at_ms,
            updated_at_ms: payment.updated_at_ms,
        })
        .await?;
    Ok(())
}

fn classify_x402_challenge(challenge: &Value) -> (String, bool, Option<String>) {
    if challenge.get("x402Version").and_then(Value::as_u64) == Some(2) {
        let amount = challenge
            .get("accepts")
            .and_then(Value::as_array)
            .and_then(|accepts| accepts.first())
            .and_then(|option| option.get("maxAmountRequired"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        return ("standard_x402_v2".into(), false, amount);
    }
    if challenge.get("version").and_then(Value::as_str) == Some("x402/1.0") {
        let amount = challenge
            .get("amount")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                challenge
                    .get("accepts")
                    .and_then(Value::as_array)
                    .and_then(|accepts| accepts.first())
                    .and_then(|option| option.get("amount"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        return ("chainpay_custom_x402".into(), true, amount);
    }
    if challenge.get("version").and_then(Value::as_str) == Some("mpp")
        || challenge.get("mppVersion").is_some()
    {
        return ("mpp".into(), false, None);
    }
    ("unknown".into(), false, None)
}

fn x402_status_label(status: X402PaymentStatus) -> String {
    match status {
        X402PaymentStatus::Prepared => "prepared",
        X402PaymentStatus::Submitted => "submitted",
        X402PaymentStatus::Confirmed => "confirmed",
        X402PaymentStatus::Verified => "verified",
        X402PaymentStatus::Failed => "failed",
    }
    .into()
}

async fn list_x402_payments(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ListX402PaymentsQuery>,
) -> Result<Json<X402JobListResponse>, ApiError> {
    auth::owner(&principal, &principal.wallet)?;
    if let Some(mandate) = query.mandate.as_deref() {
        validate_solana_address(mandate, "mandate")?;
    }
    let limit = query.limit.unwrap_or(50).min(100);
    let rows = state
        .store
        .list_x402_for_owner(&principal.wallet, query.mandate.as_deref(), limit)
        .await?;
    let mut jobs = Vec::with_capacity(rows.len());
    for (record, mandate) in rows {
        if !record
            .idempotency_key
            .starts_with(&format!("{}:", principal.wallet))
        {
            continue;
        }
        if let Some(payment_id) = &record.payment_id {
            let Some(payment) = state.store.get_payment(payment_id).await? else {
                continue;
            };
            recovery::authorize_payment(&state, &principal, &payment, "list_x402_payments").await?;
        }
        let (protocol, payable, amount) = classify_x402_challenge(&record.challenge);
        let error = record.error.clone().or_else(|| {
            if !payable {
                Some("x402_unsupported_sponsor".into())
            } else {
                None
            }
        });
        jobs.push(X402JobResponse {
            x402_payment_id: record.x402_payment_id,
            resource: record.resource,
            mandate,
            payment_id: record.payment_id.clone(),
            amount,
            status: x402_status_label(record.status),
            protocol,
            payable,
            receipt_address: record.receipt_address,
            transaction_signature: record.transaction_signature,
            error,
            created_at_ms: record.created_at_ms,
            updated_at_ms: record.updated_at_ms,
        });
    }
    Ok(Json(X402JobListResponse { jobs }))
}

async fn fetch_paysh_catalog(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    headers: axum::http::HeaderMap,
) -> Result<Json<PayshCatalogResponse>, ApiError> {
    auth::owner(&principal, &principal.wallet)?;
    // The only outbound request this service makes on behalf of a caller. The
    // catalog module caches, but a signed-in owner should still not be able to
    // aim this at a third party in a loop.
    let peer = headers
        .get("x-chainpay-peer")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown-peer");
    let now = now_ms();
    if !state.store.auth_rate("paysh-catalog", now, 120).await?
        || !state
            .store
            .auth_rate(&format!("paysh-catalog-peer:{peer}"), now, 20)
            .await?
    {
        return Err(ApiError::RateLimited);
    }
    let providers = catalog::fetch_paysh_catalog().await?;
    Ok(Json(PayshCatalogResponse {
        source: "pay.sh",
        estimate_only: true,
        fetched_at_ms: now_ms(),
        providers,
    }))
}

async fn record_x402_proof(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<X402ProofRequest>,
) -> Result<Json<X402PaymentRecord>, ApiError> {
    validate_string(&request.idempotency_key, "idempotency_key")?;
    if !(100..=599).contains(&request.response_status) {
        return Err(ApiError::BadRequest(
            "response_status must be a valid HTTP status".to_owned(),
        ));
    }
    let mut record = state
        .store
        .find_x402_by_idempotency(&format!("{}:{}", principal.wallet, request.idempotency_key))
        .await?
        .ok_or(ApiError::NotFound)?;
    if !matches!(
        record.status,
        X402PaymentStatus::Confirmed | X402PaymentStatus::Verified
    ) {
        return Err(ApiError::BadRequest(
            "x402 proof can only be recorded after confirmed settlement".to_owned(),
        ));
    }
    let payment = state
        .store
        .get_payment(record.payment_id.as_deref().ok_or(ApiError::NotFound)?)
        .await?
        .ok_or(ApiError::NotFound)?;
    if payment.mandate != request.mandate {
        return Err(recovery::conflict());
    }
    recovery::authorize_payment(&state, &principal, &payment, "execute_x402_payment").await?;
    record.proof = Some(request.proof);
    record.response_status = Some(request.response_status);
    record.error = request.error;
    record.status = if (200..300).contains(&request.response_status) {
        X402PaymentStatus::Verified
    } else {
        X402PaymentStatus::Confirmed
    };
    record.updated_at_ms = now_ms();
    state.store.put_x402(record.clone()).await?;
    Ok(Json(
        state
            .store
            .find_x402_by_idempotency(&record.idempotency_key)
            .await?
            .unwrap_or(record),
    ))
}

async fn submit_transaction(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<TransactionSubmissionRequest>,
) -> Result<Json<TransactionRecord>, ApiError> {
    auth::owner(&principal, &principal.wallet)?;
    validate_transaction_request(&request)?;
    let transaction = decode_solana_transaction(
        &decode_transaction(&request.signed_transaction)?,
        "signed_transaction",
    )?;
    validate_owner_transaction(&transaction, &principal.wallet, &state.config.program_id)?;
    let key = format!("{}:{}", principal.wallet, request.idempotency_key);
    let id = deterministic_id("transaction", &key);
    let mut receipts = Vec::new();
    if transaction.message.instructions()[0]
        .data
        .starts_with(&[86, 4, 7, 7, 120, 139, 232, 139])
    {
        for mut payment in
            transactions::batch_payment_requests(&transaction, &state.config.program_id)?
        {
            payment.signed_transaction = request.signed_transaction.clone();
            // Timestamps and operational IDs are not part of immutable batch intent.
            let mut receipt = recovery::initial(&payment, SigningMode::Human)?;
            receipt.created_at_ms = 0;
            receipt.updated_at_ms = 0;
            receipts.push(receipt);
        }
    }
    let intent = json!({"message":hex_encode(&Sha256::digest(transaction.message.serialize())),"receipts":receipts});
    if let Some((owner, bound, initial)) = state.store.operation_record(&id).await? {
        if owner != principal.wallet {
            return Err(ApiError::Unauthorized);
        }
        if bound != intent {
            return Err(recovery::conflict());
        }
        let record = match state.store.get_transaction(&id).await? {
            Some(r) => r,
            None => serde_json::from_value(initial).map_err(|_| recovery::conflict())?,
        };
        return Ok(Json(recovery::transaction(&state, record).await?));
    }
    if state.store.get_transaction(&id).await?.is_some() {
        return Err(ApiError::Conflict(
            "Legacy transaction has no authenticated intent reservation; use its status endpoint"
                .into(),
        ));
    }
    validate_owner_live(&state, &principal, &transaction).await?;
    let now = now_ms();
    let mut record = TransactionRecord {
        transaction_id: id,
        idempotency_key: key,
        signature: Some(recovery::signature(&request.signed_transaction)?),
        slot: None,
        status: PaymentStatus::Submitted,
        error: Some("Reserved; submission outcome pending".into()),
        created_at_ms: now,
        updated_at_ms: now,
    };
    // J6a: batch and other owner transactions re-read mandate policy at send time.
    // This runs before the operation is claimed and recorded: a rejection here must not
    // leave a Submitted record behind that was never broadcast and can never be resolved.
    validate_owner_live(&state, &principal, &transaction).await?;
    let (won, owner, bound, initial) = state
        .store
        .claim_operation(
            &record.transaction_id,
            &principal.wallet,
            intent.clone(),
            json!(record),
        )
        .await?;
    if owner != principal.wallet || bound != intent {
        return Err(recovery::conflict());
    }
    if !won {
        let existing = match state.store.get_transaction(&record.transaction_id).await? {
            Some(r) => r,
            None => serde_json::from_value(initial).map_err(|_| recovery::conflict())?,
        };
        return Ok(Json(recovery::transaction(&state, existing).await?));
    }
    state
        .store
        .put_auth(
            &format!("transaction-owner:{}", record.transaction_id),
            json!(principal.wallet),
            i64::MAX as u64,
        )
        .await?;
    state.store.put_transaction(record.clone()).await?;
    if let Err(error) = state
        .rpc
        .send_transaction(&request.signed_transaction)
        .await
    {
        record = recovery::classify_transaction_send(&state, record, &error).await?;
        state.store.put_transaction(record.clone()).await?;
        return Ok(Json(
            state
                .store
                .get_transaction(&record.transaction_id)
                .await?
                .unwrap_or(record),
        ));
    }
    Ok(Json(recovery::transaction(&state, record).await?))
}

/// Resolve one account of a compiled instruction by position, without indexing.
/// Both the position within the instruction and the resulting account index come
/// from the submitted transaction, so neither can be trusted to be in range.
fn address_at(
    tx: &VersionedTransaction,
    accounts: &[u8],
    position: usize,
) -> Result<solana_address::Address, ApiError> {
    let index = *accounts.get(position).ok_or_else(|| {
        ApiError::BadRequest("Transaction instruction is missing a required account".into())
    })?;
    tx.message
        .static_account_keys()
        .get(index as usize)
        .copied()
        .ok_or_else(|| ApiError::BadRequest("Unresolved transaction account".into()))
}

fn account_at(
    tx: &VersionedTransaction,
    accounts: &[u8],
    position: usize,
) -> Result<String, ApiError> {
    Ok(address_at(tx, accounts, position)?.to_string())
}

async fn validate_owner_live(
    state: &BackendState,
    principal: &Principal,
    transaction: &VersionedTransaction,
) -> Result<(), ApiError> {
    let first = transaction
        .message
        .instructions()
        .first()
        .ok_or_else(|| ApiError::BadRequest("Transaction has no instructions".into()))?;
    let program_id = &state.config.program_id;
    if first.data.starts_with(&[86, 4, 7, 7, 120, 139, 232, 139]) {
        for (position, payment) in transactions::batch_payment_requests(transaction, program_id)?
            .iter()
            .enumerate()
        {
            auth::mandate(&state, &principal, &payment.mandate, "execute_payment").await?;
            validate_live_payment_at(&state, transaction, position, &payment.mandate).await?;
        }
        return Ok(());
    }
    let first_program = transactions::key(transaction, first.program_id_index)?;
    if first_program == "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" {
        validate_live_enabled_asset(state, transaction).await?;
        return Ok(());
    }
    if [SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].contains(&first_program.as_str()) {
        if first.data.len() == 1 && first.data[0] == 5 {
            let source = state
                .rpc
                .account_info(&account_at(transaction, &first.accounts, 0)?)
                .await?
                .ok_or_else(|| ApiError::BadRequest("Source token account was not found".into()))?;
            if source.data.len() < 108 || source.data[72] != 1 {
                return Err(ApiError::BadRequest(
                    "Source token account has no active delegate".into(),
                ));
            }
            let mandate = bs58::encode(&source.data[76..108]).into_string();
            auth::mandate(&state, &principal, &mandate, "update_mandate").await?;
            return Ok(());
        }
        if first.data.len() == 10 && first.data[0] == 13 {
            let mandate = account_at(transaction, &first.accounts, 2)?;
            let source = account_at(transaction, &first.accounts, 0)?;
            let mint = account_at(transaction, &first.accounts, 1)?;
            auth::mandate(&state, &principal, &mandate, "update_mandate").await?;
            validate_live_mandate_token_binding(&state, &mandate, &source, &mint).await?;
            return Ok(());
        }
    }
    if first_program != *program_id || first.data.len() < 8 {
        return Ok(());
    }
    match &first.data[..8] {
        [208, 127, 21, 1, 194, 190, 196, 70] => {
            let config = solana_address::Address::find_program_address(
                &[b"config"],
                &program_id.parse().map_err(|_| ApiError::Unauthorized)?,
            )
            .0
            .to_string();
            if state.rpc.account_info(&config).await?.is_some() {
                return Err(ApiError::BadRequest(
                    "Protocol config is already initialized".into(),
                ));
            }
        }
        [21, 80, 155, 149, 117, 207, 235, 16] | [58, 54, 181, 102, 68, 238, 240, 245] => {
            validate_live_config_authority(state, &principal.wallet).await?;
        }
        [69, 131, 248, 29, 105, 50, 139, 30]
        | [192, 108, 97, 124, 56, 229, 236, 3]
        | [252, 97, 140, 119, 67, 43, 177, 108] => {
            for ix in transaction.message.instructions() {
                if transactions::key(transaction, ix.program_id_index)? != *program_id {
                    continue;
                }
                let mandate = account_at(transaction, &ix.accounts, 0)?;
                auth::mandate(&state, &principal, &mandate, "update_mandate").await?;
                if first.data[..8] == [69, 131, 248, 29, 105, 50, 139, 30]
                    && transaction.message.instructions().len() == 2
                {
                    let approve = &transaction.message.instructions()[1];
                    let source = account_at(transaction, &approve.accounts, 0)?;
                    let mint = account_at(transaction, &approve.accounts, 1)?;
                    validate_live_mandate_token_binding(&state, &mandate, &source, &mint).await?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

async fn validate_live_config_authority(
    state: &BackendState,
    wallet: &str,
) -> Result<(), ApiError> {
    let program: solana_address::Address = state
        .config
        .program_id
        .parse()
        .map_err(|_| ApiError::Unauthorized)?;
    let config = solana_address::Address::find_program_address(&[b"config"], &program)
        .0
        .to_string();
    let account = state
        .rpc
        .account_info(&config)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Protocol config was not found".into()))?;
    verify_account_pubkey(&account.data[8..40], wallet, "authority")
        .map_err(|_| ApiError::Forbidden("Protocol authority mismatch".into()))?;
    Ok(())
}

async fn validate_live_mandate_token_binding(
    state: &BackendState,
    mandate: &str,
    source: &str,
    mint: &str,
) -> Result<(), ApiError> {
    let account = state
        .rpc
        .account_info(mandate)
        .await?
        .ok_or_else(|| ApiError::BadRequest("Mandate was not found".into()))?;
    verify_account_pubkey(&account.data[72..104], source, "source")
        .map_err(|_| ApiError::BadRequest("Delegate repair source mismatch".into()))?;
    verify_account_pubkey(&account.data[104..136], mint, "mint")
        .map_err(|_| ApiError::BadRequest("Delegate repair mint mismatch".into()))?;
    Ok(())
}

async fn validate_live_enabled_asset(
    state: &BackendState,
    transaction: &VersionedTransaction,
) -> Result<(), ApiError> {
    let first = transaction
        .message
        .instructions()
        .first()
        .ok_or_else(|| ApiError::BadRequest("Transaction has no instructions".into()))?;
    let mint = address_at(transaction, &first.accounts, 3)?;
    let token = address_at(transaction, &first.accounts, 5)?;
    let program: solana_address::Address = state
        .config
        .program_id
        .parse()
        .map_err(|_| ApiError::Unauthorized)?;
    let asset_address =
        solana_address::Address::find_program_address(&[b"asset", mint.as_ref()], &program).0;
    let asset = state
        .rpc
        .account_info(&asset_address.to_string())
        .await?
        .ok_or(ApiError::BadRequest(
            "Mint is not a supported ChainPay asset".into(),
        ))?;
    if asset.owner != state.config.program_id
        || asset.data.len() != 106
        || asset.data[..8] != [129, 27, 96, 192, 89, 180, 227, 200]
        || &asset.data[40..72] != mint.as_ref()
        || &asset.data[72..104] != token.as_ref()
        || asset.data[104] != 1
    {
        return Err(ApiError::BadRequest(
            "Asset is disabled or incompatible".into(),
        ));
    }
    Ok(())
}

fn validate_payment_request(
    request: &PaymentSubmissionRequest,
    program_id: &str,
) -> Result<(), ApiError> {
    validate_common_payment_fields(request)?;
    validate_string(&request.signed_transaction, "signed_transaction")?;
    if request.signed_transaction.len() > MAX_TRANSACTION_BYTES * 2 {
        return Err(ApiError::BadRequest(
            "signed_transaction is too large".to_owned(),
        ));
    }
    let transaction = decode_transaction(&request.signed_transaction)?;
    validate_chainpay_transaction(&transaction, request, program_id)?;
    Ok(())
}

fn validate_managed_payment_request(
    unsigned_transaction: &str,
    request: &PaymentSubmissionRequest,
    program_id: &str,
) -> Result<(), ApiError> {
    validate_common_payment_fields(request)?;
    validate_string(unsigned_transaction, "unsigned_transaction")?;
    if unsigned_transaction.len() > MAX_TRANSACTION_BYTES * 2 {
        return Err(ApiError::BadRequest(
            "unsigned_transaction is too large".to_owned(),
        ));
    }
    if request.agent.is_none()
        || request.mint.is_none()
        || request.amount.is_none()
        || request.token_program.is_none()
    {
        return Err(ApiError::BadRequest(
            "managed payments require agent, mint, amount, and token_program".to_owned(),
        ));
    }
    let bytes = decode_transaction(unsigned_transaction)?;
    let transaction = decode_solana_transaction(&bytes, "unsigned_transaction")?;
    transaction.sanitize().map_err(|error| {
        ApiError::BadRequest(format!("unsigned_transaction failed sanitization: {error}"))
    })?;
    validate_single_signer_transaction(&transaction, request, true)?;
    validate_chainpay_transaction_semantics(&transaction, request, program_id)
}

fn validate_provider_signed_transaction(
    unsigned_transaction: &str,
    signed_transaction: &str,
    request: &PaymentSubmissionRequest,
    program_id: &str,
) -> Result<(), ApiError> {
    let unsigned_bytes = decode_transaction(unsigned_transaction)?;
    let signed_bytes = decode_transaction(signed_transaction)?;
    let unsigned = decode_solana_transaction(&unsigned_bytes, "unsigned_transaction")?;
    let signed = decode_solana_transaction(&signed_bytes, "provider signed_transaction")?;
    let unsigned_message = unsigned.message.serialize();
    let signed_message = signed.message.serialize();
    if unsigned_message != signed_message {
        return Err(ApiError::BadRequest(
            "managed signer provider changed the reviewed transaction message".to_owned(),
        ));
    }
    signed.sanitize().map_err(|error| {
        ApiError::BadRequest(format!(
            "provider signed_transaction failed sanitization: {error}"
        ))
    })?;
    signed.verify_and_hash_message().map_err(|error| {
        ApiError::BadRequest(format!(
            "managed signer provider returned an invalid signature: {error}"
        ))
    })?;
    validate_single_signer_transaction(&signed, request, false)?;
    validate_chainpay_transaction_semantics(&signed, request, program_id)
}

fn validate_common_payment_fields(request: &PaymentSubmissionRequest) -> Result<(), ApiError> {
    validate_string(&request.idempotency_key, "idempotency_key")?;
    validate_solana_address(&request.mandate, "mandate")?;
    validate_string(&request.invoice_hash, "invoice_hash")?;
    validate_solana_address(
        request.receipt_address.as_deref().ok_or_else(|| {
            ApiError::BadRequest(
                "receipt_address is required for settlement verification".to_owned(),
            )
        })?,
        "receipt_address",
    )?;
    validate_solana_address(&request.recipient, "recipient")?;
    if let Some(agent) = &request.agent {
        validate_solana_address(agent, "agent")?;
    }
    if let Some(mint) = &request.mint {
        validate_solana_address(mint, "mint")?;
    }
    if let Some(x402) = &request.x402 {
        validate_string(&x402.resource, "x402.resource")?;
        if !x402.challenge.is_object() {
            return Err(ApiError::BadRequest(
                "x402.challenge must be a JSON object".to_owned(),
            ));
        }
    }
    let invoice_hash = request.invoice_hash.trim().trim_start_matches("0x");
    if invoice_hash.len() != 64 || !invoice_hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest(
            "invoice_hash must be exactly 32 bytes encoded as hexadecimal".to_owned(),
        ));
    }
    Ok(())
}

fn validate_single_signer_transaction(
    transaction: &VersionedTransaction,
    request: &PaymentSubmissionRequest,
    require_unsigned: bool,
) -> Result<(), ApiError> {
    let required_signatures = transaction.message.header().num_required_signatures as usize;
    if required_signatures != 1 || transaction.signatures.len() != 1 {
        return Err(ApiError::BadRequest(
            "managed payments must require exactly one provider-held signer".to_owned(),
        ));
    }
    let agent = request
        .agent
        .as_deref()
        .ok_or_else(|| ApiError::BadRequest("managed payment agent is required".to_owned()))?;
    if transaction
        .message
        .static_account_keys()
        .first()
        .map(ToString::to_string)
        .as_deref()
        != Some(agent)
    {
        return Err(ApiError::BadRequest(
            "managed signer must be the only required signer and fee payer".to_owned(),
        ));
    }
    if transaction.message.instructions().len() != 1 {
        return Err(ApiError::BadRequest(
            "managed payments may contain only one ChainPay execute_payment instruction".to_owned(),
        ));
    }
    if require_unsigned
        && transaction
            .signatures
            .iter()
            .any(|signature| signature.as_ref().iter().any(|byte| *byte != 0))
    {
        return Err(ApiError::BadRequest(
            "unsigned_transaction must not contain any existing signatures".to_owned(),
        ));
    }
    Ok(())
}

async fn validate_live_payment(
    state: &BackendState,
    request: &PaymentSubmissionRequest,
) -> Result<(), ApiError> {
    let tx = decode_solana_transaction(
        &decode_transaction(&request.signed_transaction)?,
        "transaction",
    )?;
    validate_live_payment_at(state, &tx, 0, &request.mandate).await
}

async fn validate_live_payment_at(
    state: &BackendState,
    tx: &VersionedTransaction,
    position: usize,
    mandate: &str,
) -> Result<(), ApiError> {
    let ix = &tx.message.instructions()[position];
    let keys = tx.message.static_account_keys();
    let account = state
        .rpc
        .account_info(mandate)
        .await?
        .ok_or(ApiError::NotFound)?;
    ensure_mandate_sendable(
        &account,
        &state.config.program_id,
        state.rpc.current_slot().await?,
    )?;
    for (position, range) in [(4, 40..72), (5, 104..136), (6, 72..104)] {
        if keys[ix.accounts[position] as usize].as_ref() != &account.data[range] {
            return Err(ApiError::BadRequest(
                "Payment agent/mint/source differs from on-chain mandate".into(),
            ));
        }
    }
    Ok(())
}

const MANDATE_DISCRIMINATOR: [u8; 8] = [139, 106, 43, 122, 82, 211, 96, 162];
const MANDATE_ACCOUNT_LENGTH: usize = 235;

fn ensure_mandate_sendable(
    account: &RpcAccount,
    program_id: &str,
    current_slot: u64,
) -> Result<(), ApiError> {
    if account.owner != program_id
        || account.data.len() < MANDATE_ACCOUNT_LENGTH
        || account.data[..8] != MANDATE_DISCRIMINATOR
    {
        return Err(ApiError::Unauthorized);
    }
    if account.data[232] != 0 || account.data[233] != 0 {
        return Err(ApiError::BadRequest(
            "payment mandate is paused or revoked".to_owned(),
        ));
    }
    let expires_at_slot = u64::from_le_bytes(account.data[200..208].try_into().unwrap());
    if expires_at_slot <= current_slot {
        return Err(ApiError::BadRequest(
            "payment mandate has expired".to_owned(),
        ));
    }
    Ok(())
}

async fn verify_managed_mandate(
    rpc: &RpcClient,
    signer: &ManagedSignerRecord,
    request: &PaymentSubmissionRequest,
    program_id: &str,
) -> Result<(), ApiError> {
    let account = rpc
        .account_info(&request.mandate)
        .await?
        .ok_or_else(|| ApiError::BadRequest("managed payment mandate was not found".to_owned()))?;
    if account.owner != program_id
        || account.data.len() < MANDATE_ACCOUNT_LENGTH
        || account.data[..8] != MANDATE_DISCRIMINATOR
    {
        return Err(ApiError::BadRequest(
            "managed payment mandate is not a valid ChainPay mandate".to_owned(),
        ));
    }
    verify_account_pubkey(&account.data[8..40], &signer.owner_wallet, "owner")?;
    verify_account_pubkey(&account.data[40..72], &signer.public_key, "approved agent")?;
    verify_account_pubkey(
        &account.data[104..136],
        request
            .mint
            .as_deref()
            .ok_or_else(|| ApiError::BadRequest("mint is required".to_owned()))?,
        "mint",
    )?;
    ensure_mandate_sendable(&account, program_id, rpc.current_slot().await?).map_err(|error| {
        match error {
            ApiError::BadRequest(message) => ApiError::BadRequest(format!("managed {message}")),
            other => other,
        }
    })
}

async fn verify_finalized_receipt(
    rpc: &RpcClient,
    record: &PaymentRecord,
    program_id: &str,
) -> Result<(), String> {
    let address = record
        .receipt_address
        .as_deref()
        .ok_or_else(|| "payment record has no receipt address".to_owned())?;
    let account = rpc
        .account_info(address)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("receipt account does not exist: {address}"))?;
    verify_receipt_account(&account, record, program_id)
}

fn verify_receipt_account(
    account: &RpcAccount,
    record: &PaymentRecord,
    program_id: &str,
) -> Result<(), String> {
    const RECEIPT_DISCRIMINATOR: [u8; 8] = [168, 198, 209, 4, 60, 235, 126, 109];
    const RECEIPT_ACCOUNT_LENGTH: usize = 282;
    const RECEIPT_STATUS_SETTLED: u8 = 1;

    if account.owner != program_id {
        return Err(format!(
            "receipt is owned by {}, not {program_id}",
            account.owner
        ));
    }
    if account.data.len() < RECEIPT_ACCOUNT_LENGTH {
        return Err(format!(
            "receipt data is truncated: {} bytes",
            account.data.len()
        ));
    }
    if account.data[..8] != RECEIPT_DISCRIMINATOR {
        return Err("receipt account discriminator is invalid".to_owned());
    }
    verify_receipt_pubkey(&account.data[8..40], &record.mandate, "mandate")?;
    let invoice_hash = decode_hex_32(&record.invoice_hash, "invoice_hash")?;
    if account.data[40..72] != invoice_hash {
        return Err("receipt invoice hash does not match payment".to_owned());
    }
    if let Some(mint) = &record.mint {
        verify_receipt_pubkey(&account.data[104..136], mint, "mint")?;
    }
    if let Some(recipient) = &record.recipient {
        verify_receipt_pubkey(&account.data[168..200], recipient, "recipient")?;
    }
    if let Some(amount) = record.amount {
        let receipt_amount = u64::from_le_bytes(account.data[200..208].try_into().unwrap());
        if receipt_amount != amount {
            return Err(format!(
                "receipt amount {receipt_amount} does not match payment {amount}"
            ));
        }
    }
    if let Some(agent) = &record.agent {
        verify_receipt_pubkey(&account.data[208..240], agent, "agent")?;
    }
    if account.data[280] != RECEIPT_STATUS_SETTLED {
        return Err(format!(
            "receipt status {} is not settled",
            account.data[280]
        ));
    }
    Ok(())
}

fn verify_receipt_pubkey(actual: &[u8], expected: &str, field: &str) -> Result<(), String> {
    let expected = bs58::decode(expected)
        .into_vec()
        .map_err(|error| format!("stored {field} is not base58: {error}"))?;
    if expected.len() != 32 {
        return Err(format!("stored {field} is not a 32-byte Solana address"));
    }
    if actual != expected {
        return Err(format!("receipt {field} does not match payment"));
    }
    Ok(())
}

fn decode_hex_32(value: &str, field: &str) -> Result<[u8; 32], String> {
    let value = value.trim().trim_start_matches("0x");
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("stored {field} is not a 32-byte hexadecimal value"));
    }
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|error| format!("stored {field} is invalid: {error}"))?;
    }
    Ok(bytes)
}

fn validate_chainpay_transaction(
    bytes: &[u8],
    request: &PaymentSubmissionRequest,
    program_id: &str,
) -> Result<(), ApiError> {
    let transaction = decode_solana_transaction(bytes, "signed_transaction")?;
    transaction.sanitize().map_err(|error| {
        ApiError::BadRequest(format!("signed_transaction failed sanitization: {error}"))
    })?;
    transaction.verify_and_hash_message().map_err(|error| {
        ApiError::BadRequest(format!(
            "signed_transaction signatures are invalid: {error}"
        ))
    })?;

    validate_chainpay_transaction_semantics(&transaction, request, program_id)
}

fn validate_chainpay_transaction_semantics(
    transaction: &VersionedTransaction,
    request: &PaymentSubmissionRequest,
    program_id: &str,
) -> Result<(), ApiError> {
    transactions::payment(transaction, request, program_id)
}

fn decode_solana_transaction(bytes: &[u8], field: &str) -> Result<VersionedTransaction, ApiError> {
    let transaction: VersionedTransaction = wincode::deserialize(bytes).map_err(|error| {
        ApiError::BadRequest(format!(
            "{field} is not a supported Solana transaction: {error}"
        ))
    })?;
    let canonical =
        wincode::serialize(&transaction).map_err(|e| ApiError::BadRequest(e.to_string()))?;
    if canonical != bytes
        || (bytes.len() > 1232
            && !matches!(
                transaction.message,
                solana_transaction::VersionedMessage::V1(_)
            ))
    {
        return Err(ApiError::BadRequest(
            "Noncanonical or oversized transaction".into(),
        ));
    }
    Ok(transaction)
}

fn validate_transaction_request(request: &TransactionSubmissionRequest) -> Result<(), ApiError> {
    validate_string(&request.idempotency_key, "idempotency_key")?;
    validate_string(&request.signed_transaction, "signed_transaction")?;
    if request.signed_transaction.len() > MAX_TRANSACTION_BYTES * 2 {
        return Err(ApiError::BadRequest(
            "signed_transaction is too large".to_owned(),
        ));
    }
    let bytes = decode_transaction(&request.signed_transaction)?;
    let transaction = decode_solana_transaction(&bytes, "signed_transaction")?;
    transaction.sanitize().map_err(|error| {
        ApiError::BadRequest(format!("signed_transaction failed sanitization: {error}"))
    })?;
    transaction.verify_and_hash_message().map_err(|error| {
        ApiError::BadRequest(format!(
            "signed_transaction signatures are invalid: {error}"
        ))
    })?;
    Ok(())
}

fn validate_string(value: &str, name: &str) -> Result<(), ApiError> {
    if value.len() > 8192 || value.trim().is_empty() {
        return Err(ApiError::BadRequest(format!("{name} must not be empty")));
    }
    Ok(())
}

fn validate_solana_address(value: &str, name: &str) -> Result<(), ApiError> {
    if value.len() < 32 || value.len() > 44 {
        return Err(ApiError::BadRequest(format!(
            "{name} must be a Solana address"
        )));
    }
    validate_string(value, name)?;
    let bytes = bs58::decode(value).into_vec().map_err(|error| {
        ApiError::BadRequest(format!("{name} must be a base58 Solana address: {error}"))
    })?;
    if bytes.len() != 32 {
        return Err(ApiError::BadRequest(format!(
            "{name} must decode to a 32-byte Solana address"
        )));
    }
    Ok(())
}

fn verify_wallet_message_signature(
    wallet: &str,
    message: &[u8],
    encoded_signature: &str,
) -> Result<(), ApiError> {
    validate_solana_address(wallet, "owner_wallet")?;
    let wallet_bytes = bs58::decode(wallet)
        .into_vec()
        .map_err(|error| ApiError::BadRequest(format!("invalid owner wallet: {error}")))?;
    let signature_bytes = BASE64.decode(encoded_signature).map_err(|error| {
        ApiError::BadRequest(format!("owner signature must be base64: {error}"))
    })?;
    let verifying_key = VerifyingKey::from_bytes(
        wallet_bytes
            .as_slice()
            .try_into()
            .map_err(|_| ApiError::BadRequest("owner wallet must be 32 bytes".to_owned()))?,
    )
    .map_err(|error| ApiError::BadRequest(format!("invalid owner wallet key: {error}")))?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|error| ApiError::BadRequest(format!("invalid owner signature: {error}")))?;
    verifying_key.verify(message, &signature).map_err(|_| {
        ApiError::BadRequest("owner signature does not match the challenge".to_owned())
    })
}

fn verify_account_pubkey(actual: &[u8], expected: &str, field: &str) -> Result<(), ApiError> {
    let expected = bs58::decode(expected)
        .into_vec()
        .map_err(|error| ApiError::BadRequest(format!("stored {field} is not base58: {error}")))?;
    if expected.len() != 32 || actual != expected {
        return Err(ApiError::BadRequest(format!(
            "on-chain mandate {field} does not match the managed signer registry"
        )));
    }
    Ok(())
}

fn random_hex_32() -> Result<String, ApiError> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| {
        ApiError::BadRequest(format!("could not create a secure identifier: {error}"))
    })?;
    Ok(hex_encode(&bytes))
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
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    fn xff(value: &str) -> axum::http::HeaderMap {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn forwarded_peer_is_ignored_until_a_proxy_count_is_declared() {
        // Default deployment: the socket peer is the client, so a caller-supplied
        // header must never become the rate-limit identity.
        assert_eq!(forwarded_client_ip(&xff("203.0.113.9"), 0), None);
        assert_eq!(forwarded_client_ip(&axum::http::HeaderMap::new(), 1), None);
    }

    #[test]
    fn forwarded_peer_counts_trusted_hops_from_the_right() {
        // One trusted proxy (the Render edge): only the entry it appended counts.
        // A caller that sends its own X-Forwarded-For lands to the left of it and
        // cannot choose its own bucket.
        assert_eq!(
            forwarded_client_ip(&xff("198.51.100.7, 203.0.113.9"), 1).as_deref(),
            Some("203.0.113.9"),
        );
        assert_eq!(
            forwarded_client_ip(&xff("spoofed, 198.51.100.7, 203.0.113.9"), 2).as_deref(),
            Some("198.51.100.7"),
        );
    }

    #[test]
    fn forwarded_peer_falls_back_when_the_header_cannot_be_trusted() {
        // Too few entries for the declared hop count, or a non-IP at that
        // position, means we have no trustworthy client identity: fall back to
        // the socket peer rather than rate-limiting on attacker-chosen text.
        assert_eq!(forwarded_client_ip(&xff("203.0.113.9"), 2), None);
        assert_eq!(forwarded_client_ip(&xff("not-an-ip"), 1), None);
        assert_eq!(forwarded_client_ip(&xff("  , , "), 1), None);
    }

    #[tokio::test]
    async fn latest_blockhash_shares_public_rpc_quota() {
        let state = BackendState::new(BackendConfig::from_env().unwrap(), StatusStore::in_memory())
            .unwrap();
        for _ in 0..600 {
            assert!(
                state
                    .store
                    .auth_rate("public-rpc", now_ms(), 600)
                    .await
                    .unwrap()
            );
        }
        assert!(matches!(
            latest_blockhash(State(state)).await,
            Err(ApiError::RateLimited)
        ));
    }

    #[test]
    fn classifies_custom_and_blocked_x402_challenges() {
        let (protocol, payable, amount) = classify_x402_challenge(&json!({
            "version": "x402/1.0",
            "amount": "5000"
        }));
        assert_eq!(protocol, "chainpay_custom_x402");
        assert!(payable);
        assert_eq!(amount.as_deref(), Some("5000"));

        let (protocol, payable, amount) = classify_x402_challenge(&json!({
            "x402Version": 2,
            "accepts": [{ "maxAmountRequired": "9000" }]
        }));
        assert_eq!(protocol, "standard_x402_v2");
        assert!(!payable);
        assert_eq!(amount.as_deref(), Some("9000"));

        let (protocol, payable, _) = classify_x402_challenge(&json!({ "version": "mpp" }));
        assert_eq!(protocol, "mpp");
        assert!(!payable);
    }

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

    #[test]
    fn owner_challenge_signature_is_bound_to_the_exact_message() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let wallet = bs58::encode(signing_key.verifying_key().as_bytes()).into_string();
        let message = b"ChainPay delegated signer enrollment";
        let signature = BASE64.encode(signing_key.sign(message).to_bytes());

        assert!(verify_wallet_message_signature(&wallet, message, &signature).is_ok());
        assert!(
            verify_wallet_message_signature(&wallet, b"different message", &signature).is_err()
        );
    }

    #[test]
    fn ensure_mandate_sendable_rejects_paused_revoked_and_expired() {
        let program_id = DEFAULT_PROGRAM_ID;
        let mut active = RpcAccount {
            owner: program_id.into(),
            data: vec![0; 235],
        };
        active.data[..8].copy_from_slice(&MANDATE_DISCRIMINATOR);
        active.data[200..208].copy_from_slice(&100_u64.to_le_bytes());
        ensure_mandate_sendable(&active, program_id, 1).unwrap();

        let mut paused = active.clone();
        paused.data[232] = 1;
        assert!(matches!(
            ensure_mandate_sendable(&paused, program_id, 1),
            Err(ApiError::BadRequest(message)) if message.contains("paused or revoked")
        ));

        let mut revoked = active.clone();
        revoked.data[233] = 1;
        assert!(matches!(
            ensure_mandate_sendable(&revoked, program_id, 1),
            Err(ApiError::BadRequest(message)) if message.contains("paused or revoked")
        ));

        let mut expired = active;
        expired.data[200..208].copy_from_slice(&1_u64.to_le_bytes());
        assert!(matches!(
            ensure_mandate_sendable(&expired, program_id, 10),
            Err(ApiError::BadRequest(message)) if message.contains("expired")
        ));
    }

    #[test]
    fn verifies_all_settlement_receipt_fields() {
        let program_id = bs58::encode([9_u8; 32]).into_string();
        let mandate = bs58::encode([1_u8; 32]).into_string();
        let mint = bs58::encode([2_u8; 32]).into_string();
        let recipient = bs58::encode([3_u8; 32]).into_string();
        let agent = bs58::encode([4_u8; 32]).into_string();
        let mut data = vec![0_u8; 282];
        data[..8].copy_from_slice(&[168, 198, 209, 4, 60, 235, 126, 109]);
        data[8..40].copy_from_slice(&[1_u8; 32]);
        data[40..72].copy_from_slice(&[5_u8; 32]);
        data[104..136].copy_from_slice(&[2_u8; 32]);
        data[168..200].copy_from_slice(&[3_u8; 32]);
        data[200..208].copy_from_slice(&10_u64.to_le_bytes());
        data[208..240].copy_from_slice(&[4_u8; 32]);
        data[280] = 1;
        let account = RpcAccount {
            owner: program_id.clone(),
            data,
        };
        let record = PaymentRecord {
            payment_id: "payment-1".into(),
            idempotency_key: "invoice-1".into(),
            mandate,
            invoice_hash: "05".repeat(32),
            receipt_address: Some(bs58::encode([6_u8; 32]).into_string()),
            agent: Some(agent),
            mint: Some(mint),
            recipient: Some(recipient),
            amount: Some(10),
            token_program: Some("token-2022".into()),
            signing_mode: SigningMode::Human,
            signature: Some("signature".into()),
            slot: Some(1),
            status: PaymentStatus::Submitted,
            error: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        };

        assert!(verify_receipt_account(&account, &record, &program_id).is_ok());
        let mut wrong_amount = record;
        wrong_amount.amount = Some(11);
        assert!(verify_receipt_account(&account, &wrong_amount, &program_id).is_err());
    }

    #[tokio::test]
    async fn rpc_proxy_routes_allowlisted_read_methods() {
        async fn read_rpc_fixture(Json(request): Json<Value>) -> Json<Value> {
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let result = match method {
                "getProgramAccounts" => json!([{
                    "pubkey": "mandate-pda",
                    "account": { "data": ["account-data", "base64"], "executable": false, "lamports": 1, "owner": "program-id", "space": 235 }
                }]),
                "getSignaturesForAddress" => json!([{
                    "signature": "create-signature",
                    "slot": 41,
                    "blockTime": 1_700_000_000_i64,
                    "err": null,
                    "memo": null,
                    "confirmationStatus": "finalized"
                }]),
                "getTransaction" => Value::Null,
                _ => json!({}),
            };
            Json(json!({ "jsonrpc": "2.0", "id": 1, "result": result }))
        }

        let rpc_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let rpc_address = rpc_listener.local_addr().unwrap();
        let rpc_task = tokio::spawn(async move {
            axum::serve(rpc_listener, Router::new().fallback(read_rpc_fixture))
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

        let discovered = reqwest::Client::new()
            .post(format!("http://{api_address}/rpc"))
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "getProgramAccounts",
                "params": [DEFAULT_PROGRAM_ID, { "filters": [{ "dataSize": 235 }, { "memcmp": { "offset": 8, "bytes": DEFAULT_PROGRAM_ID } }] }]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(discovered.status(), StatusCode::OK);
        let discovered_json: Value = discovered.json().await.unwrap();
        assert_eq!(discovered_json["result"][0]["pubkey"], "mandate-pda");

        let history = reqwest::Client::new()
            .post(format!("http://{api_address}/rpc"))
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "getSignaturesForAddress",
                "params": ["mandate-pda", { "limit": 1 }]
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(history.status(), StatusCode::OK);
        let history_json: Value = history.json().await.unwrap();
        assert_eq!(history_json["result"][0]["slot"], 41);

        let missing: Value = reqwest::Client::new().post(format!("http://{api_address}/rpc")).json(&json!({"jsonrpc":"2.0","id":4,"method":"getTransaction","params":["fixture-signature"]})).send().await.unwrap().json().await.unwrap();
        assert!(missing.get("result").unwrap().is_null());
        let blocked = reqwest::Client::new()
            .post(format!("http://{api_address}/v1/transactions/submit"))
            .json(&json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(blocked.status(), StatusCode::UNAUTHORIZED);
        let expensive = reqwest::Client::new().post(format!("http://{api_address}/rpc")).json(&json!({"jsonrpc":"2.0","id":5,"method":"getProgramAccounts","params":[DEFAULT_PROGRAM_ID,{}]})).send().await.unwrap();
        assert_eq!(expensive.status(), StatusCode::BAD_REQUEST);

        api_task.abort();
        rpc_task.abort();
    }

    #[tokio::test]
    async fn rpc_cors_mirrors_solana_client_preflight_from_allowed_origin() {
        let mut config = BackendConfig::from_env().unwrap();
        config.auth_token.clear();
        config.allowed_origins = vec!["https://chainpay-frontend.onrender.com".to_owned()];
        let state = BackendState::new(config, StatusStore::in_memory()).unwrap();
        let api_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_address = api_listener.local_addr().unwrap();
        let api_task = tokio::spawn(async move {
            axum::serve(api_listener, build_router(state))
                .await
                .unwrap();
        });

        let allowed = reqwest::Client::new()
            .request(
                reqwest::Method::OPTIONS,
                format!("http://{api_address}/rpc"),
            )
            .header("Origin", "https://chainpay-frontend.onrender.com")
            .header("Access-Control-Request-Method", "POST")
            .header(
                "Access-Control-Request-Headers",
                "solana-client, content-type",
            )
            .send()
            .await
            .unwrap();
        assert_eq!(allowed.status(), StatusCode::OK);
        let allow_origin = allowed
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok());
        assert_eq!(allow_origin, Some("https://chainpay-frontend.onrender.com"));
        let allow_headers = allowed
            .headers()
            .get("access-control-allow-headers")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        assert!(
            allow_headers.contains("solana-client"),
            "preflight must allow solana-client, got {allow_headers:?}"
        );
        assert!(allow_headers.contains("content-type"));

        let denied = reqwest::Client::new()
            .request(
                reqwest::Method::OPTIONS,
                format!("http://{api_address}/rpc"),
            )
            .header("Origin", "https://evil.example")
            .header("Access-Control-Request-Method", "POST")
            .header("Access-Control-Request-Headers", "solana-client")
            .send()
            .await
            .unwrap();
        let denied_origin = denied
            .headers()
            .get("access-control-allow-origin")
            .and_then(|value| value.to_str().ok());
        assert_ne!(denied_origin, Some("https://evil.example"));

        api_task.abort();
    }
}
