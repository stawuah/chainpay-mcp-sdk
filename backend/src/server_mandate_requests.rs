//! The mandate request an owner accepted, linked to the mandate it became.
//!
//! PUT needs the owner's wallet session. The relay checks the requester
//! signature, then reads the live mandate and checks that this wallet owns it
//! and that it matches the request (mint, and the agent for a budget request).
//! Limits the owner changed are recorded, never refused: the owner decides.
//! GET is owner-only because a request names a vendor, a PO and a payee.

use super::*;
use crate::mandate_request::{SignedMandateRequest, decode_address, verify_mandate_request};
use crate::storage::KeyedRecordPut;

const RECORD_KIND: &str = "mandate_requests";
const PUT_RATE_PER_WALLET: u64 = 30;

fn owner_session(principal: &Principal) -> Result<(), ApiError> {
    if principal.scope.is_some() {
        return Err(ApiError::Forbidden("Owner session required".into()));
    }
    Ok(())
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&data[offset..offset + 8]);
    u64::from_le_bytes(bytes)
}

pub(super) async fn put_mandate_request(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(mandate_pda): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    owner_session(&principal)?;
    decode_address(&mandate_pda, "mandate")
        .map_err(|_| ApiError::BadRequest("mandate must be a Solana address".into()))?;
    let now = now_ms();
    if !state
        .store
        .auth_rate(
            &format!("mandate-requests:{}", principal.wallet),
            now,
            PUT_RATE_PER_WALLET,
        )
        .await?
    {
        return Err(ApiError::RateLimited);
    }

    let signed: SignedMandateRequest = serde_json::from_value(body)
        .map_err(|error| ApiError::BadRequest(format!("mandate request is malformed: {error}")))?;
    let verified = verify_mandate_request(&signed).map_err(ApiError::BadRequest)?;
    let payload = &verified.payload;
    if payload.cluster != state.config.cluster {
        return Err(ApiError::BadRequest("unsupported Solana cluster".into()));
    }

    let account = auth::owned_mandate_account(&state, &principal.wallet, &mandate_pda).await?;
    let data = &account.data;
    if bs58::encode(&data[104..136]).into_string() != payload.mint {
        return Err(ApiError::BadRequest(
            "This mandate uses a different token than the request".into(),
        ));
    }
    if payload.role == "grantee"
        && payload.agent.as_deref() != Some(bs58::encode(&data[40..72]).into_string().as_str())
    {
        return Err(ApiError::BadRequest(
            "This mandate does not approve the agent named in the request".into(),
        ));
    }

    let chosen_max = read_u64(data, 168);
    let chosen_total = read_u64(data, 176);
    let chosen_expiry = read_u64(data, 200);
    let record = json!({
        "kind": RECORD_KIND,
        "mandate": mandate_pda,
        "owner": principal.wallet,
        "requestHash": verified.request_hash,
        "request": signed,
        "chosen": {
            "maxPerPayment": chosen_max.to_string(),
            "total": chosen_total.to_string(),
            "expiresAtSlot": chosen_expiry.to_string(),
        },
        "differsFromRequest": {
            "maxPerPayment": chosen_max != verified.max_per_payment,
            "total": chosen_total != verified.total,
            "expirySlot": verified.suggested_expiry_slot.map(|slot| slot != chosen_expiry),
        },
        "acceptedAtMs": now,
    });

    match state
        .store
        .put_mandate_request(&mandate_pda, record, now)
        .await?
    {
        KeyedRecordPut::Created(record) => Ok(Json(record)),
        KeyedRecordPut::Existing(existing)
            if existing["requestHash"] == verified.request_hash.as_str()
                && existing["owner"] == principal.wallet.as_str() =>
        {
            Ok(Json(existing))
        }
        KeyedRecordPut::Existing(_) => Err(ApiError::Conflict(
            "A different request is already linked to this mandate".into(),
        )),
    }
}

