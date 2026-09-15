//! Outbound catalog fetches. Only allowlisted URLs leave Axum.

use std::{sync::OnceLock, time::Duration};

use reqwest::Client;
use serde_json::Value;
use thiserror::Error;

const PAYSH_CATALOG_URL: &str = "https://pay.sh/api/catalog";
const MAX_CATALOG_BYTES: usize = 2 * 1024 * 1024;

static HTTP: OnceLock<Client> = OnceLock::new();

fn http_client() -> &'static Client {
    HTTP.get_or_init(|| {
        Client::builder()
            .timeout(Duration::from_secs(12))
            .build()
            .expect("catalog HTTP client")
    })
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
    let response = http_client().get(PAYSH_CATALOG_URL).send().await?;
    if !response.status().is_success() {
        return Err(CatalogError::Http(
            response.error_for_status().unwrap_err(),
        ));
    }
    let bytes = response.bytes().await?;
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err(CatalogError::TooLarge);
    }
    Ok(serde_json::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_paysh_catalog_is_allowlisted() {
        assert!(is_allowlisted_catalog_url(PAYSH_CATALOG_URL));
        assert!(!is_allowlisted_catalog_url("https://evil.example/catalog"));
    }
}
