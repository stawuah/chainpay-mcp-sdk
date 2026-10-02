//! Requester-signed mandate requests: a vendor's purchase order or a builder's
//! budget request. Mirrors `sdk/src/mandate-request.ts` byte for byte: the
//! struct field order is the canonical JSON order, and optional fields are
//! omitted when absent.
//!
//! A request is a proposal. It never moves money or authorizes a payment; the
//! owner's on-chain mandate is the only authority.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MAX_REQUESTER_NAME_LENGTH: usize = 64;
pub const MAX_REQUEST_DESCRIPTION_LENGTH: usize = 280;
pub const MAX_PO_NUMBER_LENGTH: usize = 64;
pub const MAX_REQUEST_NONCE_LENGTH: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MandateRequestPayload {
    pub version: u8,
    pub cluster: String,
    pub role: String,
    pub requester: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requester_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    pub mint: String,
    pub token_program: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    pub suggested_max_per_payment: String,
    pub suggested_total: String,
    pub decimals: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_expiry_slot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until_slot: Option<String>,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub po_number: Option<String>,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedMandateRequest {
    pub payload: MandateRequestPayload,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedMandateRequest {
    pub payload: MandateRequestPayload,
    /// Lowercase hex SHA-256 of the canonical payload bytes.
    pub request_hash: String,
    pub max_per_payment: u64,
    pub total: u64,
    pub suggested_expiry_slot: Option<u64>,
}

pub fn canonical_mandate_request(payload: &MandateRequestPayload) -> Vec<u8> {
    // Struct field order is the canonical order; serde_json escapes strings
    // the same way JSON.stringify does for every value a Rust String can hold.
    serde_json::to_vec(payload).expect("mandate request payload serializes")
}

pub fn decode_address(value: &str, name: &str) -> Result<[u8; 32], String> {
    let bytes = bs58::decode(value)
        .into_vec()
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(|| format!("{name} must be a Solana address"))?;
    if bs58::encode(bytes).into_string() != value {
        return Err(format!("{name} must be a canonical Solana address"));
    }
    Ok(bytes)
}

fn u64_string(value: &str, name: &str, positive: bool) -> Result<u64, String> {
    let canonical = value == "0"
        || (!value.is_empty()
            && !value.starts_with('0')
            && value.bytes().all(|byte| byte.is_ascii_digit()));
    if !canonical {
        return Err(format!("{name} must be an unsigned integer string"));
    }
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("{name} must fit in u64"))?;
    if positive && parsed == 0 {
        return Err(format!("{name} must be greater than zero"));
    }
    Ok(parsed)
}

fn bounded_text(value: Option<&str>, name: &str, max: usize, required: bool) -> Result<(), String> {
    let Some(value) = value else {
        return if required {
            Err(format!("{name} must be text"))
        } else {
            Ok(())
        };
    };
    if value.trim().is_empty() {
        return Err(format!("{name} must not be empty"));
    }
    if value != value.trim() {
        return Err(format!("{name} must not start or end with spaces"));
    }
    if value.chars().count() > max {
        return Err(format!("{name} must be at most {max} characters"));
    }
    if value
        .chars()
        .any(|character| (character as u32) < 0x20 || character == '\u{7f}')
    {
        return Err(format!("{name} must not contain control characters"));
    }
    Ok(())
}

/// Every field, the role rules, and the requester signature. No clock: the
/// relay records a request the owner already accepted on chain.
pub fn verify_mandate_request(
    request: &SignedMandateRequest,
) -> Result<VerifiedMandateRequest, String> {
    let payload = &request.payload;
    if payload.version != 1 {
        return Err("Unsupported mandate request version".into());
    }
    if payload.cluster != "devnet" && payload.cluster != "mainnet-beta" {
        return Err("Unsupported Solana cluster".into());
    }
    if payload.token_program != "spl-token" && payload.token_program != "token-2022" {
        return Err("Unsupported token program".into());
    }
    let requester = decode_address(&payload.requester, "requester")?;
    decode_address(&payload.mint, "mint")?;
    match payload.role.as_str() {
        "vendor" => {
            decode_address(
                payload.recipient.as_deref().unwrap_or_default(),
                "recipient",
            )?;
            if payload.agent.is_some() {
                return Err("A vendor request must not name an agent".into());
            }
        }
        "grantee" => {
            decode_address(payload.agent.as_deref().unwrap_or_default(), "agent")?;
            if payload.recipient.is_some() {
                return Err("A budget request must not name a recipient".into());
            }
        }
        _ => return Err("Role must be vendor or grantee".into()),
    }
    bounded_text(
        payload.requester_name.as_deref(),
        "requesterName",
        MAX_REQUESTER_NAME_LENGTH,
        false,
    )?;
    bounded_text(
        Some(&payload.description),
        "description",
        MAX_REQUEST_DESCRIPTION_LENGTH,
        true,
    )?;
    bounded_text(
        payload.po_number.as_deref(),
        "poNumber",
        MAX_PO_NUMBER_LENGTH,
        false,
    )?;
    bounded_text(
        Some(&payload.nonce),
        "nonce",
        MAX_REQUEST_NONCE_LENGTH,
        true,
    )?;
    let max_per_payment = u64_string(
        &payload.suggested_max_per_payment,
        "suggestedMaxPerPayment",
        true,
    )?;
    let total = u64_string(&payload.suggested_total, "suggestedTotal", true)?;
    if total < max_per_payment {
        return Err("suggestedTotal must be at least suggestedMaxPerPayment".into());
    }
    let suggested_expiry_slot = payload
        .suggested_expiry_slot
        .as_deref()
        .map(|value| u64_string(value, "suggestedExpirySlot", true))
        .transpose()?;
    if let Some(value) = &payload.valid_until_slot {
        u64_string(value, "validUntilSlot", true)?;
    }

    let canonical = canonical_mandate_request(payload);
    let signature = URL_SAFE_NO_PAD
        .decode(&request.signature)
        .map_err(|_| "Signature must be base64url".to_owned())?;
    let signature = Signature::from_slice(&signature)
        .map_err(|_| "Ed25519 signature must be 64 bytes".to_owned())?;
    let key = VerifyingKey::from_bytes(&requester)
        .map_err(|_| "requester is not a valid Ed25519 key".to_owned())?;
    key.verify(&canonical, &signature)
        .map_err(|_| "Mandate request signature is invalid".to_owned())?;
    let request_hash = Sha256::digest(&canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(VerifiedMandateRequest {
        payload: payload.clone(),
        request_hash,
        max_per_payment,
        total,
        suggested_expiry_slot,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    pub(crate) fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[9; 32])
    }

    pub(crate) fn sign(payload: MandateRequestPayload, key: &SigningKey) -> SignedMandateRequest {
        let signature = key.sign(&canonical_mandate_request(&payload));
        SignedMandateRequest {
            payload,
            signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
        }
    }

    pub(crate) fn vendor_payload(requester: &SigningKey) -> MandateRequestPayload {
        MandateRequestPayload {
            version: 1,
            cluster: "devnet".into(),
            role: "vendor".into(),
            requester: bs58::encode(requester.verifying_key().to_bytes()).into_string(),
            requester_name: Some("Acme Data Co".into()),
            agent: None,
            mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU".into(),
            token_program: "spl-token".into(),
            recipient: Some(bs58::encode([12_u8; 32]).into_string()),
            suggested_max_per_payment: "5000000".into(),
            suggested_total: "50000000".into(),
            decimals: 6,
            suggested_expiry_slot: Some("406480000".into()),
            valid_until_slot: Some("401512000".into()),
            description: "Market data API, billed per call".into(),
            po_number: Some("PO-1042".into()),
            nonce: "n-1".into(),
        }
    }

    #[test]
    fn canonical_order_matches_the_sdk() {
        let payload = vendor_payload(&signing_key());
        let canonical = String::from_utf8(canonical_mandate_request(&payload)).unwrap();
        let keys = [
            "version",
            "cluster",
            "role",
            "requester",
            "requesterName",
            "mint",
            "tokenProgram",
            "recipient",
            "suggestedMaxPerPayment",
            "suggestedTotal",
            "decimals",
            "suggestedExpirySlot",
            "validUntilSlot",
            "description",
            "poNumber",
            "nonce",
        ];
        let mut last = 0;
        for key in keys {
            let at = canonical.find(&format!("\"{key}\":")).unwrap();
            assert!(at >= last, "{key} out of order in {canonical}");
            last = at;
        }
        assert!(!canonical.contains("\"agent\""));
        assert!(canonical.starts_with("{\"version\":1,\"cluster\":\"devnet\""));
    }

    /// Produced by `signMandateRequest` in `sdk/src/mandate-request.ts` with the
    /// seed of 32 nines, so both languages agree on canonical bytes and escaping.
    const SDK_FIXTURE_JSON: &str = r#"{"payload":{"version":1,"cluster":"devnet","role":"vendor","requester":"J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf","requesterName":"Acme Data Co","mint":"4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU","tokenProgram":"spl-token","recipient":"p2Yicb86aZig616Eav2VWG9vuXR5mEqhtzshZYBxzsV","suggestedMaxPerPayment":"5000000","suggestedTotal":"50000000","decimals":6,"suggestedExpirySlot":"406480000","validUntilSlot":"401512000","description":"Market data API — billed per call, \"café\" tier","poNumber":"PO-1042","nonce":"n-1"},"signature":"3NNxvhM9LBXAvuqsPLS-n7gDhIzU9x_jKpwQwbqM7gCICxUwbw7dCvkZzqJePSWbdtIwQAPCGzDbipRwmJ8oBg"}"#;
    const SDK_FIXTURE_HASH: &str =
        "2c93ac9995f862c1773ee71501dceeff4a43acaa276d86f630099518e075b3ca";

    #[test]
    fn verifies_an_sdk_signed_request() {
        let signed: SignedMandateRequest = serde_json::from_str(SDK_FIXTURE_JSON).unwrap();
        assert_eq!(
            bs58::encode(signing_key().verifying_key().to_bytes()).into_string(),
            signed.payload.requester
        );
        let verified = verify_mandate_request(&signed).unwrap();
        assert_eq!(verified.request_hash, SDK_FIXTURE_HASH);
        assert_eq!(verified.max_per_payment, 5_000_000);
        assert_eq!(verified.total, 50_000_000);
        assert_eq!(verified.suggested_expiry_slot, Some(406_480_000));

        let key = signing_key();
        let rust_signed = sign(vendor_payload(&key), &key);
        assert!(verify_mandate_request(&rust_signed).is_ok());
    }

    #[test]
    fn tampering_and_role_rules_are_refused() {
        let key = signing_key();
        let signed = sign(vendor_payload(&key), &key);
        let mut tampered = signed.clone();
        tampered.payload.suggested_total = "50000001".into();
        assert_eq!(
            verify_mandate_request(&tampered).unwrap_err(),
            "Mandate request signature is invalid"
        );
        let mut extra = serde_json::to_value(&signed).unwrap();
        extra["payload"]["memo"] = "unsigned".into();
        assert!(serde_json::from_value::<SignedMandateRequest>(extra).is_err());

        let mut with_agent = vendor_payload(&key);
        with_agent.agent = Some(bs58::encode([13_u8; 32]).into_string());
        assert!(
            verify_mandate_request(&sign(with_agent, &key))
                .unwrap_err()
                .contains("must not name an agent")
        );
        let mut grantee = vendor_payload(&key);
        grantee.role = "grantee".into();
        assert!(
            verify_mandate_request(&sign(grantee.clone(), &key))
                .unwrap_err()
                .contains("agent must be")
        );
        grantee.recipient = None;
        grantee.agent = Some(bs58::encode([13_u8; 32]).into_string());
        assert!(verify_mandate_request(&sign(grantee, &key)).is_ok());

        let mut over = vendor_payload(&key);
        over.suggested_max_per_payment = "60000000".into();
        assert!(
            verify_mandate_request(&sign(over, &key))
                .unwrap_err()
                .contains("at least")
        );
        let mut long = vendor_payload(&key);
        long.description = "x".repeat(281);
        assert!(
            verify_mandate_request(&sign(long, &key))
                .unwrap_err()
                .contains("280")
        );
        let mut padded = vendor_payload(&key);
        padded.suggested_total = "050000000".into();
        assert!(verify_mandate_request(&sign(padded, &key)).is_err());
    }
}
