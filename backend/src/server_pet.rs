//! Anonymous community pet gateway. These tokens never enter wallet auth.
use super::*;
use crate::storage::PetStoreError;
use axum::http::{HeaderMap, Method};
use serde::Deserialize;

#[derive(Clone, Copy)]
pub(super) struct PetEnabled(pub bool);

pub(super) fn is_public_pet_path(method: &Method, path: &str) -> bool {
    matches!(
        (method, path),
        (&Method::GET, "/v1/pet/state" | "/v1/pet/memories")
            | (&Method::POST, "/v1/pet/visitors" | "/v1/pet/act")
    )
}

pub(super) struct PetError(StatusCode, &'static str, Option<u64>);
impl PetError {
    fn new(status: StatusCode, code: &'static str) -> Self {
        Self(status, code, None)
    }
    fn limited(seconds: u64) -> Self {
        Self(StatusCode::TOO_MANY_REQUESTS, "rate_limited", Some(seconds))
    }
}
impl IntoResponse for PetError {
    fn into_response(self) -> Response {
        let mut response = (self.0, Json(json!({"error": {"code": self.1}}))).into_response();
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some(seconds) = self.2 {
            response.headers_mut().insert(
                header::RETRY_AFTER,
                HeaderValue::from_str(&seconds.to_string()).unwrap(),
            );
        }
        response
    }
}
impl From<PetStoreError> for PetError {
    fn from(error: PetStoreError) -> Self {
        match error {
            PetStoreError::Rejected { code, retry_after } => match code.as_str() {
                "unauthorized" | "expired" => Self::new(StatusCode::UNAUTHORIZED, "unauthorized"),
                "rate_limited" => Self(StatusCode::TOO_MANY_REQUESTS, "rate_limited", retry_after),
                "conflict" => Self::new(StatusCode::CONFLICT, "conflict"),
                "invalid_argument" => Self::new(StatusCode::BAD_REQUEST, "invalid_argument"),
                _ => Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
            },
            PetStoreError::Unavailable => Self::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        }
    }
}
fn enabled(flag: PetEnabled) -> Result<(), PetError> {
    if flag.0 {
        Ok(())
    } else {
        Err(PetError::new(StatusCode::SERVICE_UNAVAILABLE, "disabled"))
    }
}
fn digest(value: &str) -> String {
    hex_encode(&Sha256::digest(value.as_bytes()))
}
fn peer_hash(headers: &HeaderMap) -> String {
    // Auth middleware always replaces this header using trusted connection data.
    digest(
        headers
            .get("x-chainpay-peer")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("unknown-peer"),
    )
}
fn token_hash(headers: &HeaderMap) -> Result<String, PetError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer cp_pet_"))
        .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or(PetError::new(StatusCode::UNAUTHORIZED, "unauthorized"))?;
    Ok(digest(&format!("cp_pet_{token}")))
}

pub(super) async fn state(
    State(state): State<BackendState>,
    Extension(flag): Extension<PetEnabled>,
    headers: HeaderMap,
) -> Result<Json<Value>, PetError> {
    enabled(flag)?;
    read_budget(&state, &headers).await?;
    Ok(Json(state.store.pet_call("pet.state", json!({})).await?))
}

