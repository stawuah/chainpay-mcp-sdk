//! Public delivery-attestation routes. Signature + trusted seller + settled
//! receipt PDA is the only write authentication. GET never returns payment
//! private fields and never changes Paid.

use super::*;
use crate::delivery::{
    DeliveryAttestationPut, MAX_DELIVERY_BODY_BYTES, canonicalize_address, mapping_for_seller,
    parse_delivery_envelope, public_delivery_dto, record_from_signed, verify_delivery_attestation,
};
use solana_address::Address;
use std::str::FromStr;

const RECEIPT_DISCRIMINATOR: [u8; 8] = [168, 198, 209, 4, 60, 235, 126, 109];
const RECEIPT_ACCOUNT_LENGTH: usize = 282;
const RECEIPT_STATUS_SETTLED: u8 = 1;
const POST_RATE_GLOBAL: u64 = 120;
const POST_RATE_PEER: u64 = 20;
const GET_RATE: u64 = 600;

pub(super) fn is_public_delivery_path(method: &axum::http::Method, path: &str) -> bool {
    path == "/v1/delivery-attestations"
        || (*method == axum::http::Method::GET && path.starts_with("/v1/delivery-attestations/"))
}

pub(super) async fn create_delivery_attestation(
    State(state): State<BackendState>,
    request: Request<axum::body::Body>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let peer = request
        .headers()
        .get("x-chainpay-peer")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown-peer");
    let now = now_ms();
    if !state
        .store
        .auth_rate("delivery-attestations", now, POST_RATE_GLOBAL)
        .await?
        || !state
            .store
            .auth_rate(&format!("delivery-attestations-peer:{peer}"), now, POST_RATE_PEER)
            .await?
    {
        return Err(ApiError::RateLimited);
    }

    let bytes = axum::body::to_bytes(request.into_body(), MAX_DELIVERY_BODY_BYTES)
        .await
        .map_err(|_| ApiError::BadRequest("delivery attestation body is too large".to_owned()))?;
    if bytes.len() > MAX_DELIVERY_BODY_BYTES {
        return Err(ApiError::BadRequest(
            "delivery attestation body is too large".to_owned(),
        ));
    }
    let raw: Value = serde_json::from_slice(&bytes).map_err(|error| {
        ApiError::BadRequest(format!("delivery attestation must be JSON: {error}"))
    })?;
    let envelope = parse_delivery_envelope(&raw).map_err(|error| ApiError::BadRequest(error.message()))?;
    if envelope.payload.cluster != state.config.cluster {
        return Err(ApiError::BadRequest("unsupported Solana cluster".to_owned()));
    }
    if canonicalize_address(&state.config.program_id)
        .ok()
        .as_deref()
        != Some(envelope.payload.program_id.as_str())
    {
        return Err(ApiError::BadRequest(
            "Delivery programId does not match expected program".to_owned(),
        ));
    }

    let mapping = mapping_for_seller(&state.config.trusted_sellers, &envelope.payload).ok_or_else(
        || ApiError::BadRequest("Unknown delivery seller".to_owned()),
    )?;
    let receipt = fetch_settled_delivery_receipt(
        &state,
        &envelope.payload.receipt_address,
        &mapping.recipient_token_account,
    )
    .await?;
    let verified = verify_delivery_attestation(
        &raw,
        &state.config.trusted_sellers,
        now,
        Some(&state.config.program_id),
        Some(&envelope.payload.receipt_address),
        Some(&receipt.recipient),
    );
    if !verified.valid {
        return Err(ApiError::BadRequest(
            verified
                .reason
                .unwrap_or_else(|| "Delivery attestation is invalid".to_owned()),
        ));
    }

    let record = record_from_signed(&envelope, now)
        .map_err(|error| ApiError::BadRequest(error.message()))?;
    match state.store.put_delivery_attestation(record).await? {
        DeliveryAttestationPut::Created(record) | DeliveryAttestationPut::Unchanged(record) => {
            Ok((StatusCode::OK, Json(public_delivery_dto(&record))))
        }
        DeliveryAttestationPut::Conflict(_) => Err(ApiError::Conflict(
            "A conflicting delivery attestation already exists for this receipt and seller"
                .to_owned(),
        )),
    }
}

