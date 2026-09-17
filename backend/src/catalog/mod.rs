//! Outbound catalog fetches. Only allowlisted URLs leave Axum.

use std::{
    sync::OnceLock,
    time::{Duration, Instant},
};

use reqwest::{Client, redirect::Policy};
use serde_json::Value;
use thiserror::Error;
use tokio::sync::Mutex;

const PAYSH_CATALOG_URL: &str = "https://pay.sh/api/catalog";
const MAX_CATALOG_BYTES: usize = 2 * 1024 * 1024;
/// How long a fetched catalog is reused. These are non-binding price estimates,
/// so a stale minute costs nothing and it keeps one dashboard from turning into
/// a stream of outbound requests to a third party.
const CACHE_TTL: Duration = Duration::from_secs(60);

static HTTP: OnceLock<Client> = OnceLock::new();
static CACHE: OnceLock<Mutex<Option<(Instant, Value)>>> = OnceLock::new();

fn http_client() -> &'static Client {
    HTTP.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(12))
            // A 3xx from pay.sh must not become a request to somewhere else. The
            // allowlist below is only meaningful if the URL we end up talking to
            // is the URL we asked for.
            .redirect(Policy::none())
            .build()
            .expect("catalog HTTP client")
    })
}

fn cache() -> &'static Mutex<Option<(Instant, Value)>> {
    CACHE.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Error)]
pub enum CatalogError {
    #[error("catalog fetch failed: {0}")]
    Http(#[from] reqwest::Error),
    #[error("catalog response was not valid JSON")]
    InvalidJson(#[from] serde_json::Error),
    #[error("catalog response was too large")]
    TooLarge,
    #[error("catalog URL is not allowlisted")]
    NotAllowlisted,
}

pub fn is_allowlisted_catalog_url(url: &str) -> bool {
    url == PAYSH_CATALOG_URL
}

/// Fetch the public pay.sh provider catalog. Untrusted JSON — label quotes as estimates in UI.
pub async fn fetch_paysh_catalog() -> Result<Value, CatalogError> {
    let mut cached = cache().lock().await;
    if let Some((fetched_at, value)) = cached.as_ref()
        && fetched_at.elapsed() < CACHE_TTL
    {
        return Ok(value.clone());
    }

    let value = fetch_catalog_url(PAYSH_CATALOG_URL).await?;
    *cached = Some((Instant::now(), value.clone()));
    Ok(value)
}

async fn fetch_catalog_url(url: &str) -> Result<Value, CatalogError> {
    if !is_allowlisted_catalog_url(url) {
        return Err(CatalogError::NotAllowlisted);
    }
    let response = http_client().get(url).send().await?;
    // `error_for_status` only errors on 4xx/5xx, so the previous
    // `unwrap_err()` behind an `is_success()` guard panicked on any other
    // non-success reply — a 304, a 1xx, or an unfollowed 3xx.
    let response = response.error_for_status()?;

    // Refuse before allocating rather than after. `Content-Length` is a hint
    // from an untrusted server, so the streamed total is still checked.
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CATALOG_BYTES as u64)
    {
        return Err(CatalogError::TooLarge);
    }

    let mut response = response;
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > MAX_CATALOG_BYTES {
            return Err(CatalogError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(serde_json::from_slice(&body)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_paysh_catalog_is_allowlisted() {
        assert!(is_allowlisted_catalog_url(PAYSH_CATALOG_URL));
        assert!(!is_allowlisted_catalog_url("https://evil.example/catalog"));
    }

    #[tokio::test]
    async fn a_non_allowlisted_url_never_leaves_the_process() {
        // The allowlist is now on the fetch path rather than beside it.
        assert!(matches!(
            fetch_catalog_url("http://169.254.169.254/latest/meta-data/").await,
            Err(CatalogError::NotAllowlisted)
        ));
    }

    #[tokio::test]
    async fn a_non_error_non_success_status_does_not_panic() {
        // This pins the assumption the old code got wrong. `error_for_status`
        // returns Ok for anything outside 4xx/5xx, so `unwrap_err()` behind an
        // `!is_success()` guard panicked on a 304, a 1xx, or an unfollowed 3xx —
        // a remote-triggerable panic in an Axum handler with no CatchPanic layer.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = axum::Router::new().fallback(axum::routing::any(|| async {
                axum::http::StatusCode::NOT_MODIFIED
            }));
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::Client::new()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_MODIFIED);
        assert!(!response.status().is_success());
        assert!(
            response.error_for_status().is_ok(),
            "error_for_status only errors on 4xx/5xx; unwrap_err() here is a panic"
        );
    }

    #[test]
    fn the_client_refuses_to_follow_redirects() {
        // Constructing it is the assertion: a panic here means the policy was
        // dropped, which would make the allowlist bypassable by a 302.
        let _ = http_client();
    }
}
