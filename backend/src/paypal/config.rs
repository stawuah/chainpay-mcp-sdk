//! Configuration is deliberately independent of BackendConfig and DATABASE_URL.
use std::{net::SocketAddr, time::Duration};

pub const SANDBOX_API: &str = "https://api-m.sandbox.paypal.com";

// No Debug: this value contains credentials.
#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub client_id: String,
    pub client_secret: String,
    pub webhook_id: String,
    pub public_origin: String,
    pub new_purchases: bool,
    pub subscriptions: bool,
    pub subscription_plan: Option<String>,
    pub allowances: bool,
    /// Wallet sign-in through the ChainPay relay session; off unless flagged.
    pub wallet_login: bool,
    pub relay_url: Option<String>,
    /// Exact extra browser origins (CORS and the wallet bridge), e.g. the main site.
    pub extra_origins: Vec<String>,
}

impl Config {
    pub fn from_env() -> Result<Option<Self>, String> {
        Self::parse(|key| std::env::var(key).ok())
    }

    pub fn parse(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        if !flag(&get, "CHAINPAY_PAYPAL_ENABLED", false)? {
            return Ok(None);
        }
        let required = |name: &str| {
            get(name)
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| format!("{name} is required for the isolated PayPal service"))
        };
        if get("PAYPAL_API_BASE").is_some_and(|s| s != SANDBOX_API) {
            return Err("PAYPAL_API_BASE must be the PayPal sandbox origin".into());
        }
        let database_url = required("CHAINPAY_PAYPAL_DATABASE_URL")?;
        let db = url::Url::parse(&database_url)
            .map_err(|_| "CHAINPAY_PAYPAL_DATABASE_URL must be a PostgreSQL URL")?;
        if !matches!(db.scheme(), "postgres" | "postgresql")
            || db.host_str().is_none()
            || !db.path().starts_with("/chainpay_paypal_")
            || db.path().len() <= "/chainpay_paypal_".len()
            || db.path()[1..].contains('/')
            || db
                .query_pairs()
                .any(|(k, _)| matches!(k.as_ref(), "dbname" | "options" | "host" | "hostaddr"))
        {
            return Err(
                "PayPal requires a dedicated database named chainpay_paypal_<environment>".into(),
            );
        }
        let public_origin = required("CHAINPAY_PAYPAL_PUBLIC_ORIGIN")?;
        let origin = explicit_origin(&public_origin)
            .ok_or("CHAINPAY_PAYPAL_PUBLIC_ORIGIN must be an explicit HTTP(S) origin")?;
        if origin.host_str().is_some_and(|h| {
            h.contains('*') || h == "chainpayai.app" || h.ends_with(".chainpayai.app")
        }) {
            return Err("PayPal requires a separate HTTPS origin (HTTP only on localhost)".into());
        }
        // Extra origins are callers only; the service's own origin stays separate.
        let mut extra_origins = Vec::new();
        for raw in get("CHAINPAY_PAYPAL_EXTRA_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let extra = explicit_origin(raw)
                .filter(|u| u.host_str().is_some_and(|h| !h.contains('*')))
                .ok_or("CHAINPAY_PAYPAL_EXTRA_ORIGINS must list exact HTTPS origins (HTTP only on localhost)")?
                .origin()
                .ascii_serialization();
            if extra_origins.len() >= 10 {
                return Err("CHAINPAY_PAYPAL_EXTRA_ORIGINS allows at most 10 origins".into());
            }
            if !extra_origins.contains(&extra) {
                extra_origins.push(extra);
            }
        }
        let wallet_login = flag(&get, "CHAINPAY_PAYPAL_WALLET_LOGIN", false)?;
        let relay_url = if wallet_login {
            let raw = required("CHAINPAY_PAYPAL_RELAY_URL")?;
            Some(
                explicit_origin(&raw)
                    .ok_or("CHAINPAY_PAYPAL_RELAY_URL must be an HTTPS origin (HTTP only on localhost)")?
                    .origin()
                    .ascii_serialization(),
            )
        } else {
            None
        };
        Ok(Some(Self {
            database_url,
            client_id: required("PAYPAL_CLIENT_ID")?,
            client_secret: required("PAYPAL_CLIENT_SECRET")?,
            webhook_id: required("PAYPAL_WEBHOOK_ID")?,
            public_origin: origin.origin().ascii_serialization(),
            new_purchases: flag(&get, "CHAINPAY_PAYPAL_NEW_PURCHASES", false)?,
            subscriptions: flag(&get, "CHAINPAY_PAYPAL_SUBSCRIPTIONS", false)?,
            subscription_plan: if flag(&get, "CHAINPAY_PAYPAL_SUBSCRIPTIONS", false)? {
                Some(required("CHAINPAY_PAYPAL_SUBSCRIPTION_PLAN")?)
            } else {
                None
            },
            allowances: flag(&get, "CHAINPAY_PAYPAL_ALLOWANCES", false)?,
            wallet_login,
            relay_url,
            extra_origins,
        }))
    }
    /// Browser origins allowed to call the API: our own first, then the extras.
    pub fn allowed_origins(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.public_origin.as_str())
            .chain(self.extra_origins.iter().map(String::as_str))
    }
}

