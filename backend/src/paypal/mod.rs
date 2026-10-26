//! Isolated PayPal sandbox extension. Never initializes the existing relay store.
pub mod ai;
pub mod allowance;
pub mod analytics;
pub mod catalog;
pub mod config;
pub mod disputes;
pub mod domain;
pub mod money;
pub mod observations;
pub mod provider;
pub mod routes;
pub mod store;
pub mod wallet;

use axum::{Json, Router, http::StatusCode, routing::get};
use serde_json::json;

pub fn disabled_router() -> Router {
    Router::new().route(
        "/healthz",
        get(|| async {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status":"disabled","service":"chainpay-paypal","sandbox":true})),
            )
        }),
    )
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn disabled_routes_do_not_expose_existing_or_paypal_payment_apis() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, super::disabled_router())
                .await
                .unwrap()
        });
        let client = reqwest::Client::new();
        for path in [
            "/v1/paypal/orders",
            "/v1/payments",
            "/rpc",
            "/v1/auth/session",
        ] {
            assert_eq!(
                client
                    .post(format!("http://{addr}{path}"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                404
            );
        }
        assert_eq!(
            client
                .get(format!("http://{addr}/healthz"))
                .send()
                .await
                .unwrap()
                .status(),
            503
        );
        task.abort();
    }
}

pub mod services;

pub mod subscriptions;

pub mod resolution;

pub mod reporting;
