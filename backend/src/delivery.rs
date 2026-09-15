//! Off-chain seller response-served attestation.
//!
//! Canonical JSON and Ed25519 verification must match `sdk/src/delivery.ts`
//! byte-for-byte. A trusted statement never mutates Paid or PaymentReceipt.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::str::FromStr;

pub const DELIVERY_STATEMENT: &str = "chainpay.response-served";
pub const DELIVERY_VERSION: u8 = 1;
pub const DELIVERY_CLUSTER: &str = "devnet";
pub const DEFAULT_PROGRAM_ID: &str = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
pub const MAX_FUTURE_SKEW_MS: u64 = 5 * 60 * 1_000;
pub const MAX_DELIVERY_BODY_BYTES: usize = 2_048;

const PAYLOAD_KEYS: &[&str] = &[
    "version",
    "statement",
    "cluster",
    "programId",
    "receiptAddress",
    "seller",
    "contentHash",
    "servedAt",
];
const ENVELOPE_KEYS: &[&str] = &["payload", "signature"];

/// Exact UTF-8 body for the cross-language content-hash fixture.
pub const DELIVERY_HASH_FIXTURE_UTF8: &str = "ChainPay served body: café\n\t ";
pub const DELIVERY_HASH_FIXTURE_SHA256: &str =
    "8e60b641218418bde0cde3b190a028e846ccebed8dc804901b8e6f87b9072eee";
