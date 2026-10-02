//! Off-chain context for a settled receipt: the merchant-signed request that
//! produced its invoice hash, and the policy limits that applied when it paid.
//!
//! Neither is payment evidence. The receipt account on Solana is. A v2 receipt
//! carries its own policy snapshot; for an original receipt the relay can only
//! report what it read from the mandate afterwards, and says so.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::api::{PaymentRequestPayload, SignedPaymentRequest};

/// Original PaymentReceipt account size. Still the minimum any reader accepts.
pub const RECEIPT_ACCOUNT_LENGTH: usize = 282;
/// PaymentReceipt with the policy snapshot appended after `bump`.
pub const RECEIPT_ACCOUNT_LENGTH_V2: usize = 371;
const SNAPSHOT_VERSION_OFFSET: usize = 282;
const MANDATE_ACCOUNT_LENGTH: usize = 235;
const MANDATE_DISCRIMINATOR: [u8; 8] = [139, 106, 43, 122, 82, 211, 96, 162];

pub const MAX_DESCRIPTION_CHARS: usize = 280;
pub const MAX_LINE_ITEMS: usize = 20;
pub const MAX_LINE_ITEM_LABEL_CHARS: usize = 120;
const MAX_QUANTITY_CHARS: usize = 32;

/// Mandate policy values immediately after one payment. u64 values travel as
/// decimal strings so a JavaScript reader never rounds them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptPolicyLimits {
    #[serde(with = "u64_string")]
    pub max_per_payment: u64,
    #[serde(with = "u64_string")]
    pub total_limit: u64,
    #[serde(with = "u64_string")]
    pub amount_spent_after: u64,
    #[serde(with = "u64_string")]
    pub payment_count_after: u64,
    /// 0 means no payment-count cap.
    #[serde(with = "u64_string")]
    pub max_payment_count: u64,
    #[serde(with = "u64_string")]
    pub expires_at_slot: u64,
    #[serde(with = "u64_string")]
    pub cooldown_slots: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptPolicySnapshot {
    pub version: u8,
    pub limits: ReceiptPolicyLimits,
}

fn read_u64(data: &[u8], offset: usize) -> Option<u64> {
    data.get(offset..offset + 8)
        .map(|bytes| u64::from_le_bytes(bytes.try_into().unwrap()))
}

/// Read the snapshot tail of a v2 receipt. An original 282-byte receipt, or a
/// v2 receipt whose version byte is 0, has none: zeroes are never limits.
pub fn parse_receipt_policy_snapshot(data: &[u8]) -> Option<ReceiptPolicySnapshot> {
    if data.len() < RECEIPT_ACCOUNT_LENGTH_V2 {
        return None;
    }
    let version = data[SNAPSHOT_VERSION_OFFSET];
    if version == 0 {
        return None;
    }
    Some(ReceiptPolicySnapshot {
        version,
        limits: ReceiptPolicyLimits {
            max_per_payment: read_u64(data, 283)?,
            total_limit: read_u64(data, 291)?,
            amount_spent_after: read_u64(data, 299)?,
            payment_count_after: read_u64(data, 307)?,
            max_payment_count: read_u64(data, 315)?,
            expires_at_slot: read_u64(data, 323)?,
            cooldown_slots: read_u64(data, 331)?,
        },
    })
}

/// Current policy fields of a mandate account, plus its `last_payment_slot`.
pub fn mandate_policy_fields(data: &[u8]) -> Option<(ReceiptPolicyLimits, u64)> {
    if data.len() < MANDATE_ACCOUNT_LENGTH || data[..8] != MANDATE_DISCRIMINATOR {
        return None;
    }
    Some((
        ReceiptPolicyLimits {
            max_per_payment: read_u64(data, 168)?,
            total_limit: read_u64(data, 176)?,
            amount_spent_after: read_u64(data, 184)?,
            payment_count_after: read_u64(data, 192)?,
            expires_at_slot: read_u64(data, 200)?,
            max_payment_count: read_u64(data, 208)?,
            cooldown_slots: read_u64(data, 216)?,
        },
        read_u64(data, 224)?,
    ))
}

