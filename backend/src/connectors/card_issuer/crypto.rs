//! AES-256-GCM envelopes for sensitive card record fields (contracts.md §5).
//!
//! Envelope: `{"v":1,"alg":"A256GCM","kid":"<key id>","iv":"<b64 12B>","ct":"<b64>"}`.
//! AAD: `"chainpay-card-record:v1\n" + kind + "\n" + key`, so moving a
//! ciphertext to another record fails to decrypt. Keys live only in Axum's
//! environment (`CARDS_RECORD_KEY_<KID>`, 32 random bytes, base64) and the
//! current key id in `CARDS_RECORD_KID`. Old key ids stay readable.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CryptoError {
    #[error(
        "CARDS_RECORD_KID and a matching CARDS_RECORD_KEY_<KID> (32 bytes, base64) are required"
    )]
    MissingKey,
    #[error("card record key {0} is not 32 bytes of base64")]
    InvalidKey(String),
    #[error("encrypted card field is malformed")]
    Malformed,
    #[error("encrypted card field uses an unknown key id")]
    UnknownKey,
    #[error("encrypted card field failed authentication")]
    Authentication,
}

#[derive(Clone)]
pub struct RecordCrypto {
    current: String,
    keys: HashMap<String, [u8; 32]>,
    /// Key id the blind-index key derives from. Pinned separately from
    /// `current` (`CARDS_RECORD_INDEX_KID`) so rotating the encryption key
    /// never changes index values or claim digests.
    index: String,
}

impl std::fmt::Debug for RecordCrypto {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RecordCrypto")
            .field("current", &self.current)
            .field("keys", &"[redacted]")
            .finish()
    }
}

fn aad(kind: &str, key: &str) -> Vec<u8> {
    format!("chainpay-card-record:v1\n{kind}\n{key}").into_bytes()
}

impl RecordCrypto {
    pub fn new(current: &str, keys: HashMap<String, [u8; 32]>) -> Result<Self, CryptoError> {
        if !keys.contains_key(current) || !valid_kid(current) {
            return Err(CryptoError::MissingKey);
        }
        Ok(Self {
            current: current.to_owned(),
            index: current.to_owned(),
            keys,
        })
    }

    pub fn from_vars(vars: impl Iterator<Item = (String, String)>) -> Result<Self, CryptoError> {
        let mut current = None;
        let mut index = None;
        let mut keys = HashMap::new();
        for (name, value) in vars {
            if name == "CARDS_RECORD_INDEX_KID" {
                index = Some(value.trim().to_owned()).filter(|v| !v.is_empty());
            } else if name == "CARDS_RECORD_KID" {
                current = Some(value.trim().to_owned());
            } else if let Some(kid) = name.strip_prefix("CARDS_RECORD_KEY_") {
                let bytes = BASE64
                    .decode(value.trim())
                    .map_err(|_| CryptoError::InvalidKey(kid.to_owned()))?;
                let key: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| CryptoError::InvalidKey(kid.to_owned()))?;
                keys.insert(kid.to_owned(), key);
            }
        }
        let mut crypto = Self::new(current.as_deref().ok_or(CryptoError::MissingKey)?, keys)?;
        if let Some(index) = index {
            if !crypto.keys.contains_key(&index) {
                return Err(CryptoError::MissingKey);
            }
            crypto.index = index;
        }
        Ok(crypto)
    }

    pub fn seal(&self, kind: &str, key: &str, plaintext: &[u8]) -> Value {
        let mut iv = [0u8; 12];
        getrandom::fill(&mut iv).expect("operating system randomness");
        let cipher = Aes256Gcm::new_from_slice(&self.keys[&self.current]).expect("32-byte key");
        let ct = cipher
            .encrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: plaintext,
                    aad: &aad(kind, key),
                },
            )
            .expect("AES-GCM encryption");
        json!({"v":1,"alg":"A256GCM","kid":self.current,"iv":BASE64.encode(iv),"ct":BASE64.encode(ct)})
    }

    pub fn open(&self, kind: &str, key: &str, envelope: &Value) -> Result<Vec<u8>, CryptoError> {
        let object = envelope.as_object().ok_or(CryptoError::Malformed)?;
        if object.len() != 5 || envelope["v"] != 1 || envelope["alg"] != "A256GCM" {
            return Err(CryptoError::Malformed);
        }
        let kid = envelope["kid"].as_str().ok_or(CryptoError::Malformed)?;
        let secret = self.keys.get(kid).ok_or(CryptoError::UnknownKey)?;
        let iv = BASE64
            .decode(envelope["iv"].as_str().ok_or(CryptoError::Malformed)?)
            .map_err(|_| CryptoError::Malformed)?;
        let ct = BASE64
            .decode(envelope["ct"].as_str().ok_or(CryptoError::Malformed)?)
            .map_err(|_| CryptoError::Malformed)?;
        if iv.len() != 12 {
            return Err(CryptoError::Malformed);
        }
        let cipher = Aes256Gcm::new_from_slice(secret).expect("32-byte key");
        cipher
            .decrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: &ct,
                    aad: &aad(kind, key),
                },
            )
            .map_err(|_| CryptoError::Authentication)
    }

    /// Keyed, one-way index value (hex HMAC-SHA256) for plaintext columns and
    /// claim intents: equal inputs match, but a reader of Convex cannot test a
    /// guess (e.g. "is DEMO-DATAAPI on this card's allowlist?") without the
    /// record key. The index key is derived from the `CARDS_RECORD_INDEX_KID`
    /// record key (default: the current one) and is never used for encryption.
    pub fn blind(&self, label: &str, data: &[u8]) -> String {
        use hmac::{Hmac, Mac};
        type H = Hmac<sha2_010::Sha256>;
        let mut derive = <H as Mac>::new_from_slice(&self.keys[&self.index]).expect("hmac key");
        derive.update(b"chainpay-card-index-key:v1");
        let index_key = derive.finalize().into_bytes();
        let mut mac = <H as Mac>::new_from_slice(&index_key).expect("hmac key");
        mac.update(format!("chainpay-card-index:v1\n{label}\n").as_bytes());
        mac.update(data);
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    pub fn seal_json<T: Serialize>(&self, kind: &str, key: &str, value: &T) -> Value {
        self.seal(kind, key, &serde_json::to_vec(value).expect("serializable"))
    }

    pub fn open_json<T: DeserializeOwned>(
        &self,
        kind: &str,
        key: &str,
        envelope: &Value,
    ) -> Result<T, CryptoError> {
        serde_json::from_slice(&self.open(kind, key, envelope)?).map_err(|_| CryptoError::Malformed)
    }
}

