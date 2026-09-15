//! Origin-bound wallet login. A message signature creates a session, never a payment.
use super::*;
use axum::{extract::Query, http::HeaderMap};
use serde::Deserialize;

#[derive(Clone, Debug, Serialize)]
pub(super) struct Principal {
    pub wallet: String,
    pub scope: Option<Value>,
}

#[derive(Deserialize)]
pub(super) struct LoginChallenge {
    wallet: String,
}
#[derive(Deserialize)]
pub(super) struct LoginProof {
    challenge_id: String,
    signature: String,
}

fn origin(state: &BackendState, headers: &HeaderMap) -> Result<String, ApiError> {
    let value = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    if !state
        .config
        .allowed_origins
        .iter()
        .any(|allowed| allowed == value && allowed != "*")
    {
        return Err(ApiError::Unauthorized);
    }
    Ok(value.into())
}
fn token_hash(token: &str) -> String {
    hex_encode(&Sha256::digest(token.as_bytes()))
}
fn bearer(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| v.len() >= 32 && v.len() <= 256)
        .ok_or(ApiError::Unauthorized)
}

pub(super) async fn challenge(
    State(state): State<BackendState>,
    headers: HeaderMap,
    Query(input): Query<LoginChallenge>,
) -> Result<Json<Value>, ApiError> {
    let origin = origin(&state, &headers)?;
    validate_solana_address(&input.wallet, "wallet")?;
    let now = now_ms();
    let peer = headers
        .get("x-chainpay-peer")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown-peer");
    if !state.store.auth_rate("challenge", now, 1000).await?
        || !state
            .store
            .auth_rate(&format!("challenge-peer:{peer}"), now, 20)
            .await?
    {
        return Err(ApiError::RateLimited);
    }
    let id = random_hex_32()?;
    let expires = now + 300_000;
    let message = format!(
        "ChainPay wallet login\nOrigin: {origin}\nCluster: devnet\nWallet: {}\nNonce: {id}\nExpires: {expires}\n\nSign in for one hour. This message does not authorize a payment or delegate funds.",
        input.wallet
    );
    state
        .store
        .put_auth(
            &format!("challenge:{id}"),
            json!({"wallet":input.wallet,"origin":origin,"message":message}),
            expires,
        )
        .await?;
    Ok(Json(
        json!({"challenge_id":id,"message":message,"expires_at_ms":expires}),
    ))
}

pub(super) async fn login(
    State(state): State<BackendState>,
    headers: HeaderMap,
    Json(input): Json<LoginProof>,
) -> Result<Json<Value>, ApiError> {
    let origin = origin(&state, &headers)?;
    if input.challenge_id.len() != 64 || input.signature.len() > 128 {
        return Err(ApiError::Unauthorized);
    }
    let now = now_ms();
    if !state.store.auth_rate("login", now, 200).await? {
        return Err(ApiError::RateLimited);
    }
    let key = format!("challenge:{}", input.challenge_id);
    let challenge = state
        .store
        .get_auth(&key, now, false)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if challenge["origin"].as_str() != Some(&origin) {
        return Err(ApiError::Unauthorized);
    }
    let wallet = challenge["wallet"].as_str().ok_or(ApiError::Unauthorized)?;
    verify_wallet_message_signature(
        wallet,
        challenge["message"]
            .as_str()
            .ok_or(ApiError::Unauthorized)?
            .as_bytes(),
        &input.signature,
    )
    .map_err(|_| ApiError::Unauthorized)?;
    if state.store.get_auth(&key, now, true).await?.is_none() {
        return Err(ApiError::Unauthorized);
    }
    let token = random_hex_32()?;
    let expires = now + 3_600_000;
    state
        .store
        .put_auth(
            &format!("session:{}", token_hash(&token)),
            json!({"wallet":wallet,"origin":origin,"expires_at_ms":expires}),
            expires,
        )
        .await?;
    Ok(Json(
        json!({"token":token,"wallet":wallet,"expires_at_ms":expires}),
    ))
}

pub(super) async fn session(
    State(state): State<BackendState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let token = bearer(&headers)?;
    let record = state
        .store
        .get_auth(&format!("session:{}", token_hash(token)), now_ms(), false)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if record["origin"].as_str() != Some(origin) {
            return Err(ApiError::Unauthorized);
        }
    }
    Ok(Json(record))
}
pub(super) async fn logout(
    State(state): State<BackendState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    state
        .store
        .get_auth(
            &format!("session:{}", token_hash(bearer(&headers)?)),
            now_ms(),
            true,
        )
        .await?;
    Ok(Json(json!({"revoked":true})))
}