/// Limits the relay read from the mandate after a receipt finalized, for a
/// receipt that has no on-chain snapshot. Kind `observed_policies`, keyed by
/// receipt PDA, written once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObservedPolicyRecord {
    pub cluster: String,
    pub program_id: String,
    pub receipt_address: String,
    pub mandate: String,
    pub limits: ReceiptPolicyLimits,
    /// RPC context slot of the mandate read. Never earlier than the payment.
    #[serde(with = "u64_string")]
    pub observed_at_slot: u64,
    /// The mandate had already paid again after this receipt when it was read,
    /// so `amount_spent_after` and `payment_count_after` include later payments.
    pub includes_later_payments: bool,
    pub observed_at_ms: u64,
}

/// A merchant-signed payment request whose canonical hash is the invoice hash
/// of a settled receipt. Kind `receipt_requests`, keyed by receipt PDA, written
/// once. `canonical_payload` is the exact signed text, kept as text because a
/// JSON column may reorder keys and break the hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptRequestRecord {
    pub cluster: String,
    pub program_id: String,
    pub receipt_address: String,
    pub mandate: String,
    pub invoice_hash: String,
    pub merchant: String,
    pub canonical_payload: String,
    pub signature: String,
    pub stored_at_ms: u64,
}

/// Limits shown beside a receipt and where they came from. Only `on-chain` is
/// recorded on Solana.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "source")]
pub enum ReceiptPolicyView {
    #[serde(rename = "on-chain")]
    OnChain {
        snapshot_version: u8,
        #[serde(flatten)]
        limits: ReceiptPolicyLimits,
    },
    #[serde(rename = "relay-observed")]
    RelayObserved {
        #[serde(flatten)]
        limits: ReceiptPolicyLimits,
        #[serde(with = "u64_string")]
        observed_at_slot: u64,
        includes_later_payments: bool,
    },
    #[serde(rename = "not-recorded")]
    NotRecorded,
}

impl ReceiptPolicyView {
    pub fn from_sources(
        receipt_data: Option<&[u8]>,
        observed: Option<&ObservedPolicyRecord>,
    ) -> Self {
        if let Some(snapshot) = receipt_data.and_then(parse_receipt_policy_snapshot) {
            return Self::OnChain {
                snapshot_version: snapshot.version,
                limits: snapshot.limits,
            };
        }
        match observed {
            Some(record) => Self::RelayObserved {
                limits: record.limits.clone(),
                observed_at_slot: record.observed_at_slot,
                includes_later_payments: record.includes_later_payments,
            },
            None => Self::NotRecorded,
        }
    }
}

fn has_control_character(value: &str) -> bool {
    value.chars().any(char::is_control)
}

/// Bounds for the optional "what was bought" fields. Same limits as the SDK.
pub fn validate_request_purpose(payload: &PaymentRequestPayload) -> Result<(), String> {
    if let Some(description) = &payload.description {
        let length = description.chars().count();
        if description.trim().is_empty() || length > MAX_DESCRIPTION_CHARS {
            return Err(format!(
                "description must be 1 to {MAX_DESCRIPTION_CHARS} characters"
            ));
        }
        if has_control_character(description) {
            return Err("description must be a single line of text".to_owned());
        }
    }
    if let Some(items) = &payload.line_items {
        if items.is_empty() || items.len() > MAX_LINE_ITEMS {
            return Err(format!(
                "lineItems must contain 1 to {MAX_LINE_ITEMS} items"
            ));
        }
        for item in items {
            let length = item.label.chars().count();
            if item.label.trim().is_empty()
                || length > MAX_LINE_ITEM_LABEL_CHARS
                || has_control_character(&item.label)
            {
                return Err(format!(
                    "each line item label must be one line of 1 to {MAX_LINE_ITEM_LABEL_CHARS} characters"
                ));
            }
            if let Some(amount) = &item.amount
                && (!amount.bytes().all(|byte| byte.is_ascii_digit())
                    || amount.parse::<u64>().is_err())
            {
                return Err(
                    "line item amount must be an unsigned integer string in base units".to_owned(),
                );
            }
            if let Some(quantity) = &item.quantity
                && !valid_quantity(quantity)
            {
                return Err("line item quantity must be an unsigned decimal string".to_owned());
            }
        }
    }
    Ok(())
}

