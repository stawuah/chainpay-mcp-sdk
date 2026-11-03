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
        let origin = url::Url::parse(&public_origin)
            .map_err(|_| "CHAINPAY_PAYPAL_PUBLIC_ORIGIN must be an explicit HTTP(S) origin")?;
        let local = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if (origin.scheme() != "https" && !(local && origin.scheme() == "http"))
            || origin.host_str().is_none()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || origin.host_str().is_some_and(|h| {
                h.contains('*') || h == "chainpayai.app" || h.ends_with(".chainpayai.app")
            })
        {
            return Err("PayPal requires a separate HTTPS origin (HTTP only on localhost)".into());
        }
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
        }))
    }
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
        assert_eq!(c.public_origin, "https://paypal.example.com");
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