/// Uses the existing durable limiter, so cold starts cannot reset a peer's budget.
async fn read_budget(state: &BackendState, headers: &HeaderMap) -> Result<(), PetError> {
    let now = now_ms();
    let allowed = state
        .store
        .auth_rate(&format!("pet-public-read:{}", peer_hash(headers)), now, 600)
        .await
        .map_err(|_| PetError::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?;
    if allowed {
        Ok(())
    } else {
        Err(PetError::limited((60_000 - now % 60_000).div_ceil(1_000)))
    }
}
pub(super) async fn visitor(
    State(state): State<BackendState>,
    Extension(flag): Extension<PetEnabled>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<Value>), PetError> {
    enabled(flag)?;
    let token = format!(
        "cp_pet_{}",
        random_hex_32()
            .map_err(|_| PetError::new(StatusCode::SERVICE_UNAVAILABLE, "unavailable"))?
    );
    let result = state
        .store
        .pet_call(
            "pet.visitors",
            json!({"tokenHash": digest(&token), "peerHash": peer_hash(&headers)}),
        )
        .await?;
    let expires_at = result
        .get("expiresAt")
        .and_then(Value::as_u64)
        .ok_or(PetError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
        ))?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"token": token, "expiresAt": expires_at})),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ActionInput {
    command_id: String,
    action: String,
}
fn valid_command_id(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36
        && b[14] == b'4'
        && matches!(b[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
        && b.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
pub(super) async fn act(
    State(state): State<BackendState>,
    Extension(flag): Extension<PetEnabled>,
    headers: HeaderMap,
    input: Result<Json<ActionInput>, axum::extract::rejection::JsonRejection>,
) -> Result<Json<Value>, PetError> {
    enabled(flag)?;
    let token_hash = token_hash(&headers)?;
    let Json(input) = input.map_err(|error| {
        PetError::new(
            if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                StatusCode::PAYLOAD_TOO_LARGE
            } else {
                StatusCode::BAD_REQUEST
            },
            "invalid_argument",
        )
    })?;
    if !valid_command_id(&input.command_id)
        || !matches!(
            input.action.as_str(),
            "charge"
                | "play"
                | "polish"
                | "pat"
                | "ball"
                | "collect"
                | "coin"
                | "game"
                | "secret"
                | "wake"
        )
    {
        return Err(PetError::new(StatusCode::BAD_REQUEST, "invalid_argument"));
    }
    Ok(Json(state.store.pet_call("pet.act", json!({"tokenHash": token_hash, "commandId": input.command_id, "action": input.action})).await?))
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct MemoryQuery {
    before: Option<u64>,
    limit: Option<u8>,
}
pub(super) async fn memories(
    State(state): State<BackendState>,
    Extension(flag): Extension<PetEnabled>,
    headers: HeaderMap,
    input: Result<Query<MemoryQuery>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Value>, PetError> {
    enabled(flag)?;
    let Query(input) =
        input.map_err(|_| PetError::new(StatusCode::BAD_REQUEST, "invalid_argument"))?;
    if input.limit.is_some_and(|n| n == 0 || n > 50)
        || input.before.is_some_and(|n| n > 9_007_199_254_740_991)
    {
        return Err(PetError::new(StatusCode::BAD_REQUEST, "invalid_argument"));
    }
    read_budget(&state, &headers).await?;
    let mut args = json!({"limit": input.limit.unwrap_or(20)});
    if let Some(before) = input.before {
        args["before"] = json!(before);
    }
    Ok(Json(state.store.pet_call("pet.memories", args).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn fixture(store: StatusStore) -> BackendState {
        let mut config = BackendConfig::from_env().unwrap();
        config.trusted_proxy_hops = 0;
        config.allowed_origins = vec!["http://localhost:5173".into()];
        BackendState::new(config, store).unwrap()
    }

    async fn serve(app: Router) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        (url, task)
    }

    #[test]
    fn public_paths_and_input_validation_are_narrow() {
        for path in ["/v1/pet/state", "/v1/pet/memories"] {
            assert!(is_public_pet_path(&Method::GET, path));
            assert!(!is_public_pet_path(&Method::POST, path));
        }
        assert!(!is_public_pet_path(&Method::GET, "/v1/pet/state/private"));
        assert!(!is_public_pet_path(&Method::DELETE, "/v1/pet/act"));
        assert!(!is_public_pet_path(&Method::GET, "/v1/payments"));
        assert!(valid_command_id("12345678-1234-4234-8234-123456789abc"));
        for id in ["", "x", "12345678-1234-1234-8234-123456789abc"] {
            assert!(!valid_command_id(id));
        }
        assert!(
            serde_json::from_value::<ActionInput>(
                json!({"commandId":"id","action":"charge","needs":{"battery":100}})
            )
            .is_err()
        );
    }

    #[tokio::test]
    async fn flag_and_unsupported_store_never_create_local_worlds() {
        let (url, task) = serve(build_router_with_pet(
            fixture(StatusStore::in_memory()),
            false,
        ))
        .await;
        let client = reqwest::Client::new();
        let response = client
            .get(format!("{url}/v1/pet/state"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(
            response.json::<Value>().await.unwrap()["error"]["code"],
            "disabled"
        );
        task.abort();
        let (url, task) = serve(build_router_with_pet(
            fixture(StatusStore::in_memory()),
            true,
        ))
        .await;
        assert_eq!(
            client
                .get(format!("{url}/v1/pet/state"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        task.abort();
    }

    #[tokio::test]
    async fn gateway_hashes_tokens_trusts_socket_peer_and_never_grants_financial_access() {
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let seen = calls.clone();
        let mock = Router::new().route(
            "/internal/storage/v1",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let calls = seen.clone();
                async move {
                    assert_eq!(
                        headers[header::AUTHORIZATION],
                        "Bearer pet-test-service-secret-not-for-deployment"
                    );
                    calls.lock().unwrap().push(body.clone());
                    let value = match body["operation"].as_str().unwrap() {
                        "auth_rate" => json!(true),
                        "pet.state" => json!({"revision":12,"serverTime":1000}),
                        "pet.visitors" => json!({"expiresAt":9999999999999_u64}),
                        "pet.act" => {
                            json!({"state":{"revision":13},"outcome":"accepted","replayed":false})
                        }
                        "pet.memories" => json!({"memories":[],"nextBefore":null,"aggregates":[]}),
                        "get_auth" | "auth_connection" => Value::Null,
                        operation => panic!("unexpected operation {operation}"),
                    };
                    Json(json!({"value":value}))
                }
            }),
        );
        let (storage_url, storage_task) = serve(mock).await;
        let (url, task) = serve(build_router_with_pet(
            fixture(StatusStore::pet_test_store(&storage_url)),
            true,
        ))
        .await;
        let client = reqwest::Client::new();
        let state = client
            .get(format!("{url}/v1/pet/state"))
            .send()
            .await
            .unwrap();
        assert_eq!(state.status(), StatusCode::OK);
        assert_eq!(state.json::<Value>().await.unwrap()["revision"], 12);
        let visitor = client
            .post(format!("{url}/v1/pet/visitors"))
            .header("x-chainpay-peer", "attacker-chosen")
            .header("x-forwarded-for", "8.8.8.8")
            .send()
            .await
            .unwrap();
        assert_eq!(visitor.status(), StatusCode::CREATED);
        let visitor = visitor.json::<Value>().await.unwrap();
        let token = visitor["token"].as_str().unwrap();
        assert!(token.starts_with("cp_pet_"));
        let sent = calls
            .lock()
            .unwrap()
            .iter()
            .find(|v| v["operation"] == "pet.visitors")
            .unwrap()
            .clone();
        assert_eq!(sent["args"]["tokenHash"], digest(token));
        assert_eq!(sent["args"]["peerHash"], digest("127.0.0.1"));
        assert!(!sent.to_string().contains(token));
        let command = json!({"commandId":"12345678-1234-4234-8234-123456789abc","action":"charge"});
        assert_eq!(
            client
                .post(format!("{url}/v1/pet/act"))
                .json(&command)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .post(format!("{url}/v1/pet/act"))
                .bearer_auth("wallet-session-token-that-is-not-a-pet-session")
                .json(&command)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let action = client
            .post(format!("{url}/v1/pet/act"))
            .bearer_auth(token)
            .json(&command)
            .send()
            .await
            .unwrap();
        assert_eq!(action.status(), StatusCode::OK);
        assert_eq!(action.json::<Value>().await.unwrap()["outcome"], "accepted");
        let mut forged = command.clone();
        forged["serverTime"] = json!(0);
        assert_eq!(
            client
                .post(format!("{url}/v1/pet/act"))
                .bearer_auth(token)
                .json(&forged)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        for malformed in ["{", "[]", "{\"action\":123}"] {
            let response = client
                .post(format!("{url}/v1/pet/act"))
                .bearer_auth(token)
                .header(header::CONTENT_TYPE, "application/json")
                .body(malformed)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(
                response.json::<Value>().await.unwrap()["error"]["code"],
                "invalid_argument"
            );
        }
        for query in ["limit=bad", "before=-1", "unknown=value"] {
            let response = client
                .get(format!("{url}/v1/pet/memories?{query}"))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
            assert_eq!(
                response.json::<Value>().await.unwrap()["error"]["code"],
                "invalid_argument"
            );
        }
        assert_eq!(
            client
                .get(format!("{url}/v1/auth/principal"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{url}/v1/pet/memories?limit=51"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            client
                .get(format!("{url}/v1/pet/memories?limit=2&before=1000"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let sent = calls.lock().unwrap().clone();
        let action = sent.iter().find(|v| v["operation"] == "pet.act").unwrap();
        assert_eq!(
            action["args"],
            json!({"tokenHash":digest(token),"commandId":command["commandId"],"action":"charge"})
        );
        task.abort();
        storage_task.abort();
    }

    #[tokio::test]
    async fn storage_rejections_are_sanitized_and_not_retried() {
        for (code, expected) in [
            ("unauthorized", StatusCode::UNAUTHORIZED),
            ("rate_limited", StatusCode::TOO_MANY_REQUESTS),
            ("conflict", StatusCode::CONFLICT),
            ("invalid_argument", StatusCode::BAD_REQUEST),
            ("maintenance", StatusCode::SERVICE_UNAVAILABLE),
        ] {
            let count = Arc::new(Mutex::new(0));
            let seen = count.clone();
            let mock = Router::new().route(
                "/internal/storage/v1",
                post(move || {
                    let seen = seen.clone();
                    async move {
                        *seen.lock().unwrap() += 1;
                        (
                            StatusCode::BAD_REQUEST,
                            Json(
                                json!({"error":{"code":code,"message":"private-provider-payload","retryAfterSeconds":3600}}),
                            ),
                        )
                    }
                }),
            );
            let (storage_url, storage_task) = serve(mock).await;
            let (url, task) = serve(build_router_with_pet(
                fixture(StatusStore::pet_test_store(&storage_url)),
                true,
            ))
            .await;
            let response = reqwest::Client::new()
                .post(format!("{url}/v1/pet/act"))
                .bearer_auth(format!("cp_pet_{}", "a".repeat(64)))
                .json(&json!({"commandId":"12345678-1234-4234-8234-123456789abc","action":"pat"}))
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            if code == "rate_limited" {
                assert_eq!(response.headers()[header::RETRY_AFTER], "3600");
            }
            assert!(!response.text().await.unwrap().contains("private-provider"));
            assert_eq!(*count.lock().unwrap(), 1);
            task.abort();
            storage_task.abort();
        }
    }

    #[tokio::test]
    async fn public_read_budget_is_shared_across_routes_and_checked_before_forwarding() {
        let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
        let seen = calls.clone();
        let mock = Router::new().route(
            "/internal/storage/v1",
            post(move |Json(body): Json<Value>| {
                let calls = seen.clone();
                async move {
                    let mut calls = calls.lock().unwrap();
                    calls.push(body.clone());
                    let value = if body["operation"] == "auth_rate" {
                        assert_eq!(
                            body["args"]["bucket"],
                            format!("pet-public-read:{}", digest("127.0.0.1"))
                        );
                        assert_eq!(body["args"]["limit"], "600");
                        json!(
                            calls
                                .iter()
                                .filter(|c| c["operation"] == "auth_rate")
                                .count()
                                == 1
                        )
                    } else {
                        assert_eq!(body["operation"], "pet.state");
                        json!({"revision":1})
                    };
                    Json(json!({"value":value}))
                }
            }),
        );
        let (storage_url, storage_task) = serve(mock).await;
        let (url, task) = serve(build_router_with_pet(
            fixture(StatusStore::pet_test_store(&storage_url)),
            true,
        ))
        .await;
        assert_eq!(
            reqwest::get(format!("{url}/v1/pet/state"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let response = reqwest::Client::new()
            .get(format!("{url}/v1/pet/memories"))
            .header("x-chainpay-peer", "forged")
            .header(header::ORIGIN, "http://localhost:5173")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_EXPOSE_HEADERS],
            "retry-after"
        );
        let retry = response.headers()[header::RETRY_AFTER]
            .to_str()
            .unwrap()
            .parse::<u64>()
            .unwrap();
        assert!((1..=60).contains(&retry));
        assert_eq!(
            response.json::<Value>().await.unwrap()["error"]["code"],
            "rate_limited"
        );
        assert!(
            !calls
                .lock()
                .unwrap()
                .iter()
                .any(|c| c["operation"] == "pet.memories")
        );
        task.abort();
        storage_task.abort();
    }
}