fn valid_scope(scope: &Value) -> bool {
    scope["version"] == 1
        && scope["mandates"].as_array().is_some_and(|values| {
            !values.is_empty() && values.len() <= 20 && values.iter().all(|v| v.as_str().is_some())
        })
        && scope["tools"].as_array().is_some_and(|values| {
            !values.is_empty() && values.len() <= 30 && values.iter().all(|v| v.as_str().is_some())
        })
        && scope["agents"].is_object()
}

pub(super) async fn identify(
    state: &BackendState,
    headers: &HeaderMap,
) -> Result<Principal, ApiError> {
    let token = bearer(headers)?;
    let hash = token_hash(token);
    if let Some(record) = state
        .store
        .get_auth(&format!("session:{hash}"), now_ms(), false)
        .await?
    {
        if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
            if record["origin"].as_str() != Some(origin) {
                return Err(ApiError::Unauthorized);
            }
        }
        return Ok(Principal {
            wallet: record["wallet"]
                .as_str()
                .ok_or(ApiError::Unauthorized)?
                .into(),
            scope: None,
        });
    }
    if let Some(record) = state.store.auth_connection(&hash).await? {
        let scope: Value = serde_json::from_str(record["scope"].as_str().unwrap_or("")).map_err(|_| ApiError::Forbidden("Legacy unscoped connection. Reconnect and select a mandate and permitted tools.".into()))?;
        if !valid_scope(&scope) {
            return Err(ApiError::Unauthorized);
        }
        return Ok(Principal {
            wallet: record["wallet"]
                .as_str()
                .ok_or(ApiError::Unauthorized)?
                .into(),
            scope: Some(scope),
        });
    }
    Err(ApiError::Unauthorized)
}

pub(super) fn owner(principal: &Principal, wallet: &str) -> Result<(), ApiError> {
    if principal.scope.is_some() || principal.wallet != wallet {
        return Err(ApiError::Forbidden("Owner session required".into()));
    }
    Ok(())
}
pub(super) async fn mandate(
    state: &BackendState,
    principal: &Principal,
    address: &str,
    tool: &str,
) -> Result<(), ApiError> {
    if let Some(scope) = &principal.scope {
        if !scope["mandates"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(address)))
            || !scope["tools"].as_array().is_some_and(|a| {
                a.iter().any(|v| {
                    v.as_str() == Some(tool) || (tool == "get_payment" && v == "wait_for_payment")
                })
            })
        {
            return Err(ApiError::Forbidden(
                "Connection does not permit this mandate or tool".into(),
            ));
        }
    }
    validate_solana_address(address, "mandate")?;
    let account = state
        .rpc
        .account_info(address)
        .await?
        .ok_or(ApiError::Forbidden("Mandate unavailable".into()))?;
    if account.owner != state.config.program_id
        || account.data.len() < 235
        || account.data[..8] != [139, 106, 43, 122, 82, 211, 96, 162]
    {
        return Err(ApiError::Forbidden("Invalid mandate".into()));
    }
    if let Some(scope) = &principal.scope {
        if scope["agents"][address].as_str()
            != Some(&bs58::encode(&account.data[40..72]).into_string())
        {
            return Err(ApiError::Forbidden(
                "Mandate agent changed. Reconnect.".into(),
            ));
        }
    }
    verify_account_pubkey(&account.data[8..40], &principal.wallet, "owner")
        .map_err(|_| ApiError::Forbidden("Mandate belongs to another owner".into()))?;
    Ok(())
}

