//! HTTP client abstraction used by [`crate::collateral`].
//!
//! The `HttpClient` trait keeps `reqwest` (and its types / version) out
//! of this crate's public API surface. The default-path constructors
//! ([`with_default_http`](crate::collateral::CollateralClient::<crate::configs::DefaultConfig>::with_default_http),
//! [`from_env`](crate::collateral::CollateralClient::<crate::configs::DefaultConfig>::from_env))
//! still use `reqwest` internally, but no public function signature
//! mentions `reqwest::Client` — so a future `reqwest` major bump is an
//! internal change, not a breaking one for downstream callers.
//!
//! Callers that need a custom HTTP stack (different TLS config,
//! workspace-pinned `reqwest` major, non-`reqwest` transport, wasm host
//! fetch, …) implement [`HttpClient`] on their own type and pass it to
//! [`CollateralClient::new`](crate::collateral::CollateralClient::new).
//!
//! The trait is deliberately narrow — it covers only what
//! [`crate::collateral`] needs: a `GET`, plus access to status, named
//! headers, and the response body.

use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use anyhow::Result;

/// Owned HTTP response.
///
/// Bodies are buffered into memory: the PCCS endpoints used by this crate
/// return small payloads (≤ a few hundred KiB), so streaming is not worth
/// the abstraction cost.
pub struct HttpResponse {
    /// HTTP status code (e.g. `200`).
    pub status: u16,
    /// Response headers. Use [`HttpResponse::header`] for
    /// case-insensitive lookups; the field itself imposes no
    /// case-normalization invariant on implementations.
    pub headers: BTreeMap<String, String>,
    /// Response body bytes.
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// Case-insensitive header lookup. O(n) over header count — header
    /// counts are small (typically < 20), so a linear scan is cheaper
    /// than imposing a normalization invariant on every implementation.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// `true` if [`status`](Self::status) is in `200..300`.
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Decode the body as UTF-8.
    pub fn text(&self) -> Result<&str> {
        Ok(core::str::from_utf8(&self.body)?)
    }
}

/// HTTP transport used by [`CollateralClient`](crate::collateral::CollateralClient).
///
/// Implementations only need to support `GET`; the crate buffers
/// responses in memory (see [`HttpResponse`]).
///
/// The `async fn` here intentionally has no `Send` bound. Auto-traits
/// propagate through monomorphization, so callers using a `Send` impl
/// still get `Send` futures automatically; callers on single-threaded
/// runtimes don't pay the `Send` bound they don't need.
#[allow(async_fn_in_trait)]
pub trait HttpClient {
    /// Issue a GET request and buffer the full response.
    async fn get(&self, url: &str) -> Result<HttpResponse>;
}