fn valid_quantity(value: &str) -> bool {
    if value.is_empty() || value.len() > MAX_QUANTITY_CHARS {
        return false;
    }
    let mut parts = value.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    parts.next().is_none()
        && !whole.is_empty()
        && whole.bytes().all(|byte| byte.is_ascii_digit())
        && fraction.is_none_or(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

/// Field checks for a signed payment request, in the order the verify endpoint
/// reports them. Expiry is checked by the caller: a historical receipt's
/// request may be long expired and is still the request that was paid.
pub fn check_payment_request_fields(
    payload: &PaymentRequestPayload,
    cluster: &str,
) -> Result<(), String> {
    if payload.version != 1 {
        return Err("unsupported payment request version".to_owned());
    }
    if payload.cluster != cluster {
        return Err("unsupported Solana cluster".to_owned());
    }
    if payload.invoice.trim().is_empty() || payload.nonce.trim().is_empty() {
        return Err("invoice and nonce are required".to_owned());
    }
    if payload.token_program != "spl-token" && payload.token_program != "token-2022" {
        return Err("unsupported token program".to_owned());
    }
    if payload
        .amount
        .parse::<u64>()
        .ok()
        .filter(|amount| *amount > 0)
        .is_none()
    {
        return Err("amount must be a positive u64 string".to_owned());
    }
    for (name, value) in [
        ("merchant", payload.merchant.as_str()),
        ("mint", payload.mint.as_str()),
        ("recipient", payload.recipient.as_str()),
    ] {
        if bs58::decode(value)
            .into_vec()
            .ok()
            .filter(|bytes| bytes.len() == 32)
            .is_none()
        {
            return Err(format!("{name} must be a valid Solana address"));
        }
    }
    if let Some(expiry) = &payload.expires_at_slot
        && expiry.parse::<u64>().is_err()
    {
        return Err("expiresAtSlot must be an unsigned integer string".to_owned());
    }
    validate_request_purpose(payload)
}

/// Canonical bytes and their SHA-256. The canonical form is the payload
/// serialized in field order with absent optional fields omitted, matching
/// the SDK's `canonicalPaymentRequest`.
pub fn canonical_payment_request(
    payload: &PaymentRequestPayload,
) -> Result<(Vec<u8>, [u8; 32]), String> {
    let canonical = serde_json::to_vec(payload)
        .map_err(|error| format!("cannot serialize payment request: {error}"))?;
    let hash: [u8; 32] = Sha256::digest(&canonical).into();
    Ok((canonical, hash))
}

/// Verify the merchant's Ed25519 signature over the canonical payload.
pub fn verify_payment_request_signature(
    request: &SignedPaymentRequest,
    canonical: &[u8],
) -> Result<(), String> {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    let merchant: [u8; 32] = bs58::decode(&request.payload.merchant)
        .into_vec()
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| "merchant key must be 32 bytes".to_owned())?;
    let key = VerifyingKey::from_bytes(&merchant)
        .map_err(|error| format!("invalid merchant key: {error}"))?;
    let signature = STANDARD
        .decode(&request.signature)
        .ok()
        .and_then(|bytes| Signature::from_slice(&bytes).ok())
        .ok_or_else(|| "invalid payment request signature".to_owned())?;
    key.verify(canonical, &signature)
        .map_err(|_| "payment request signature is invalid".to_owned())
}

mod u64_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Value {
            Number(u64),
            String(String),
        }
        match Value::deserialize(deserializer)? {
            Value::Number(value) => Ok(value),
            Value::String(value) => value.parse().map_err(serde::de::Error::custom),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::PaymentRequestLineItem;

    fn payload() -> PaymentRequestPayload {
        PaymentRequestPayload {
            version: 1,
            cluster: "devnet".into(),
            merchant: bs58::encode([7_u8; 32]).into_string(),
            invoice: "PO-1042".into(),
            mint: bs58::encode([2_u8; 32]).into_string(),
            token_program: "spl-token".into(),
            recipient: bs58::encode([3_u8; 32]).into_string(),
            amount: "4500000".into(),
            decimals: 6,
            nonce: "n-1".into(),
            expires_at_slot: None,
            resource: None,
            description: None,
            line_items: None,
        }
    }

    pub(crate) fn receipt_v2_tail(data: &mut Vec<u8>, version: u8) {
        data.resize(RECEIPT_ACCOUNT_LENGTH_V2, 0);
        data[282] = version;
        for (index, value) in [5_000_000_u64, 50_000_000, 12_000_000, 3, 10, 9_000, 25]
            .iter()
            .enumerate()
        {
            let offset = 283 + index * 8;
            data[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        }
    }

    #[test]
    fn original_receipts_have_no_snapshot() {
        assert_eq!(
            parse_receipt_policy_snapshot(&vec![0; RECEIPT_ACCOUNT_LENGTH]),
            None
        );
        let mut unset = vec![0; RECEIPT_ACCOUNT_LENGTH];
        receipt_v2_tail(&mut unset, 0);
        assert_eq!(parse_receipt_policy_snapshot(&unset), None);
    }

    #[test]
    fn v2_receipts_decode_every_snapshot_offset() {
        let mut data = vec![0; RECEIPT_ACCOUNT_LENGTH];
        receipt_v2_tail(&mut data, 1);
        let snapshot = parse_receipt_policy_snapshot(&data).unwrap();
        assert_eq!(snapshot.version, 1);
        assert_eq!(
            snapshot.limits,
            ReceiptPolicyLimits {
                max_per_payment: 5_000_000,
                total_limit: 50_000_000,
                amount_spent_after: 12_000_000,
                payment_count_after: 3,
                max_payment_count: 10,
                expires_at_slot: 9_000,
                cooldown_slots: 25,
            }
        );
        let view = ReceiptPolicyView::from_sources(Some(&data), None);
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["source"], "on-chain");
        assert_eq!(json["total_limit"], "50000000");
        assert_eq!(json["snapshot_version"], 1);
    }

    #[test]
    fn policy_view_labels_relay_observation_and_absence() {
        let record = ObservedPolicyRecord {
            cluster: "devnet".into(),
            program_id: "program".into(),
            receipt_address: "receipt".into(),
            mandate: "mandate".into(),
            limits: ReceiptPolicyLimits {
                max_per_payment: u64::MAX,
                total_limit: 1,
                amount_spent_after: 1,
                payment_count_after: 1,
                max_payment_count: 0,
                expires_at_slot: 2,
                cooldown_slots: 0,
            },
            observed_at_slot: 77,
            includes_later_payments: false,
            observed_at_ms: 1,
        };
        let original = vec![0; RECEIPT_ACCOUNT_LENGTH];
        let json = serde_json::to_value(ReceiptPolicyView::from_sources(
            Some(&original),
            Some(&record),
        ))
        .unwrap();
        assert_eq!(json["source"], "relay-observed");
        assert_eq!(json["max_per_payment"], u64::MAX.to_string());
        assert_eq!(json["observed_at_slot"], "77");
        let json =
            serde_json::to_value(ReceiptPolicyView::from_sources(Some(&original), None)).unwrap();
        assert_eq!(json, serde_json::json!({ "source": "not-recorded" }));
    }

    #[test]
    fn requests_without_purpose_hash_exactly_as_before() {
        let (canonical, _) = canonical_payment_request(&payload()).unwrap();
        assert_eq!(
            String::from_utf8(canonical).unwrap(),
            format!(
                r#"{{"version":1,"cluster":"devnet","merchant":"{}","invoice":"PO-1042","mint":"{}","tokenProgram":"spl-token","recipient":"{}","amount":"4500000","decimals":6,"nonce":"n-1"}}"#,
                bs58::encode([7_u8; 32]).into_string(),
                bs58::encode([2_u8; 32]).into_string(),
                bs58::encode([3_u8; 32]).into_string(),
            )
        );
    }

    #[test]
    fn purpose_fields_follow_resource_in_canonical_order() {
        let mut request = payload();
        request.resource = Some("https://example.test/r".into());
        request.description = Some("Two \"widgets\"".into());
        request.line_items = Some(vec![PaymentRequestLineItem {
            label: "Widget".into(),
            amount: Some("2250000".into()),
            quantity: Some("2".into()),
        }]);
        let (canonical, _) = canonical_payment_request(&request).unwrap();
        let text = String::from_utf8(canonical).unwrap();
        assert!(text.ends_with(
            r#""resource":"https://example.test/r","description":"Two \"widgets\"","lineItems":[{"label":"Widget","amount":"2250000","quantity":"2"}]}"#
        ));
        assert!(validate_request_purpose(&request).is_ok());
    }

    #[test]
    fn purpose_bounds_are_enforced() {
        let mut request = payload();
        request.description = Some("x".repeat(MAX_DESCRIPTION_CHARS + 1));
        assert!(validate_request_purpose(&request).is_err());
        request.description = Some("line\nbreak".into());
        assert!(validate_request_purpose(&request).is_err());
        request.description = None;
        request.line_items = Some(
            (0..=MAX_LINE_ITEMS)
                .map(|_| PaymentRequestLineItem {
                    label: "x".into(),
                    amount: None,
                    quantity: None,
                })
                .collect(),
        );
        assert!(validate_request_purpose(&request).is_err());
        request.line_items = Some(vec![PaymentRequestLineItem {
            label: "x".into(),
            amount: Some("4.50".into()),
            quantity: None,
        }]);
        assert!(validate_request_purpose(&request).is_err());
        request.line_items = Some(vec![PaymentRequestLineItem {
            label: "x".into(),
            amount: None,
            quantity: Some("1.".into()),
        }]);
        assert!(validate_request_purpose(&request).is_err());
        request.line_items = Some(Vec::new());
        assert!(validate_request_purpose(&request).is_err());
    }

    #[test]
    fn mandate_fields_read_policy_and_last_payment_slot() {
        let mut data = vec![0_u8; MANDATE_ACCOUNT_LENGTH];
        data[..8].copy_from_slice(&MANDATE_DISCRIMINATOR);
        data[168..176].copy_from_slice(&5_u64.to_le_bytes());
        data[176..184].copy_from_slice(&50_u64.to_le_bytes());
        data[184..192].copy_from_slice(&12_u64.to_le_bytes());
        data[192..200].copy_from_slice(&3_u64.to_le_bytes());
        data[200..208].copy_from_slice(&900_u64.to_le_bytes());
        data[208..216].copy_from_slice(&10_u64.to_le_bytes());
        data[216..224].copy_from_slice(&4_u64.to_le_bytes());
        data[224..232].copy_from_slice(&88_u64.to_le_bytes());
        let (limits, last) = mandate_policy_fields(&data).unwrap();
        assert_eq!(last, 88);
        assert_eq!(limits.expires_at_slot, 900);
        assert_eq!(limits.max_payment_count, 10);
        assert_eq!(limits.cooldown_slots, 4);
        assert!(mandate_policy_fields(&data[..200]).is_none());
    }
}