pub(super) async fn principal(
    axum::Extension(principal): axum::Extension<Principal>,
) -> Json<Principal> {
    Json(principal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn fixture() -> (BackendState, HeaderMap, SigningKey, String) {
        let mut seed = [0; 32];
        getrandom::fill(&mut seed).unwrap();
        let signer = SigningKey::from_bytes(&seed);
        let wallet = bs58::encode(signer.verifying_key().to_bytes()).into_string();
        let mut config = BackendConfig::from_env().unwrap();
        config.allowed_origins = vec!["http://localhost:5173".into()];
        let state = BackendState::new(config, StatusStore::in_memory()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:5173"),
        );
        (state, headers, signer, wallet)
    }

    #[tokio::test]
    async fn login_is_origin_bound_atomic_and_tokens_are_hashed() {
        let (state, headers, signer, wallet) = fixture();
        let Json(c) = challenge(
            State(state.clone()),
            headers.clone(),
            Query(LoginChallenge {
                wallet: wallet.clone(),
            }),
        )
        .await
        .unwrap();
        let signature = BASE64.encode(
            signer
                .sign(c["message"].as_str().unwrap().as_bytes())
                .to_bytes(),
        );
        let id = c["challenge_id"].as_str().unwrap().to_owned();
        let mut wrong = headers.clone();
        wrong.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://attacker.example"),
        );
        assert!(
            login(
                State(state.clone()),
                wrong,
                Json(LoginProof {
                    challenge_id: id.clone(),
                    signature: signature.clone()
                })
            )
            .await
            .is_err()
        );
        let (a, b) = tokio::join!(
            login(
                State(state.clone()),
                headers.clone(),
                Json(LoginProof {
                    challenge_id: id.clone(),
                    signature: signature.clone()
                })
            ),
            login(
                State(state.clone()),
                headers.clone(),
                Json(LoginProof {
                    challenge_id: id,
                    signature
                })
            )
        );
        assert_ne!(a.is_ok(), b.is_ok());
        let Json(result) = a.or(b).unwrap();
        let token = result["token"].as_str().unwrap();
        assert!(
            state
                .store
                .get_auth(&format!("session:{token}"), now_ms(), false)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            (3_599_000..=3_600_000)
                .contains(&(result["expires_at_ms"].as_u64().unwrap() - now_ms()))
        );
        let mut authenticated = headers;
        authenticated.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        assert_eq!(
            identify(&state, &authenticated).await.unwrap().wallet,
            wallet
        );
        assert!(
            owner(
                &identify(&state, &authenticated).await.unwrap(),
                "another-wallet"
            )
            .is_err()
        );
        let _ = logout(State(state.clone()), authenticated.clone())
            .await
            .unwrap();
        assert!(identify(&state, &authenticated).await.is_err());
    }

    #[tokio::test]
    async fn expired_challenge_bad_signature_and_service_token_are_denied() {
        let (mut state, headers, _, wallet) = fixture();
        let Json(c) = challenge(
            State(state.clone()),
            headers.clone(),
            Query(LoginChallenge { wallet }),
        )
        .await
        .unwrap();
        let id = c["challenge_id"].as_str().unwrap();
        assert!(
            login(
                State(state.clone()),
                headers.clone(),
                Json(LoginProof {
                    challenge_id: id.into(),
                    signature: BASE64.encode([0; 64])
                })
            )
            .await
            .is_err()
        );
        state
            .store
            .put_auth(&format!("challenge:{id}"), json!({}), now_ms())
            .await
            .unwrap();
        assert!(
            login(
                State(state.clone()),
                headers.clone(),
                Json(LoginProof {
                    challenge_id: id.into(),
                    signature: BASE64.encode([0; 64])
                })
            )
            .await
            .is_err()
        );
        state.config.auth_token = "service-token-must-not-impersonate-wallet".into();
        let mut h = headers;
        h.insert(
            header::AUTHORIZATION,
            format!("Bearer {}", state.config.auth_token)
                .parse()
                .unwrap(),
        );
        assert!(identify(&state, &h).await.is_err());
    }

    #[tokio::test]
    async fn login_challenge_rate_limit_is_shared_and_bounded() {
        let (state, headers, _, wallet) = fixture();
        for _ in 0..20 {
            let _ = challenge(
                State(state.clone()),
                headers.clone(),
                Query(LoginChallenge {
                    wallet: wallet.clone(),
                }),
            )
            .await
            .unwrap();
        }
        assert!(matches!(
            challenge(
                State(state.clone()),
                headers,
                Query(LoginChallenge { wallet })
            )
            .await,
            Err(ApiError::RateLimited)
        ));
    }
    #[tokio::test]
    async fn on_chain_owner_and_connection_agent_are_verified() {
        let (mut state, _, signer, wallet) = fixture();
        let approved = bs58::encode([8; 32]).into_string();
        let mut data = vec![0; 235];
        data[..8].copy_from_slice(&[139, 106, 43, 122, 82, 211, 96, 162]);
        data[8..40].copy_from_slice(signer.verifying_key().as_bytes());
        data[40..72].copy_from_slice(&[8; 32]);
        let encoded = BASE64.encode(data);
        let response = json!({"jsonrpc":"2.0","id":1,"result":{"value":{"owner":state.config.program_id,"data":[encoded,"base64"]}}});
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new().fallback(move || {
                    let value = response.clone();
                    async move { Json(value) }
                }),
            )
            .await
            .unwrap();
        });
        state.config.rpc.url = format!("http://{address}");
        state.rpc = RpcClient::new(state.config.rpc.clone()).unwrap();
        let mandate_address = bs58::encode([4; 32]).into_string();
        let owner_principal = Principal {
            wallet: wallet.clone(),
            scope: None,
        };
        mandate(
            &state,
            &owner_principal,
            &mandate_address,
            "execute_payment",
        )
        .await
        .unwrap();
        assert!(
            mandate(
                &state,
                &Principal {
                    wallet: approved.clone(),
                    scope: None
                },
                &mandate_address,
                "execute_payment"
            )
            .await
            .is_err()
        );
        let mut scoped = Principal {
            wallet,
            scope: Some(
                json!({"version":1,"mandates":[mandate_address],"tools":["execute_payment"],"agents":{mandate_address.clone():approved}}),
            ),
        };
        mandate(&state, &scoped, &mandate_address, "execute_payment")
            .await
            .unwrap();
        scoped.scope.as_mut().unwrap()["agents"][&mandate_address] = json!("changed-agent");
        assert!(
            mandate(&state, &scoped, &mandate_address, "execute_payment")
                .await
                .is_err()
        );
        task.abort();
    }

    #[tokio::test]
    async fn http_post_login_reaches_private_principal_and_logout_revokes_it() {
        let (state, _, signer, wallet) = fixture();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, build_router(state)).await.unwrap();
        });
        let client = reqwest::Client::new();
        let challenge = client
            .post(format!("{url}/v1/auth/challenge?wallet={wallet}"))
            .header("Origin", "http://localhost:5173")
            .send()
            .await
            .unwrap();
        assert_eq!(challenge.status(), StatusCode::OK);
        assert_eq!(challenge.headers()["cache-control"], "no-store");
        let challenge: Value = challenge.json().await.unwrap();
        let signature = BASE64.encode(
            signer
                .sign(challenge["message"].as_str().unwrap().as_bytes())
                .to_bytes(),
        );
        let login = client
            .post(format!("{url}/v1/auth/session"))
            .header("Origin", "http://localhost:5173")
            .json(&json!({"challenge_id":challenge["challenge_id"],"signature":signature}))
            .send()
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        let login: Value = login.json().await.unwrap();
        let token = login["token"].as_str().unwrap();
        let principal: Value = client
            .get(format!("{url}/v1/auth/principal"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(principal["wallet"], wallet);
        assert_eq!(
            client
                .delete(format!("{url}/v1/auth/session"))
                .bearer_auth(token)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
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
        task.abort();
    }

    #[tokio::test]
    #[ignore = "requires explicitly isolated TEST_DATABASE_URL"]
    async fn postgres_login_consumes_once_and_survives_store_reconnect() {
        let url = std::env::var("TEST_DATABASE_URL").expect("isolated fixture URL required");
        assert!(
            url.starts_with("postgresql://chainpay_test@127.0.0.1:55439/"),
            "Only the explicitly provisioned local fixture is allowed"
        );
        let (mut first, headers, signer, wallet) = fixture();
        first.store = StatusStore::connect(&url).await.unwrap();
        let mut second = first.clone();
        second.store = StatusStore::connect(&url).await.unwrap();
        let Json(c) = challenge(
            State(first.clone()),
            headers.clone(),
            Query(LoginChallenge {
                wallet: wallet.clone(),
            }),
        )
        .await
        .unwrap();
        let id = c["challenge_id"].as_str().unwrap().to_owned();
        let signature = BASE64.encode(
            signer
                .sign(c["message"].as_str().unwrap().as_bytes())
                .to_bytes(),
        );
        let (a, b) = tokio::join!(
            login(
                State(first.clone()),
                headers.clone(),
                Json(LoginProof {
                    challenge_id: id.clone(),
                    signature: signature.clone()
                })
            ),
            login(
                State(second.clone()),
                headers.clone(),
                Json(LoginProof {
                    challenge_id: id,
                    signature
                })
            )
        );
        assert_ne!(a.is_ok(), b.is_ok());
        let Json(result) = a.or(b).unwrap();
        let token = result["token"].as_str().unwrap();
        drop(first);
        drop(second);
        let (mut reconnected, mut authenticated, _, _) = fixture();
        reconnected.store = StatusStore::connect(&url).await.unwrap();
        authenticated.insert(
            header::AUTHORIZATION,
            format!("Bearer {token}").parse().unwrap(),
        );
        assert_eq!(
            identify(&reconnected, &authenticated).await.unwrap().wallet,
            wallet
        );
        let _ = logout(State(reconnected.clone()), authenticated.clone())
            .await
            .unwrap();
        let mut again = reconnected.clone();
        again.store = StatusStore::connect(&url).await.unwrap();
        assert!(identify(&again, &authenticated).await.is_err());
    }
}
