//! Wallet sign-in: trades a ChainPay relay session for a buyer grant scoped to
//! that wallet. The relay keeps the signature check; this service only asks it.
use super::{
    domain::{self, Error, Principal, Role},
    routes::{App, bearer},
};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, header},
    routing::post,
};
use serde_json::{Value, json};
use std::{sync::OnceLock, time::Duration};

pub const MAX_TTL: u64 = 12 * 3600;
const MAX_RESPONSE: usize = 16 * 1024;

pub fn router() -> Router<App> {
    Router::new().route("/v1/paypal/session/wallet", post(wallet_session))
}

/// Base58 that decodes to a 32-byte public key.
pub fn valid_wallet(wallet: &str) -> bool {
    (32..=44).contains(&wallet.len())
        && bs58::decode(wallet)
            .into_vec()
            .is_ok_and(|bytes| bytes.len() == 32)
}

/// Grant length: what is left of the relay session, never more than 12 hours.
pub fn grant_ttl(relay_expires_at_ms: u64, now: u64) -> u64 {
    (relay_expires_at_ms / 1000)
        .saturating_sub(now)
        .min(MAX_TTL)
}

// The relay URL is validated as HTTPS (HTTP only on localhost) in config.rs.
fn relay_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
            .expect("relay client")
    })
}

/// Off (404) unless CHAINPAY_PAYPAL_WALLET_LOGIN is true. Tokens are never logged.
async fn wallet_session(State(app): State<App>, headers: HeaderMap) -> Result<Json<Value>, Error> {
    let relay = match (&app.config.relay_url, app.config.wallet_login) {
        (Some(relay), true) => relay.clone(),
        _ => return Err(Error::NotFound),
    };
    // Relay sessions are origin-bound, so forward only an origin we serve.
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .filter(|o| app.config.allowed_origins().any(|allowed| allowed == *o))
        .ok_or(Error::Forbidden)?
        .to_string();
    let token = bearer(&headers)?;
    if token.is_empty()
        || token.len() > 256
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    {
        return Err(Error::Forbidden);
    }
    app.store.rate_limit("wallet-login", 300).await?;
    app.store
        .rate_limit(
            &format!("wallet-login:{}", &domain::hash(token.as_bytes())[..24]),
            10,
        )
        .await?;
    let response = relay_client()
        .get(format!("{relay}/v1/auth/session"))
        .bearer_auth(token)
        .header(header::ORIGIN, &origin)
        .header(header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|_| Error::Invalid("Wallet session check unavailable; retry shortly"))?;
    let status = response.status();
    if matches!(status.as_u16(), 401 | 403 | 404) {
        return Err(Error::Forbidden);
    }
    if !status.is_success() {
        return Err(Error::Invalid(
            "Wallet session check unavailable; retry shortly",
        ));
    }
    let record = bounded(response).await?;
    let wallet = record["wallet"]
        .as_str()
        .filter(|w| valid_wallet(w))
        .ok_or(Error::Forbidden)?
        .to_string();
    if record["origin"].as_str() != Some(origin.as_str()) {
        return Err(Error::Forbidden);
    }
    let now = domain::now();
    let ttl = grant_ttl(record["expires_at_ms"].as_u64().unwrap_or(0), now);
    if ttl == 0 {
        return Err(Error::Forbidden);
    }
    let token = app
        .store
        .issue_access(
            &Principal {
                id: wallet.clone(),
                workspace: format!("wallet:{wallet}"),
                role: Role::Buyer,
            },
            ttl,
        )
        .await?;
    Ok(Json(
        json!({"token":token,"wallet":wallet,"expires_at":now + ttl}),
    ))
}

async fn bounded(mut response: reqwest::Response) -> Result<Value, Error> {
    let unavailable = Error::Invalid("Wallet session check unavailable; retry shortly");
    if response
        .content_length()
        .is_some_and(|n| n > MAX_RESPONSE as u64)
    {
        return Err(unavailable);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::Invalid("Wallet session check unavailable; retry shortly"))?
    {
        if bytes.len() + chunk.len() > MAX_RESPONSE {
            return Err(unavailable);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| unavailable)
}