pub const DELIVERY_FIXTURE_RECEIPT_ADDRESS: &str = "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1";
pub const DELIVERY_FIXTURE_SELLER_ADDRESS: &str = "GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
pub const DELIVERY_CANONICAL_FIXTURE_JSON: &str = "{\"version\":1,\"statement\":\"chainpay.response-served\",\"cluster\":\"devnet\",\"programId\":\"3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4\",\"receiptAddress\":\"2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1\",\"seller\":\"GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB\",\"contentHash\":\"8e60b641218418bde0cde3b190a028e846ccebed8dc804901b8e6f87b9072eee\",\"servedAt\":\"2026-09-15T04:16:00.000Z\"}";
pub const DELIVERY_CANONICAL_FIXTURE_SIGNATURE: &str =
    "K+hQlY/7U7cbhE2229fk/C2g5MHUahSrhBZz4F3SUxTqyVvLgfV0gZkPosZKdFZzIXbawLS3xJQ3XsrtYXqIDg==";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeliveryAttestationPayload {
    pub version: u8,
    pub statement: String,
    pub cluster: String,
    #[serde(rename = "programId")]
    pub program_id: String,
    #[serde(rename = "receiptAddress")]
    pub receipt_address: String,
    pub seller: String,
    #[serde(rename = "contentHash")]
    pub content_hash: String,
    #[serde(rename = "servedAt")]
    pub served_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedDeliveryAttestation {
    pub payload: DeliveryAttestationPayload,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustedSellerMapping {
    pub cluster: String,
    #[serde(rename = "programId")]
    pub program_id: String,
    pub sellers: Vec<String>,
    #[serde(rename = "recipientTokenAccount")]
    pub recipient_token_account: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryAttestationRecord {
    pub cluster: String,
    pub program_id: String,
    pub receipt_address: String,
    pub seller: String,
    pub content_hash: String,
    pub served_at: String,
    pub signature: String,
    pub canonical_payload: String,
    pub published_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryAttestationPut {
    Created(DeliveryAttestationRecord),
    Unchanged(DeliveryAttestationRecord),
    Conflict(DeliveryAttestationRecord),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryVerification {
    pub valid: bool,
    pub payload: Option<DeliveryAttestationPayload>,
    pub reason: Option<String>,
    pub code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeliveryError {
    UnsupportedVersion,
    UnknownField(String),
    UnknownEnvelopeField(String),
    NotObject(&'static str),
    Invalid(&'static str),
}

impl DeliveryError {
    pub fn message(&self) -> String {
        match self {
            Self::UnsupportedVersion => "Unsupported delivery attestation version".to_owned(),
            Self::UnknownField(field) => format!("Unknown delivery attestation field: {field}"),
            Self::UnknownEnvelopeField(field) => {
                format!("Unknown delivery envelope field: {field}")
            }
            Self::NotObject(kind) => format!("{kind} must be an object"),
            Self::Invalid(reason) => (*reason).to_owned(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::UnsupportedVersion => "invalid_payload",
            Self::UnknownField(_) | Self::UnknownEnvelopeField(_) => "invalid_payload",
            Self::NotObject(_) | Self::Invalid(_) => "invalid_payload",
        }
    }
}

pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

pub fn parse_delivery_payload(value: &Value) -> Result<DeliveryAttestationPayload, DeliveryError> {
    let object = value
        .as_object()
        .ok_or(DeliveryError::NotObject("Delivery payload"))?;
    match object.get("version") {
        Some(Value::Number(number)) if number.as_u64() == Some(u64::from(DELIVERY_VERSION)) => {}
        _ => return Err(DeliveryError::UnsupportedVersion),
    }
    if let Some(key) = object
        .keys()
        .find(|key| !PAYLOAD_KEYS.contains(&key.as_str()))
    {
        return Err(DeliveryError::UnknownField(key.clone()));
    }
    if object.get("statement").and_then(Value::as_str) != Some(DELIVERY_STATEMENT) {
        return Err(DeliveryError::Invalid("Unsupported delivery statement"));
    }
    if object.get("cluster").and_then(Value::as_str) != Some(DELIVERY_CLUSTER) {
        return Err(DeliveryError::Invalid("Unsupported delivery cluster"));
    }
    let content_hash =
        object
            .get("contentHash")
            .and_then(Value::as_str)
            .ok_or(DeliveryError::Invalid(
                "contentHash must be 64-char lowercase SHA-256 hex",
            ))?;
    if !is_lowercase_sha256(content_hash) {
        return Err(DeliveryError::Invalid(
            "contentHash must be 64-char lowercase SHA-256 hex",
        ));
    }
    let served_at =
        object
            .get("servedAt")
            .and_then(Value::as_str)
            .ok_or(DeliveryError::Invalid(
                "servedAt must be a canonical UTC ISO-8601 timestamp",
            ))?;
    if !is_canonical_utc_iso(served_at) {
        return Err(DeliveryError::Invalid(
            "servedAt must be a canonical UTC ISO-8601 timestamp",
        ));
    }
    let program_id = canonicalize_address(object.get("programId").and_then(Value::as_str).ok_or(
        DeliveryError::Invalid("programId, receiptAddress, and seller must be Solana addresses"),
    )?)?;
    let receipt_address =
        canonicalize_address(object.get("receiptAddress").and_then(Value::as_str).ok_or(
            DeliveryError::Invalid(
                "programId, receiptAddress, and seller must be Solana addresses",
            ),
        )?)?;
    let seller = canonicalize_address(object.get("seller").and_then(Value::as_str).ok_or(
        DeliveryError::Invalid("programId, receiptAddress, and seller must be Solana addresses"),
    )?)?;
    Ok(DeliveryAttestationPayload {
        version: DELIVERY_VERSION,
        statement: DELIVERY_STATEMENT.to_owned(),
        cluster: DELIVERY_CLUSTER.to_owned(),
        program_id,
        receipt_address,
        seller,
        content_hash: content_hash.to_owned(),
        served_at: served_at.to_owned(),
    })
}

pub fn parse_delivery_envelope(value: &Value) -> Result<SignedDeliveryAttestation, DeliveryError> {
    let object = value
        .as_object()
        .ok_or(DeliveryError::NotObject("Delivery attestation"))?;
    if let Some(key) = object
        .keys()
        .find(|key| !ENVELOPE_KEYS.contains(&key.as_str()))
    {
        return Err(DeliveryError::UnknownEnvelopeField(key.clone()));
    }
    let signature = object
        .get("signature")
        .and_then(Value::as_str)
        .ok_or(DeliveryError::Invalid("Delivery signature is required"))?;
    if !is_canonical_base64(signature) {
        return Err(DeliveryError::Invalid(
            "Delivery signature must be canonical base64",
        ));
    }
    Ok(SignedDeliveryAttestation {
        payload: parse_delivery_payload(object.get("payload").unwrap_or(&Value::Null))?,
        signature: signature.to_owned(),
    })
}

pub fn canonical_delivery_payload(
    payload: &DeliveryAttestationPayload,
) -> Result<String, DeliveryError> {
    let parsed = parse_delivery_payload(&serde_json::json!({
        "version": payload.version,
        "statement": payload.statement,
        "cluster": payload.cluster,
        "programId": payload.program_id,
        "receiptAddress": payload.receipt_address,
        "seller": payload.seller,
        "contentHash": payload.content_hash,
        "servedAt": payload.served_at,
    }))?;
    Ok(format!(
        "{{\"version\":1,\"statement\":{},\"cluster\":{},\"programId\":{},\"receiptAddress\":{},\"seller\":{},\"contentHash\":{},\"servedAt\":{}}}",
        json_string(DELIVERY_STATEMENT),
        json_string(DELIVERY_CLUSTER),
        json_string(&parsed.program_id),
        json_string(&parsed.receipt_address),
        json_string(&parsed.seller),
        json_string(&parsed.content_hash),
        json_string(&parsed.served_at),
    ))
}

pub fn verify_delivery_attestation(
    envelope: &Value,
    trusted_sellers: &[TrustedSellerMapping],
    now_ms: u64,
    expected_program_id: Option<&str>,
    expected_receipt: Option<&str>,
    expected_recipient: Option<&str>,
) -> DeliveryVerification {
    let parsed = match parse_delivery_envelope(envelope) {
        Ok(parsed) => parsed,
        Err(error) => {
            return DeliveryVerification {
                valid: false,
                payload: None,
                reason: Some(error.message()),
                code: Some(error.code().to_owned()),
            };
        }
    };
    if let Some(reason) =
        trusted_seller_reason(&parsed.payload, trusted_sellers, expected_recipient)
    {
        return invalid("unknown_seller", reason, Some(parsed.payload));
    }
    if let Some(program_id) = expected_program_id {
        match canonicalize_address(program_id) {
            Ok(expected) if expected == parsed.payload.program_id => {}
            Ok(_) => {
                return invalid(
                    "program_mismatch",
                    "Delivery programId does not match expected program",
                    Some(parsed.payload),
                );
            }
            Err(error) => {
                return invalid(error.code(), error.message(), Some(parsed.payload));
            }
        }
    }
    if let Some(receipt) = expected_receipt {
        match canonicalize_address(receipt) {
            Ok(expected) if expected == parsed.payload.receipt_address => {}
            Ok(_) => {
                return invalid(
                    "receipt_mismatch",
                    "Delivery receiptAddress does not match the receipt",
                    Some(parsed.payload),
                );
            }
            Err(error) => {
                return invalid(error.code(), error.message(), Some(parsed.payload));
            }
        }
    }
    let served_at = match parse_canonical_utc_ms(&parsed.payload.served_at) {
        Some(served_at) => served_at,
        None => {
            return invalid(
                "invalid_timestamp",
                "servedAt must be a canonical UTC ISO-8601 timestamp",
                Some(parsed.payload),
            );
        }
    };
    if served_at.saturating_sub(now_ms) > MAX_FUTURE_SKEW_MS {
        return invalid(
            "invalid_timestamp",
            "Delivery servedAt is unreasonably far in the future",
            Some(parsed.payload),
        );
    }
    let signature = match canonical_base64_to_bytes(&parsed.signature) {
        Ok(bytes) if bytes.len() == 64 => bytes,
        Ok(_) => {
            return invalid(
                "invalid_signature",
                "Ed25519 signature must be 64 bytes",
                Some(parsed.payload),
            );
        }
        Err(error) => return invalid(error.code(), error.message(), Some(parsed.payload)),
    };
    let canonical = match canonical_delivery_payload(&parsed.payload) {
        Ok(canonical) => canonical,
        Err(error) => return invalid(error.code(), error.message(), Some(parsed.payload)),
    };
    match verify_ed25519(&parsed.payload.seller, canonical.as_bytes(), &signature) {
        Ok(()) => DeliveryVerification {
            valid: true,
            payload: Some(parsed.payload),
            reason: None,
            code: None,
        },
        Err(reason) => invalid("invalid_signature", reason, Some(parsed.payload)),
    }
}

pub fn trusted_sellers_from_env() -> Result<Vec<TrustedSellerMapping>, String> {
    let mut mappings = Vec::new();
    if let Ok(raw) = std::env::var("CHAINPAY_TRUSTED_SELLERS") {
        if !raw.trim().is_empty() {
            mappings.extend(parse_trusted_sellers_json(&raw)?);
        }
    }
    let seller = std::env::var("CHAINPAY_TRUSTED_SELLER")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let recipient = std::env::var("CHAINPAY_TRUSTED_SELLER_RECIPIENT")
        .ok()
        .filter(|value| !value.trim().is_empty());
    match (seller, recipient) {
        (Some(seller), Some(recipient)) => {
            let program_id = std::env::var("CHAINPAY_PROGRAM_ID")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_PROGRAM_ID.to_owned());
            mappings.push(normalize_mapping(TrustedSellerMapping {
                cluster: DELIVERY_CLUSTER.to_owned(),
                program_id,
                sellers: vec![seller],
                recipient_token_account: recipient,
            })?);
        }
        (None, None) => {}
        _ => {
            return Err(
                "CHAINPAY_TRUSTED_SELLER and CHAINPAY_TRUSTED_SELLER_RECIPIENT must be set together"
                    .to_owned(),
            );
        }
    }
    Ok(mappings)
}

pub fn parse_trusted_sellers_json(raw: &str) -> Result<Vec<TrustedSellerMapping>, String> {
    let parsed: Vec<TrustedSellerMapping> = serde_json::from_str(raw)
        .map_err(|error| format!("CHAINPAY_TRUSTED_SELLERS must be a JSON array: {error}"))?;
    parsed.into_iter().map(normalize_mapping).collect()
}

pub fn mapping_for_seller<'a>(
    mappings: &'a [TrustedSellerMapping],
    payload: &DeliveryAttestationPayload,
) -> Option<&'a TrustedSellerMapping> {
    mappings.iter().find(|mapping| {
        mapping.cluster == payload.cluster
            && mapping.program_id == payload.program_id
            && mapping
                .sellers
                .iter()
                .any(|seller| seller == &payload.seller)
    })
}

pub fn record_from_signed(
    envelope: &SignedDeliveryAttestation,
    published_at_ms: u64,
) -> Result<DeliveryAttestationRecord, DeliveryError> {
    Ok(DeliveryAttestationRecord {
        cluster: envelope.payload.cluster.clone(),
        program_id: envelope.payload.program_id.clone(),
        receipt_address: envelope.payload.receipt_address.clone(),
        seller: envelope.payload.seller.clone(),
        content_hash: envelope.payload.content_hash.clone(),
        served_at: envelope.payload.served_at.clone(),
        signature: envelope.signature.clone(),
        canonical_payload: canonical_delivery_payload(&envelope.payload)?,
        published_at_ms,
    })
}

pub fn public_delivery_dto(record: &DeliveryAttestationRecord) -> Value {
    serde_json::json!({
        "payload": {
            "version": DELIVERY_VERSION,
            "statement": DELIVERY_STATEMENT,
            "cluster": record.cluster,
            "programId": record.program_id,
            "receiptAddress": record.receipt_address,
            "seller": record.seller,
            "contentHash": record.content_hash,
            "servedAt": record.served_at,
        },
        "signature": record.signature,
        "publishedAt": unix_ms_to_canonical_utc(record.published_at_ms)
            .unwrap_or_else(|| record.served_at.clone()),
    })
}

pub fn canonicalize_address(value: &str) -> Result<String, DeliveryError> {
    Address::from_str(value)
        .map(|address| address.to_string())
        .map_err(|_| {
            DeliveryError::Invalid("programId, receiptAddress, and seller must be Solana addresses")
        })
}

fn normalize_mapping(mapping: TrustedSellerMapping) -> Result<TrustedSellerMapping, String> {
    if mapping.cluster != DELIVERY_CLUSTER {
        return Err("trusted seller cluster must be devnet".to_owned());
    }
    if mapping.sellers.is_empty() {
        return Err("trusted seller mapping must list at least one seller identity".to_owned());
    }
    let program_id = canonicalize_address(&mapping.program_id).map_err(|error| error.message())?;
    let recipient_token_account =
        canonicalize_address(&mapping.recipient_token_account).map_err(|error| error.message())?;
    let mut sellers = Vec::new();
    for seller in mapping.sellers {
        let seller = canonicalize_address(&seller).map_err(|error| error.message())?;
        if seller == recipient_token_account {
            return Err(
                "trusted seller identities are signing public keys, not recipient token accounts"
                    .to_owned(),
            );
        }
        if !sellers.contains(&seller) {
            sellers.push(seller);
        }
    }
    Ok(TrustedSellerMapping {
        cluster: DELIVERY_CLUSTER.to_owned(),
        program_id,
        sellers,
        recipient_token_account,
    })
}

fn mapping_missing_reason(
    payload: &DeliveryAttestationPayload,
    mappings: &[TrustedSellerMapping],
) -> String {
    if mappings
        .iter()
        .any(|mapping| mapping.cluster != payload.cluster)
        && mappings
            .iter()
            .all(|mapping| mapping.cluster != payload.cluster)
    {
        return "Delivery cluster is not trusted".to_owned();
    }
    if mappings.iter().any(|mapping| {
        mapping.cluster == payload.cluster && mapping.program_id != payload.program_id
    }) && mappings.iter().all(|mapping| {
        mapping.cluster != payload.cluster || mapping.program_id != payload.program_id
    }) {
        return "Delivery programId is not trusted".to_owned();
    }
    "Unknown delivery seller".to_owned()
}

fn trusted_seller_reason(
    payload: &DeliveryAttestationPayload,
    mappings: &[TrustedSellerMapping],
    expected_recipient: Option<&str>,
) -> Option<String> {
    if mappings.is_empty() {
        return Some("Unknown delivery seller".to_owned());
    }
    match mapping_for_seller(mappings, payload) {
        Some(mapping) => {
            if let Some(recipient) = expected_recipient {
                if canonicalize_address(recipient)
                    .ok()
                    .is_none_or(|value| value != mapping.recipient_token_account)
                {
                    return Some("Trusted seller does not match receipt recipient".to_owned());
                }
            }
            None
        }
        None => Some(mapping_missing_reason(payload, mappings)),
    }
}

fn verify_ed25519(seller: &str, message: &[u8], signature: &[u8]) -> Result<(), String> {
    let seller_bytes = bs58::decode(seller)
        .into_vec()
        .map_err(|_| "Delivery signature is invalid".to_owned())?;
    let key = VerifyingKey::from_bytes(
        seller_bytes
            .as_slice()
            .try_into()
            .map_err(|_| "Delivery signature is invalid".to_owned())?,
    )
    .map_err(|_| "Delivery signature is invalid".to_owned())?;
    let signature =
        Signature::from_slice(signature).map_err(|_| "Delivery signature is invalid".to_owned())?;
    key.verify(message, &signature)
        .map_err(|_| "Delivery signature is invalid".to_owned())
}

fn invalid(
    code: &str,
    reason: impl Into<String>,
    payload: Option<DeliveryAttestationPayload>,
) -> DeliveryVerification {
    DeliveryVerification {
        valid: false,
        payload,
        reason: Some(reason.into()),
        code: Some(code.to_owned()),
    }
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_canonical_base64(value: &str) -> bool {
    value.len() % 4 == 0
        && !value.is_empty()
        && value.bytes().all(
            |byte| matches!(byte, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'+' | b'/' | b'='),
        )
        && value.bytes().filter(|byte| *byte == b'=').count() <= 2
        && value
            .as_bytes()
            .iter()
            .rev()
            .take_while(|byte| **byte == b'=')
            .count()
            == value.chars().rev().take_while(|ch| *ch == '=').count()
        && !value[..value
            .len()
            .saturating_sub(value.bytes().rev().take_while(|b| *b == b'=').count())]
            .contains('=')
}

fn canonical_base64_to_bytes(value: &str) -> Result<Vec<u8>, DeliveryError> {
    if !is_canonical_base64(value) {
        return Err(DeliveryError::Invalid(
            "Delivery signature must be canonical base64",
        ));
    }
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, value)
        .map_err(|_| DeliveryError::Invalid("Delivery signature must be canonical base64"))
}

fn json_string(value: &str) -> String {
    Value::String(value.to_owned()).to_string()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_canonical_utc_iso(value: &str) -> bool {
    parse_canonical_utc_ms(value).is_some()
}

pub fn parse_canonical_utc_ms(value: &str) -> Option<u64> {
    let bytes = value.as_bytes();
    if bytes.len() != 24 || bytes[10] != b'T' || bytes[19] != b'.' || bytes[23] != b'Z' {
        return None;
    }
    for index in [4, 7] {
        if bytes[index] != b'-' {
            return None;
        }
    }
    for index in [13, 16] {
        if bytes[index] != b':' {
            return None;
        }
    }
    let digits = |start: usize, len: usize| -> Option<u32> {
        let slice = value.get(start..start + len)?;
        if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        slice.parse().ok()
    };
    let year = i32::try_from(digits(0, 4)?).ok()?;
    let month = digits(5, 2)?;
    let day = digits(8, 2)?;
    let hour = digits(11, 2)?;
    let minute = digits(14, 2)?;
    let second = digits(17, 2)?;
    let millis = digits(20, 3)?;
    if !valid_civil_date(year, month, day) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day);
    if days < 0 {
        return None;
    }
    let ms = u64::try_from(days)
        .ok()?
        .checked_mul(86_400_000)?
        .checked_add(u64::from(hour) * 3_600_000)?
        .checked_add(u64::from(minute) * 60_000)?
        .checked_add(u64::from(second) * 1_000)?
        .checked_add(u64::from(millis))?;
    let formatted = unix_ms_to_canonical_utc(ms)?;
    (formatted == value).then_some(ms)
}

pub fn unix_ms_to_canonical_utc(ms: u64) -> Option<String> {
    let secs = ms / 1_000;
    let millis = ms % 1_000;
    let days = i64::try_from(secs / 86_400).ok()?;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    if !(0..=9999).contains(&year) {
        return None;
    }
    Some(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z",
        hour = rem / 3_600,
        minute = (rem % 3_600) / 60,
        second = rem % 60,
    ))
}

fn valid_civil_date(year: i32, month: u32, day: u32) -> bool {
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
        _ => return false,
    };
    day >= 1 && day <= days
}

fn is_leap(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = u64::try_from(year - era * 400).unwrap_or(0);
    let mp = if month > 2 { month - 3 } else { month + 9 };
    let doy = (153 * u64::from(mp) + 2) / 5 + u64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    i64::from(era) * 146_097 + i64::try_from(doe).unwrap_or(0) - 719_468
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = u64::try_from(z - era * 146_097).unwrap_or(0);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = i64::try_from(yoe).unwrap_or(0) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};

    fn fixture_payload() -> Value {
        serde_json::json!({
            "version": 1,
            "statement": DELIVERY_STATEMENT,
            "cluster": DELIVERY_CLUSTER,
            "programId": DEFAULT_PROGRAM_ID,
            "receiptAddress": DELIVERY_FIXTURE_RECEIPT_ADDRESS,
            "seller": DELIVERY_FIXTURE_SELLER_ADDRESS,
            "contentHash": DELIVERY_HASH_FIXTURE_SHA256,
            "servedAt": "2026-09-15T04:16:00.000Z",
        })
    }

    fn fixture_mapping() -> TrustedSellerMapping {
        TrustedSellerMapping {
            cluster: DELIVERY_CLUSTER.to_owned(),
            program_id: DEFAULT_PROGRAM_ID.to_owned(),
            sellers: vec![DELIVERY_FIXTURE_SELLER_ADDRESS.to_owned()],
            recipient_token_account: "11111111111111111111111111111111".to_owned(),
        }
    }

    #[test]
    fn hashes_unicode_and_whitespace_response_bytes_exactly() {
        let bytes = DELIVERY_HASH_FIXTURE_UTF8.as_bytes();
        assert_eq!(bytes.len(), 30);
        assert_eq!(bytes[25], 0xc3);
        assert_eq!(bytes[26], 0xa9);
        assert_eq!(bytes[27], 10);
        assert_eq!(bytes[28], 9);
        assert_eq!(bytes[29], 32);
        assert_eq!(sha256_hex_bytes(bytes), DELIVERY_HASH_FIXTURE_SHA256);
    }

    #[test]
    fn canonicalizes_cross_language_payload_in_fixed_field_order() {
        let parsed = parse_delivery_payload(&fixture_payload()).unwrap();
        let canonical = canonical_delivery_payload(&parsed).unwrap();
        assert_eq!(canonical, DELIVERY_CANONICAL_FIXTURE_JSON);
        assert_eq!(
            canonical.as_bytes(),
            DELIVERY_CANONICAL_FIXTURE_JSON.as_bytes()
        );
        let keys: Vec<&str> = [
            "version",
            "statement",
            "cluster",
            "programId",
            "receiptAddress",
            "seller",
            "contentHash",
            "servedAt",
        ]
        .into_iter()
        .collect();
        let mut cursor = 0;
        for key in &keys {
            let needle = format!("\"{key}\":");
            let found = canonical[cursor..].find(&needle).expect(key);
            cursor += found + needle.len();
        }
    }

    #[test]
    fn rejects_unsupported_version_before_canonicalization() {
        let error = parse_delivery_payload(&serde_json::json!({
            "version": 2,
            "extra": true,
            "statement": DELIVERY_STATEMENT,
            "cluster": DELIVERY_CLUSTER,
            "programId": "not-a-valid-address",
            "receiptAddress": DELIVERY_FIXTURE_RECEIPT_ADDRESS,
            "seller": DELIVERY_FIXTURE_SELLER_ADDRESS,
            "contentHash": DELIVERY_HASH_FIXTURE_SHA256,
            "servedAt": "2026-09-15T04:16:00.000Z",
        }))
        .unwrap_err();
        assert!(matches!(error, DeliveryError::UnsupportedVersion));
    }

    #[test]
    fn rejects_unknown_fields_before_canonicalization() {
        let mut payload = fixture_payload();
        payload["extra"] = Value::Bool(true);
        payload["programId"] = Value::String("not-a-valid-address".into());
        let error = parse_delivery_payload(&payload).unwrap_err();
        assert_eq!(error.message(), "Unknown delivery attestation field: extra");
    }

    #[test]
    fn verifies_sdk_fixture_signature_for_trusted_seller() {
        let envelope = serde_json::json!({
            "payload": fixture_payload(),
            "signature": DELIVERY_CANONICAL_FIXTURE_SIGNATURE,
        });
        let now = parse_canonical_utc_ms("2026-09-15T04:16:00.000Z").unwrap();
        let verified = verify_delivery_attestation(
            &envelope,
            &[fixture_mapping()],
            now,
            Some(DEFAULT_PROGRAM_ID),
            Some(DELIVERY_FIXTURE_RECEIPT_ADDRESS),
            None,
        );
        assert!(verified.valid);
        assert_eq!(verified.payload.unwrap().statement, DELIVERY_STATEMENT);

        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        assert_eq!(
            bs58::encode(signing_key.verifying_key().as_bytes()).into_string(),
            DELIVERY_FIXTURE_SELLER_ADDRESS
        );
        let signature = signing_key.sign(DELIVERY_CANONICAL_FIXTURE_JSON.as_bytes());
        assert_eq!(
            base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                signature.to_bytes()
            ),
            DELIVERY_CANONICAL_FIXTURE_SIGNATURE
        );
    }

    #[test]
    fn rejects_invalid_signature_hash_and_unknown_or_ata_sellers() {
        let now = parse_canonical_utc_ms("2026-09-15T04:16:00.000Z").unwrap();
        let envelope = serde_json::json!({
            "payload": fixture_payload(),
            "signature": DELIVERY_CANONICAL_FIXTURE_SIGNATURE,
        });
        let mut tampered = envelope.clone();
        tampered["signature"] = Value::String(format!(
            "A{}",
            DELIVERY_CANONICAL_FIXTURE_SIGNATURE.get(1..).unwrap()
        ));
        let bad_signature =
            verify_delivery_attestation(&tampered, &[fixture_mapping()], now, None, None, None);
        assert!(!bad_signature.valid);
        assert!(
            bad_signature
                .reason
                .unwrap()
                .to_ascii_lowercase()
                .contains("signature")
        );

        let mut uppercase = envelope.clone();
        uppercase["payload"]["contentHash"] =
            Value::String(DELIVERY_HASH_FIXTURE_SHA256.to_ascii_uppercase());
        let bad_hash =
            verify_delivery_attestation(&uppercase, &[fixture_mapping()], now, None, None, None);
        assert!(!bad_hash.valid);
        assert!(bad_hash.reason.unwrap().contains("contentHash"));

        let unknown = verify_delivery_attestation(
            &envelope,
            &[TrustedSellerMapping {
                cluster: DELIVERY_CLUSTER.to_owned(),
                program_id: DEFAULT_PROGRAM_ID.to_owned(),
                sellers: vec!["11111111111111111111111111111112".to_owned()],
                recipient_token_account: "11111111111111111111111111111111".to_owned(),
            }],
            now,
            None,
            None,
            None,
        );
        assert!(!unknown.valid);
        assert_eq!(unknown.code.as_deref(), Some("unknown_seller"));

        let recipient = "11111111111111111111111111111111";
        let mapped_as_ata = verify_delivery_attestation(
            &envelope,
            &[TrustedSellerMapping {
                cluster: DELIVERY_CLUSTER.to_owned(),
                program_id: DEFAULT_PROGRAM_ID.to_owned(),
                sellers: vec![recipient.to_owned()],
                recipient_token_account: recipient.to_owned(),
            }],
            now,
            None,
            None,
            Some(recipient),
        );
        assert!(!mapped_as_ata.valid);
        assert_eq!(mapped_as_ata.code.as_deref(), Some("unknown_seller"));
    }

    #[test]
    fn rejects_far_future_and_noncanonical_timestamps() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut future_payload = parse_delivery_payload(&fixture_payload()).unwrap();
        future_payload.served_at = "2099-01-01T00:00:00.000Z".to_owned();
        let canonical = canonical_delivery_payload(&future_payload).unwrap();
        let signature = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            signing_key.sign(canonical.as_bytes()).to_bytes(),
        );
        let future = serde_json::json!({
            "payload": {
                "version": 1,
                "statement": DELIVERY_STATEMENT,
                "cluster": DELIVERY_CLUSTER,
                "programId": DEFAULT_PROGRAM_ID,
                "receiptAddress": DELIVERY_FIXTURE_RECEIPT_ADDRESS,
                "seller": DELIVERY_FIXTURE_SELLER_ADDRESS,
                "contentHash": DELIVERY_HASH_FIXTURE_SHA256,
                "servedAt": "2099-01-01T00:00:00.000Z",
            },
            "signature": signature,
        });
        let now = parse_canonical_utc_ms("2026-09-15T04:16:00.000Z").unwrap();
        let far_future =
            verify_delivery_attestation(&future, &[fixture_mapping()], now, None, None, None);
        assert!(!far_future.valid);
        assert_eq!(far_future.code.as_deref(), Some("invalid_timestamp"));

        let offset = serde_json::json!({
            "payload": {
                "version": 1,
                "statement": DELIVERY_STATEMENT,
                "cluster": DELIVERY_CLUSTER,
                "programId": DEFAULT_PROGRAM_ID,
                "receiptAddress": DELIVERY_FIXTURE_RECEIPT_ADDRESS,
                "seller": DELIVERY_FIXTURE_SELLER_ADDRESS,
                "contentHash": DELIVERY_HASH_FIXTURE_SHA256,
                "servedAt": "2026-09-15T04:16:00+00:00",
            },
            "signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
        });
        let offset_iso =
            verify_delivery_attestation(&offset, &[fixture_mapping()], now, None, None, None);
        assert!(!offset_iso.valid);
        assert!(offset_iso.reason.unwrap().contains("servedAt"));
    }

    #[test]
    fn trusted_mapping_rejects_seller_equal_to_recipient_ata() {
        let error = parse_trusted_sellers_json(
            r#"[{"cluster":"devnet","programId":"3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4","sellers":["11111111111111111111111111111111"],"recipientTokenAccount":"11111111111111111111111111111111"}]"#,
        )
        .unwrap_err();
        assert!(error.contains("signing public keys"));
    }
}