fn valid_kid(kid: &str) -> bool {
    !kid.is_empty()
        && kid.len() <= 32
        && kid
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

#[cfg(test)]
pub(crate) fn test_crypto() -> RecordCrypto {
    RecordCrypto::new("t1", HashMap::from([("t1".to_owned(), [7u8; 32])])).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blind_index_values_survive_key_rotation() {
        use base64::Engine;
        let k = |b: u8| base64::engine::general_purpose::STANDARD.encode([b; 32]);
        let before = RecordCrypto::from_vars(
            [
                ("CARDS_RECORD_KID", "k1".to_owned()),
                ("CARDS_RECORD_KEY_k1", k(1)),
            ]
            .into_iter()
            .map(|(a, b)| (a.to_owned(), b)),
        )
        .unwrap();
        let rotated = RecordCrypto::from_vars(
            [
                ("CARDS_RECORD_KID", "k2".to_owned()),
                ("CARDS_RECORD_INDEX_KID", "k1".to_owned()),
                ("CARDS_RECORD_KEY_k1", k(1)),
                ("CARDS_RECORD_KEY_k2", k(2)),
            ]
            .into_iter()
            .map(|(a, b)| (a.to_owned(), b)),
        )
        .unwrap();
        assert_eq!(before.blind("x", b"m"), rotated.blind("x", b"m"));
        assert_ne!(before.blind("x", b"m"), before.blind("y", b"m"));
        assert_eq!(before.blind("x", b"m").len(), 64);
    }

    #[test]
    fn envelopes_round_trip_and_bind_to_their_record() {
        let crypto = test_crypto();
        let sealed = crypto.seal("cards", "card:a", b"secret");
        assert_eq!(sealed["alg"], "A256GCM");
        assert!(!sealed.to_string().contains("secret"));
        assert_eq!(crypto.open("cards", "card:a", &sealed).unwrap(), b"secret");
        assert_eq!(
            crypto.open("cards", "card:b", &sealed),
            Err(CryptoError::Authentication)
        );
        assert_eq!(
            crypto.open("card_events", "card:a", &sealed),
            Err(CryptoError::Authentication)
        );
        let mut tampered = sealed.clone();
        tampered["kid"] = json!("other");
        assert_eq!(
            crypto.open("cards", "card:a", &tampered),
            Err(CryptoError::UnknownKey)
        );
    }

    #[test]
    fn keys_load_from_environment_shape_and_rotate() {
        let key = BASE64.encode([1u8; 32]);
        let old = BASE64.encode([2u8; 32]);
        let crypto = RecordCrypto::from_vars(
            vec![
                ("CARDS_RECORD_KID".to_owned(), "k2".to_owned()),
                ("CARDS_RECORD_KEY_k2".to_owned(), key.clone()),
                ("CARDS_RECORD_KEY_k1".to_owned(), old),
            ]
            .into_iter(),
        )
        .unwrap();
        let previous =
            RecordCrypto::new("k1", HashMap::from([("k1".to_owned(), [2u8; 32])])).unwrap();
        let sealed = previous.seal("cards", "x", b"v");
        assert_eq!(crypto.open("cards", "x", &sealed).unwrap(), b"v");
        assert!(format!("{crypto:?}").contains("redacted"));
        assert_eq!(
            RecordCrypto::from_vars(
                vec![("CARDS_RECORD_KID".to_owned(), "k9".to_owned())].into_iter()
            )
            .unwrap_err(),
            CryptoError::MissingKey
        );
        assert!(matches!(
            RecordCrypto::from_vars(
                vec![("CARDS_RECORD_KEY_k1".to_owned(), "short".to_owned())].into_iter()
            ),
            Err(CryptoError::InvalidKey(_))
        ));
    }
}