pub(super) async fn get_delivery_attestation(
    State(state): State<BackendState>,
    Path(receipt_address): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !state
        .store
        .auth_rate("public-delivery", now_ms(), GET_RATE)
        .await?
    {
        return Err(ApiError::RateLimited);
    }
    let receipt_address = canonicalize_address(&receipt_address)
        .map_err(|_| ApiError::BadRequest("receiptAddress must be a Solana address".to_owned()))?;
    let record = state
        .store
        .find_delivery_attestation(
            state.config.cluster,
            &state.config.program_id,
            &receipt_address,
        )
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(public_delivery_dto(&record)))
}

struct SettledDeliveryReceipt {
    recipient: String,
}

async fn fetch_settled_delivery_receipt(
    state: &BackendState,
    receipt_address: &str,
    expected_recipient: &str,
) -> Result<SettledDeliveryReceipt, ApiError> {
    let account = state
        .rpc
        .account_info_committed(receipt_address, "finalized")
        .await?
        .ok_or_else(|| {
            ApiError::BadRequest("Settled ChainPay receipt was not found".to_owned())
        })?;
    verify_settled_delivery_receipt(
        &account,
        receipt_address,
        &state.config.program_id,
        expected_recipient,
    )
}

fn verify_settled_delivery_receipt(
    account: &RpcAccount,
    receipt_address: &str,
    program_id: &str,
    expected_recipient: &str,
) -> Result<SettledDeliveryReceipt, ApiError> {
    if account.owner != program_id {
        return Err(ApiError::BadRequest(
            "Receipt account is not owned by the ChainPay program".to_owned(),
        ));
    }
    if account.data.len() < RECEIPT_ACCOUNT_LENGTH {
        return Err(ApiError::BadRequest(
            "PaymentReceipt account data is truncated".to_owned(),
        ));
    }
    if account.data[..8] != RECEIPT_DISCRIMINATOR {
        return Err(ApiError::BadRequest(
            "Invalid PaymentReceipt account discriminator".to_owned(),
        ));
    }
    let program = Address::from_str(program_id)
        .map_err(|_| ApiError::BadRequest("invalid program id".to_owned()))?;
    let requested = Address::from_str(receipt_address)
        .map_err(|_| ApiError::BadRequest("receiptAddress must be a Solana address".to_owned()))?;
    let derived = Address::find_program_address(
        &[b"receipt", &account.data[8..40], &account.data[40..72]],
        &program,
    )
    .0;
    if derived != requested {
        return Err(ApiError::BadRequest(
            "Receipt address does not match PDA seeds [\"receipt\", mandate, invoice_hash]"
                .to_owned(),
        ));
    }
    if account.data[280] != RECEIPT_STATUS_SETTLED {
        return Err(ApiError::BadRequest("Receipt is not settled".to_owned()));
    }
    let recipient = {
        let mut bytes = [0_u8; 32];
        bytes.copy_from_slice(&account.data[168..200]);
        Address::from(bytes).to_string()
    };
    let expected = canonicalize_address(expected_recipient)
        .map_err(|_| ApiError::BadRequest("trusted seller recipient is invalid".to_owned()))?;
    if recipient != expected {
        return Err(ApiError::BadRequest(
            "Trusted seller does not match receipt recipient".to_owned(),
        ));
    }
    Ok(SettledDeliveryReceipt { recipient })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delivery::{
        self, DEFAULT_PROGRAM_ID, DELIVERY_CANONICAL_FIXTURE_JSON,
        DELIVERY_CANONICAL_FIXTURE_SIGNATURE, DELIVERY_FIXTURE_RECEIPT_ADDRESS,
        DELIVERY_FIXTURE_SELLER_ADDRESS, DELIVERY_HASH_FIXTURE_SHA256, DELIVERY_STATEMENT,
        DeliveryAttestationPayload, TrustedSellerMapping,
    };
    use crate::status::{PaymentRecord, PaymentStatus, SigningMode};
    use ed25519_dalek::{Signer as _, SigningKey};
    use tokio::net::TcpListener;

    const FIXTURE_NOW: &str = "2026-09-15T04:16:00.000Z";

    fn recipient_address() -> String {
        bs58::encode([3_u8; 32]).into_string()
    }

    fn settled_receipt(program_id: &str, recipient: &str) -> (String, Vec<u8>) {
        let mandate = [1_u8; 32];
        let invoice = [5_u8; 32];
        let program = Address::from_str(program_id).unwrap();
        let (address, bump) =
            Address::find_program_address(&[b"receipt", &mandate, &invoice], &program);
        let mut data = vec![0_u8; RECEIPT_ACCOUNT_LENGTH];
        data[..8].copy_from_slice(&RECEIPT_DISCRIMINATOR);
        data[8..40].copy_from_slice(&mandate);
        data[40..72].copy_from_slice(&invoice);
        data[168..200].copy_from_slice(&bs58::decode(recipient).into_vec().unwrap());
        data[280] = RECEIPT_STATUS_SETTLED;
        data[281] = bump;
        (address.to_string(), data)
    }

    fn signed_envelope(receipt_address: &str, served_at: &str, content_hash: &str) -> Value {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let payload = DeliveryAttestationPayload {
            version: 1,
            statement: DELIVERY_STATEMENT.to_owned(),
            cluster: "devnet".to_owned(),
            program_id: DEFAULT_PROGRAM_ID.to_owned(),
            receipt_address: receipt_address.to_owned(),
            seller: DELIVERY_FIXTURE_SELLER_ADDRESS.to_owned(),
            content_hash: content_hash.to_owned(),
            served_at: served_at.to_owned(),
        };
        let canonical = delivery::canonical_delivery_payload(&payload).unwrap();
        let signature = BASE64.encode(signing_key.sign(canonical.as_bytes()).to_bytes());
        serde_json::json!({
            "payload": {
                "version": 1,
                "statement": DELIVERY_STATEMENT,
                "cluster": "devnet",
                "programId": DEFAULT_PROGRAM_ID,
                "receiptAddress": receipt_address,
                "seller": DELIVERY_FIXTURE_SELLER_ADDRESS,
                "contentHash": content_hash,
                "servedAt": served_at,
            },
            "signature": signature,
        })
    }

    async fn spawn_rpc(program_id: String, receipt: String, data: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let encoded = BASE64.encode(data);
            axum::serve(
                listener,
                Router::new().fallback(move |Json(request): Json<Value>| {
                    let program_id = program_id.clone();
                    let receipt = receipt.clone();
                    let encoded = encoded.clone();
                    async move {
                        let method = request
                            .get("method")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let requested = request
                            .get("params")
                            .and_then(Value::as_array)
                            .and_then(|params| params.first())
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let value = if method == "getAccountInfo" && requested == receipt {
                            json!({
                                "owner": program_id,
                                "data": [encoded, "base64"],
                                "executable": false,
                                "lamports": 1,
                            })
                        } else {
                            Value::Null
                        };
                        Json(json!({"jsonrpc":"2.0","id":1,"result":{"value": value}}))
                    }
                }),
            )
            .await
            .unwrap();
        });
        format!("http://{address}")
    }

    async fn spawn_api(rpc_url: String, recipient: String) -> (String, StatusStore) {
        let store = StatusStore::in_memory();
        let mut config = BackendConfig::from_env().unwrap();
        config.auth_token.clear();
        config.rpc.url = rpc_url;
        config.allowed_origins = vec!["*".to_owned()];
        config.trusted_sellers = vec![TrustedSellerMapping {
            cluster: "devnet".to_owned(),
            program_id: DEFAULT_PROGRAM_ID.to_owned(),
            sellers: vec![DELIVERY_FIXTURE_SELLER_ADDRESS.to_owned()],
            recipient_token_account: recipient,
        }];
        let state = BackendState::new(config, store.clone()).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, build_router(state)).await.unwrap();
        });
        (format!("http://{address}"), store)
    }

    fn private_payment(receipt: &str) -> PaymentRecord {
        PaymentRecord {
            payment_id: "payment_secret".into(),
            idempotency_key: "invoice-secret".into(),
            mandate: "mandate-secret".into(),
            invoice_hash: "ab".repeat(32),
            receipt_address: Some(receipt.into()),
            agent: Some("agent-secret".into()),
            mint: Some("mint-secret".into()),
            recipient: Some("recipient-secret".into()),
            amount: Some(99),
            token_program: Some("token-2022".into()),
            signing_mode: SigningMode::Delegated,
            signature: Some("tx-secret".into()),
            slot: Some(7),
            status: PaymentStatus::Confirmed,
            error: Some("internal".into()),
            created_at_ms: 1,
            updated_at_ms: 1,
        }
    }

    #[test]
    fn verifies_program_owned_settled_pda_and_recipient() {
        let recipient = recipient_address();
        let (address, data) = settled_receipt(DEFAULT_PROGRAM_ID, &recipient);
        let account = RpcAccount {
            owner: DEFAULT_PROGRAM_ID.to_owned(),
            data,
        };
        assert!(
            verify_settled_delivery_receipt(&account, &address, DEFAULT_PROGRAM_ID, &recipient)
                .is_ok()
        );
        let other = bs58::encode([9_u8; 32]).into_string();
        assert!(
            verify_settled_delivery_receipt(&account, &address, DEFAULT_PROGRAM_ID, &other)
                .is_err()
        );
    }

    #[tokio::test]
    async fn posts_trusted_statement_and_keeps_get_dto_public() {
        let recipient = recipient_address();
        let (receipt, data) = settled_receipt(DEFAULT_PROGRAM_ID, &recipient);
        let rpc = spawn_rpc(DEFAULT_PROGRAM_ID.to_owned(), receipt.clone(), data).await;
        let (api, store) = spawn_api(rpc, recipient).await;
        store.put_payment(private_payment(&receipt)).await.unwrap();
        let envelope = signed_envelope(&receipt, FIXTURE_NOW, DELIVERY_HASH_FIXTURE_SHA256);

        let created = reqwest::Client::new()
            .post(format!("{api}/v1/delivery-attestations"))
            .json(&envelope)
            .send()
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let created_json: Value = created.json().await.unwrap();
        assert_eq!(created_json["payload"]["receiptAddress"], receipt);
        assert_eq!(created_json["payload"]["seller"], DELIVERY_FIXTURE_SELLER_ADDRESS);
        assert!(created_json.get("payment_id").is_none());
        assert!(created_json.get("amount").is_none());

        let retry = reqwest::Client::new()
            .post(format!("{api}/v1/delivery-attestations"))
            .json(&envelope)
            .send()
            .await
            .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        let retry_json: Value = retry.json().await.unwrap();
        assert_eq!(retry_json["publishedAt"], created_json["publishedAt"]);
        assert_eq!(retry_json["signature"], created_json["signature"]);

        let viewed = reqwest::Client::new()
            .get(format!("{api}/v1/delivery-attestations/{receipt}"))
            .send()
            .await
            .unwrap();
        assert_eq!(viewed.status(), StatusCode::OK);
        let body: Value = viewed.json().await.unwrap();
        let object = body.as_object().unwrap();
        assert_eq!(
            object.keys().cloned().collect::<Vec<_>>(),
            ["payload", "publishedAt", "signature"]
        );
        let payload = body["payload"].as_object().unwrap();
        assert_eq!(
            payload.keys().cloned().collect::<Vec<_>>(),
            [
                "cluster",
                "contentHash",
                "programId",
                "receiptAddress",
                "seller",
                "servedAt",
                "statement",
                "version"
            ]
        );
        let leaked = [
            "payment_id",
            "paymentId",
            "idempotency_key",
            "mandate",
            "invoice_hash",
            "invoiceHash",
            "agent",
            "mint",
            "amount",
            "token_program",
            "signing_mode",
            "slot",
            "status",
            "error",
            "recipient",
            "signatureReference",
        ];
        for field in leaked {
            assert!(body.get(field).is_none(), "leaked {field}");
            assert!(body["payload"].get(field).is_none(), "leaked payload.{field}");
        }
        assert_eq!(
            store
                .get_payment("payment_secret")
                .await
                .unwrap()
                .unwrap()
                .status,
            PaymentStatus::Confirmed
        );
    }

    #[tokio::test]
    async fn unknown_seller_and_conflict_leave_paid_unchanged() {
        let recipient = recipient_address();
        let (receipt, data) = settled_receipt(DEFAULT_PROGRAM_ID, &recipient);
        let rpc = spawn_rpc(DEFAULT_PROGRAM_ID.to_owned(), receipt.clone(), data).await;
        let (api, store) = spawn_api(rpc, recipient).await;
        store.put_payment(private_payment(&receipt)).await.unwrap();

        let other_seller = SigningKey::from_bytes(&[8_u8; 32]);
        let mut unknown = signed_envelope(&receipt, FIXTURE_NOW, DELIVERY_HASH_FIXTURE_SHA256);
        unknown["payload"]["seller"] =
            Value::String(bs58::encode(other_seller.verifying_key().as_bytes()).into_string());
        let denied = reqwest::Client::new()
            .post(format!("{api}/v1/delivery-attestations"))
            .json(&unknown)
            .send()
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::BAD_REQUEST);
        let denied_json: Value = denied.json().await.unwrap();
        assert!(
            denied_json["error"]
                .as_str()
                .unwrap()
                .contains("Unknown delivery seller")
        );
        assert!(
            store
                .find_delivery_attestation("devnet", DEFAULT_PROGRAM_ID, &receipt)
                .await
                .unwrap()
                .is_none()
        );

        let first = signed_envelope(&receipt, FIXTURE_NOW, DELIVERY_HASH_FIXTURE_SHA256);
        assert_eq!(
            reqwest::Client::new()
                .post(format!("{api}/v1/delivery-attestations"))
                .json(&first)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let conflict = signed_envelope(
            &receipt,
            "2026-09-15T04:17:00.000Z",
            DELIVERY_HASH_FIXTURE_SHA256,
        );
        let conflicted = reqwest::Client::new()
            .post(format!("{api}/v1/delivery-attestations"))
            .json(&conflict)
            .send()
            .await
            .unwrap();
        assert_eq!(conflicted.status(), StatusCode::CONFLICT);
        let stored = store
            .find_delivery_attestation("devnet", DEFAULT_PROGRAM_ID, &receipt)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored.served_at, FIXTURE_NOW);
        assert_eq!(
            store
                .get_payment("payment_secret")
                .await
                .unwrap()
                .unwrap()
                .status,
            PaymentStatus::Confirmed
        );
    }

    #[test]
    fn fixture_canonical_bytes_remain_sdk_identical() {
        assert_eq!(
            DELIVERY_CANONICAL_FIXTURE_JSON.as_bytes().len(),
            DELIVERY_CANONICAL_FIXTURE_JSON.len()
        );
        let parsed = delivery::parse_delivery_payload(&serde_json::json!({
            "version": 1,
            "statement": DELIVERY_STATEMENT,
            "cluster": "devnet",
            "programId": DEFAULT_PROGRAM_ID,
            "receiptAddress": DELIVERY_FIXTURE_RECEIPT_ADDRESS,
            "seller": DELIVERY_FIXTURE_SELLER_ADDRESS,
            "contentHash": DELIVERY_HASH_FIXTURE_SHA256,
            "servedAt": FIXTURE_NOW,
        }))
        .unwrap();
        assert_eq!(
            delivery::canonical_delivery_payload(&parsed).unwrap(),
            DELIVERY_CANONICAL_FIXTURE_JSON
        );
        assert_eq!(
            BASE64.encode(
                SigningKey::from_bytes(&[7_u8; 32])
                    .sign(DELIVERY_CANONICAL_FIXTURE_JSON.as_bytes())
                    .to_bytes()
            ),
            DELIVERY_CANONICAL_FIXTURE_SIGNATURE
        );
    }
}