pub(super) async fn get_mandate_request(
    State(state): State<BackendState>,
    Extension(principal): Extension<Principal>,
    Path(mandate_pda): Path<String>,
) -> Result<Json<Value>, ApiError> {
    owner_session(&principal)?;
    decode_address(&mandate_pda, "mandate")
        .map_err(|_| ApiError::BadRequest("mandate must be a Solana address".into()))?;
    let record = state
        .store
        .get_mandate_request(&mandate_pda)
        .await?
        .filter(|record| record["owner"] == principal.wallet.as_str())
        .ok_or(ApiError::NotFound)?;
    Ok(Json(record))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mandate_request::tests::{sign, signing_key, vendor_payload};
    use ed25519_dalek::SigningKey;

    const DISCRIMINATOR: [u8; 8] = [139, 106, 43, 122, 82, 211, 96, 162];
    const OWNER_SEED: [u8; 32] = [21; 32];

    fn owner_wallet() -> String {
        bs58::encode(
            SigningKey::from_bytes(&OWNER_SEED)
                .verifying_key()
                .to_bytes(),
        )
        .into_string()
    }

    fn mandate_data(mint: &str, agent: [u8; 32], max: u64, total: u64, expiry: u64) -> Vec<u8> {
        let mut data = vec![0_u8; 235];
        data[..8].copy_from_slice(&DISCRIMINATOR);
        data[8..40].copy_from_slice(
            SigningKey::from_bytes(&OWNER_SEED)
                .verifying_key()
                .as_bytes(),
        );
        data[40..72].copy_from_slice(&agent);
        data[104..136].copy_from_slice(&bs58::decode(mint).into_vec().unwrap());
        data[168..176].copy_from_slice(&max.to_le_bytes());
        data[176..184].copy_from_slice(&total.to_le_bytes());
        data[200..208].copy_from_slice(&expiry.to_le_bytes());
        data
    }

    async fn state_with_mandate(data: Vec<u8>) -> (BackendState, tokio::task::JoinHandle<()>) {
        let mut config = BackendConfig::from_env().unwrap();
        config.allowed_origins = vec!["http://localhost:5173".into()];
        let mut state = BackendState::new(config, StatusStore::in_memory()).unwrap();
        let response = json!({"jsonrpc":"2.0","id":1,"result":{"value":{"owner":state.config.program_id,"data":[BASE64.encode(data),"base64"]}}});
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
        (state, task)
    }

    fn owner() -> Principal {
        Principal {
            wallet: owner_wallet(),
            scope: None,
        }
    }

    fn mandate_pda() -> String {
        bs58::encode([4_u8; 32]).into_string()
    }

    async fn put(
        state: &BackendState,
        principal: Principal,
        body: Value,
    ) -> Result<Json<Value>, ApiError> {
        put_mandate_request(
            State(state.clone()),
            Extension(principal),
            Path(mandate_pda()),
            Json(body),
        )
        .await
    }

    #[tokio::test]
    async fn owner_links_a_vendor_request_once_and_reads_it_back() {
        let key = signing_key();
        let payload = vendor_payload(&key);
        // The owner lowered the total and kept the rest.
        let (state, task) = state_with_mandate(mandate_data(
            &payload.mint,
            [7; 32],
            5_000_000,
            20_000_000,
            406_480_000,
        ))
        .await;
        let signed = sign(payload, &key);
        let body = serde_json::to_value(&signed).unwrap();

        let Json(record) = put(&state, owner(), body.clone()).await.unwrap();
        assert_eq!(record["kind"], "mandate_requests");
        assert_eq!(record["owner"], owner_wallet());
        assert_eq!(record["request"], body);
        assert_eq!(record["chosen"]["total"], "20000000");
        assert_eq!(record["differsFromRequest"]["maxPerPayment"], false);
        assert_eq!(record["differsFromRequest"]["total"], true);
        assert_eq!(record["differsFromRequest"]["expirySlot"], false);
        assert_eq!(record["requestHash"].as_str().unwrap().len(), 64);

        let Json(again) = put(&state, owner(), body.clone()).await.unwrap();
        assert_eq!(again, record, "a retry returns the original record");

        let mut other = vendor_payload(&key);
        other.po_number = Some("PO-1043".into());
        assert!(matches!(
            put(
                &state,
                owner(),
                serde_json::to_value(sign(other, &key)).unwrap()
            )
            .await,
            Err(ApiError::Conflict(_))
        ));

        let Json(read) = get_mandate_request(
            State(state.clone()),
            Extension(owner()),
            Path(mandate_pda()),
        )
        .await
        .unwrap();
        assert_eq!(read, record);
        let stranger = Principal {
            wallet: bs58::encode([8_u8; 32]).into_string(),
            scope: None,
        };
        assert!(matches!(
            get_mandate_request(
                State(state.clone()),
                Extension(stranger),
                Path(mandate_pda())
            )
            .await,
            Err(ApiError::NotFound)
        ));
        let scoped = Principal {
            wallet: owner_wallet(),
            scope: Some(json!({"version":1})),
        };
        assert!(matches!(
            get_mandate_request(State(state.clone()), Extension(scoped), Path(mandate_pda())).await,
            Err(ApiError::Forbidden(_))
        ));
        task.abort();
    }

    #[tokio::test]
    async fn refuses_strangers_agents_tampering_and_mismatches() {
        let key = signing_key();
        let payload = vendor_payload(&key);
        let (state, task) = state_with_mandate(mandate_data(&payload.mint, [7; 32], 1, 1, 0)).await;
        let body = serde_json::to_value(sign(payload.clone(), &key)).unwrap();

        let stranger = Principal {
            wallet: bs58::encode([8_u8; 32]).into_string(),
            scope: None,
        };
        assert!(matches!(
            put(&state, stranger, body.clone()).await,
            Err(ApiError::Forbidden(message)) if message.contains("another owner")
        ));
        let agent_connection = Principal {
            wallet: owner_wallet(),
            scope: Some(json!({"version":1})),
        };
        assert!(matches!(
            put(&state, agent_connection, body.clone()).await,
            Err(ApiError::Forbidden(_))
        ));

        let mut tampered = body.clone();
        tampered["payload"]["suggestedTotal"] = json!("99000000");
        assert!(matches!(
            put(&state, owner(), tampered).await,
            Err(ApiError::BadRequest(message)) if message.contains("signature is invalid")
        ));
        let mut unknown = body.clone();
        unknown["payload"]["memo"] = json!("x");
        assert!(matches!(
            put(&state, owner(), unknown).await,
            Err(ApiError::BadRequest(_))
        ));

        let mut wrong_mint = payload.clone();
        wrong_mint.mint = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr".into();
        assert!(matches!(
            put(&state, owner(), serde_json::to_value(sign(wrong_mint, &key)).unwrap()).await,
            Err(ApiError::BadRequest(message)) if message.contains("different token")
        ));

        let mut grantee = payload.clone();
        grantee.role = "grantee".into();
        grantee.recipient = None;
        grantee.agent = Some(bs58::encode([13_u8; 32]).into_string());
        assert!(matches!(
            put(&state, owner(), serde_json::to_value(sign(grantee.clone(), &key)).unwrap()).await,
            Err(ApiError::BadRequest(message)) if message.contains("does not approve the agent")
        ));
        assert!(
            state
                .store
                .get_mandate_request(&mandate_pda())
                .await
                .unwrap()
                .is_none()
        );
        task.abort();

        let (state, task) =
            state_with_mandate(mandate_data(&payload.mint, [13; 32], 1, 1, 0)).await;
        let Json(record) = put(
            &state,
            owner(),
            serde_json::to_value(sign(grantee, &key)).unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(record["request"]["payload"]["role"], "grantee");
        assert_eq!(record["differsFromRequest"]["total"], true);
        task.abort();
    }

    #[tokio::test]
    async fn routes_require_a_session() {
        let state = BackendState::new(BackendConfig::from_env().unwrap(), StatusStore::in_memory())
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                build_router(state).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::new();
        let path = format!("{url}/v1/mandates/{}/request", mandate_pda());
        assert_eq!(
            client.get(&path).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .put(&path)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        task.abort();
    }
}