/// HTTPS origin with no path, query or credentials; HTTP only on localhost.
fn explicit_origin(raw: &str) -> Option<url::Url> {
    let origin = url::Url::parse(raw).ok()?;
    let local = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (origin.scheme() != "https" && !(local && origin.scheme() == "http"))
        || origin.host_str().is_none()
        || !origin.username().is_empty()
        || origin.password().is_some()
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
    {
        return None;
    }
    Some(origin)
}

fn flag(get: &impl Fn(&str) -> Option<String>, name: &str, default: bool) -> Result<bool, String> {
    match get(name).as_deref() {
        None => Ok(default),
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        _ => Err(format!("{name} must be true or false")),
    }
}

pub fn bind_address() -> Result<SocketAddr, String> {
    let host = std::env::var("CHAINPAY_PAYPAL_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = std::env::var("PORT").unwrap_or_else(|_| "8081".into());
    format!("{host}:{port}")
        .parse()
        .map_err(|_| "Invalid PayPal bind address".into())
}

pub fn http_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(25))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn values() -> HashMap<&'static str, &'static str> {
        HashMap::from([
            ("CHAINPAY_PAYPAL_ENABLED", "true"),
            (
                "CHAINPAY_PAYPAL_DATABASE_URL",
                "postgresql://localhost/chainpay_paypal_test",
            ),
            ("PAYPAL_CLIENT_ID", "fixture-id"),
            ("PAYPAL_CLIENT_SECRET", "fixture-secret"),
            ("PAYPAL_WEBHOOK_ID", "fixture-webhook"),
            (
                "CHAINPAY_PAYPAL_PUBLIC_ORIGIN",
                "https://paypal.example.com",
            ),
        ])
    }

    #[test]
    fn default_off_does_not_read_any_provider_or_database_setting() {
        assert!(
            Config::parse(|key| {
                assert_eq!(key, "CHAINPAY_PAYPAL_ENABLED");
                None
            })
            .unwrap()
            .is_none()
        );
    }

    #[test]
    fn enabled_is_explicit_and_purchases_still_default_off() {
        let v = values();
        let c = Config::parse(|k| v.get(k).map(|s| s.to_string()))
            .unwrap()
            .unwrap();
        assert!(!c.new_purchases);
        assert!(!c.subscriptions);
        assert!(c.subscription_plan.is_none());
        assert!(!c.allowances);
        assert!(!c.wallet_login);
        assert!(c.relay_url.is_none());
        assert!(c.extra_origins.is_empty());
        assert_eq!(c.public_origin, "https://paypal.example.com");
    }

    #[test]
    fn wallet_login_needs_its_flag_and_an_https_relay() {
        let mut v = values();
        v.insert("CHAINPAY_PAYPAL_RELAY_URL", "https://relay.example.com");
        let c = Config::parse(|k| v.get(k).map(|s| s.to_string()))
            .unwrap()
            .unwrap();
        assert!(!c.wallet_login);
        assert!(c.relay_url.is_none());
        v.insert("CHAINPAY_PAYPAL_WALLET_LOGIN", "true");
        let c = Config::parse(|k| v.get(k).map(|s| s.to_string()))
            .unwrap()
            .unwrap();
        assert_eq!(c.relay_url.as_deref(), Some("https://relay.example.com"));
        for ok in ["http://localhost:8787", "http://127.0.0.1:8787"] {
            v.insert("CHAINPAY_PAYPAL_RELAY_URL", ok);
            assert!(
                Config::parse(|k| v.get(k).map(|s| s.to_string())).is_ok(),
                "{ok}"
            );
        }
        for bad in [
            "http://relay.example.com",
            "https://relay.example.com/v1",
            "https://user:pw@relay.example.com",
            "https://relay.example.com?x=1",
            "relay.example.com",
        ] {
            v.insert("CHAINPAY_PAYPAL_RELAY_URL", bad);
            assert!(
                Config::parse(|k| v.get(k).map(|s| s.to_string())).is_err(),
                "{bad}"
            );
        }
        v.remove("CHAINPAY_PAYPAL_RELAY_URL");
        assert!(Config::parse(|k| v.get(k).map(|s| s.to_string())).is_err());
        v.insert("CHAINPAY_PAYPAL_WALLET_LOGIN", "yes");
        assert!(Config::parse(|k| v.get(k).map(|s| s.to_string())).is_err());
    }

    #[test]
    fn extra_origins_are_exact_and_never_replace_the_service_origin() {
        let mut v = values();
        v.insert(
            "CHAINPAY_PAYPAL_EXTRA_ORIGINS",
            "https://www.chainpayai.app, http://localhost:5173,https://www.chainpayai.app",
        );
        let c = Config::parse(|k| v.get(k).map(|s| s.to_string()))
            .unwrap()
            .unwrap();
        assert_eq!(
            c.extra_origins,
            ["https://www.chainpayai.app", "http://localhost:5173"]
        );
        assert_eq!(
            c.allowed_origins().collect::<Vec<_>>(),
            [
                "https://paypal.example.com",
                "https://www.chainpayai.app",
                "http://localhost:5173"
            ]
        );
        for bad in [
            "http://www.chainpayai.app",
            "https://www.chainpayai.app/app",
            "https://*.chainpayai.app",
            "*",
            "null",
        ] {
            v.insert("CHAINPAY_PAYPAL_EXTRA_ORIGINS", bad);
            assert!(
                Config::parse(|k| v.get(k).map(|s| s.to_string())).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn subscriptions_require_their_own_flag_and_explicit_plan() {
        let mut v = values();
        v.insert("CHAINPAY_PAYPAL_SUBSCRIPTIONS", "true");
        assert!(Config::parse(|k| v.get(k).map(|s| s.to_string())).is_err());
        v.insert("CHAINPAY_PAYPAL_SUBSCRIPTION_PLAN", "P-FIXTURE");
        let c = Config::parse(|k| v.get(k).map(|s| s.to_string()))
            .unwrap()
            .unwrap();
        assert!(c.subscriptions);
        assert!(!c.new_purchases);
    }

    #[test]
    fn rejects_live_hosts_shared_databases_and_nonisolated_origins() {
        for (key, bad) in [
            ("PAYPAL_API_BASE", "https://api-m.paypal.com"),
            (
                "PAYPAL_API_BASE",
                "https://api-m.sandbox.paypal.com.evil.test",
            ),
            (
                "CHAINPAY_PAYPAL_DATABASE_URL",
                "postgresql://localhost/chainpay",
            ),
            (
                "CHAINPAY_PAYPAL_DATABASE_URL",
                "postgresql://localhost/chainpay_paypal_test?dbname=chainpay",
            ),
            (
                "CHAINPAY_PAYPAL_PUBLIC_ORIGIN",
                "https://www.chainpayai.app",
            ),
            ("CHAINPAY_PAYPAL_PUBLIC_ORIGIN", "https://example.com/path"),
            ("CHAINPAY_PAYPAL_PUBLIC_ORIGIN", "http://example.com"),
            ("CHAINPAY_PAYPAL_ENABLED", "yes"),
            ("CHAINPAY_PAYPAL_NEW_PURCHASES", "yes"),
            ("CHAINPAY_PAYPAL_ALLOWANCES", "on"),
        ] {
            let mut v = values();
            v.insert(key, bad);
            assert!(
                Config::parse(|k| v.get(k).map(|s| s.to_string())).is_err(),
                "accepted {key}"
            );
        }
    }

    #[test]
    fn missing_configuration_never_falls_back_to_existing_relay() {
        for missing in [
            "CHAINPAY_PAYPAL_DATABASE_URL",
            "PAYPAL_CLIENT_SECRET",
            "PAYPAL_WEBHOOK_ID",
            "CHAINPAY_PAYPAL_PUBLIC_ORIGIN",
        ] {
            let mut v = values();
            v.remove(missing);
            v.insert("DATABASE_URL", "postgresql://localhost/chainpay");
            assert!(Config::parse(|k| v.get(k).map(|s| s.to_string())).is_err());
        }
    }
}
