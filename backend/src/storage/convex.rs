//! Server-to-server storage transport. Never retries a mutation: a timed-out
//! reservation may already have committed and must be reconciled by its ID.
use super::StorageError;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub struct ConvexStore {
    client: reqwest::Client,
    endpoint: String,
    secret: String,
}

impl std::fmt::Debug for ConvexStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConvexStore").finish_non_exhaustive()
    }
}

pub fn encode<T: Serialize>(value: &T) -> Result<String, StorageError> {
    serde_json::to_string(value).map_err(|_| StorageError::Remote("invalid storage record".into()))
}

pub fn decode<T: DeserializeOwned>(value: &str) -> Result<T, StorageError> {
    serde_json::from_str(value).map_err(|_| StorageError::Remote("invalid storage response".into()))
}

impl ConvexStore {
    pub fn new(url: &str, secret: String) -> Result<Self, StorageError> {
        let url = reqwest::Url::parse(url)
            .map_err(|_| StorageError::Remote("invalid CHAINPAY_CONVEX_SITE_URL".into()))?;
        let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if (url.scheme() != "https" && !(local && url.scheme() == "http"))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
            || secret.len() < 32
        {
            return Err(StorageError::Remote(
                "invalid Convex URL or service credential".into(),
            ));
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| StorageError::Remote("storage client initialization failed".into()))?,
            endpoint: format!("{}internal/storage/v1", url.as_str()),
            secret,
        })
    }

    pub async fn call<T: DeserializeOwned>(
        &self,
        operation: &str,
        args: Value,
    ) -> Result<T, StorageError> {
        let response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(&self.secret)
            .json(&json!({"operation":operation,"args":args}))
            .send()
            .await
            .map_err(|_| {
                StorageError::Remote(
                    "storage outcome uncertain; reconcile the original operation".into(),
                )
            })?;
        if !response.status().is_success() {
            return Err(StorageError::Remote(format!(
                "storage request rejected ({})",
                response.status().as_u16()
            )));
        }
        let body: Value = response.json().await.map_err(|_| {
            StorageError::Remote("storage outcome uncertain; invalid response".into())
        })?;
        let value = body
            .get("value")
            .ok_or_else(|| StorageError::Remote("invalid storage envelope".into()))?;
        serde_json::from_value(value.clone())
            .map_err(|_| StorageError::Remote("invalid storage value".into()))
    }

    pub async fn record<T: DeserializeOwned>(
        &self,
        operation: &str,
        args: Value,
    ) -> Result<Option<T>, StorageError> {
        let value: Option<String> = self.call(operation, args).await?;
        value.as_deref().map(decode).transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::{ManagedSignerRecord, ManagedSignerStatus, SigningMode};
    use crate::storage::{StatusStore, StorageBackend};
    use axum::{Json, Router, routing::post};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn signer_storage_retains_private_provider_metadata_and_claims_are_lossless() {
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let saved = calls.clone();
        let app = Router::new().route("/internal/storage/v1", post(move |Json(body): Json<Value>| {
            let saved = saved.clone();
            async move {
                saved.lock().unwrap().push(body.clone());
                if body["operation"] == "claim_operation" {
                    Json(json!({"value":[true,"owner",body["args"]["intent_json"],body["args"]["initial_json"]]}))
                } else { Json(json!({"value":null})) }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let store = StatusStore {
            backend: StorageBackend::Convex(ConvexStore::new(&url, "s".repeat(48)).unwrap()),
        };
        let intent = json!({"amount":u64::MAX});
        let claim = store
            .claim_operation(
                "id",
                "owner",
                intent.clone(),
                json!({"nested":{"slot":u64::MAX}}),
            )
            .await
            .unwrap();
        assert!(claim.0);
        assert_eq!(claim.2, intent);
        assert_eq!(claim.3["nested"]["slot"].as_u64(), Some(u64::MAX));
        let signer = ManagedSignerRecord {
            signer_id: "s".into(),
            owner_wallet: "owner".into(),
            public_key: "public".into(),
            provider: "privy".into(),
            provider_wallet_id: "private-provider-id".into(),
            provider_policy_id: "private-policy-id".into(),
            mandate_pda: "mandate".into(),
            signing_mode: SigningMode::Delegated,
            status: ManagedSignerStatus::Active,
            created_at_ms: 1,
            updated_at_ms: 1,
            revoked_at_ms: None,
        };
        assert!(
            serde_json::to_value(&signer)
                .unwrap()
                .get("provider_wallet_id")
                .is_none()
        );
        store.put_managed_signer(signer).await.unwrap();
        let data = calls.lock().unwrap();
        let stored: Value = decode(data[1]["args"]["signer_json"].as_str().unwrap()).unwrap();
        assert_eq!(stored["provider_wallet_id"], "private-provider-id");
        assert_eq!(stored["provider_policy_id"], "private-policy-id");
        task.abort();
    }

    #[test]
    fn refuses_credentials_in_urls_and_insecure_remote_transport() {
        assert!(ConvexStore::new("https://secret@example.com", "s".repeat(48)).is_err());
        assert!(ConvexStore::new("http://example.com", "s".repeat(48)).is_err());
        assert!(ConvexStore::new("https://example.com", "short".into()).is_err());
        let client = ConvexStore::new("https://example.com", "secret".repeat(8)).unwrap();
        assert!(!format!("{client:?}").contains("secret"));
    }
}
