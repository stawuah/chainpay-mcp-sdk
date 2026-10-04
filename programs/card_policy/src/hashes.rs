//! Ledger hash chain and salted commitment root (contracts.md §1.6).
//! Byte layouts here are a contract with the `/verify` page: change only with a
//! new domain version.

use crate::{
    constants::*,
    errors::CardPolicyError,
    state::{CardPeriod, CardPolicy},
};
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

pub const LEDGER_EVENT_LEN: usize = 8 + 1 + 32 + 32 + 8 + 1 + 4 + 8;
pub const LEAF_COUNT: usize = 16;

pub struct LedgerEvent {
    pub kind: u8,
    pub auth_id_hash: [u8; 32],
    pub event_id_hash: [u8; 32],
    pub amount_cents: u64,
    pub state_after: u8,
}

impl LedgerEvent {
    pub fn new(kind: u8) -> Self {
        Self {
            kind,
            auth_id_hash: [0u8; 32],
            event_id_hash: [0u8; 32],
            amount_cents: 0,
            state_after: 0,
        }
    }
}

/// `seq u64 ‖ kind u8 ‖ auth_id_hash[32] ‖ event_id_hash[32] ‖ amount_cents u64 ‖
/// state_after u8 ‖ period_index u32 ‖ unix_ts i64`, little-endian.
pub fn ledger_event_bytes(
    seq: u64,
    event: &LedgerEvent,
    period_index: u32,
    unix_ts: i64,
) -> [u8; LEDGER_EVENT_LEN] {
    let mut out = [0u8; LEDGER_EVENT_LEN];
    out[0..8].copy_from_slice(&seq.to_le_bytes());
    out[8] = event.kind;
    out[9..41].copy_from_slice(&event.auth_id_hash);
    out[41..73].copy_from_slice(&event.event_id_hash);
    out[73..81].copy_from_slice(&event.amount_cents.to_le_bytes());
    out[81] = event.state_after;
    out[82..86].copy_from_slice(&period_index.to_le_bytes());
    out[86..94].copy_from_slice(&unix_ts.to_le_bytes());
    out
}

pub fn next_ledger_head(head: &[u8; 32], event_bytes: &[u8]) -> [u8; 32] {
    hashv(&[LEDGER_DOMAIN, head, event_bytes]).to_bytes()
}

/// Appends one lifecycle event to the policy's hash chain.
pub fn append_ledger(
    policy: &mut CardPolicy,
    event: LedgerEvent,
    period_index: u32,
    unix_ts: i64,
) -> Result<()> {
    let seq = policy
        .ledger_seq
        .checked_add(1)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    let bytes = ledger_event_bytes(seq, &event, period_index, unix_ts);
    policy.ledger_head = next_ledger_head(&policy.ledger_head, &bytes);
    policy.ledger_seq = seq;
    Ok(())
}

pub fn leaf_salt(master_salt: &[u8; 32], index: u8) -> [u8; 32] {
    hashv(&[master_salt, &[index]]).to_bytes()
}

pub fn leaf_hash(index: u8, salt: &[u8; 32], value: &[u8]) -> [u8; 32] {
    hashv(&[LEAF_DOMAIN, &[index], salt, value]).to_bytes()
}

pub fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    hashv(&[&[0x01], left, right]).to_bytes()
}

/// Leaf value bytes, little-endian, fixed per index (see contracts.md changelog).
pub fn leaf_values(policy: &CardPolicy, period: &CardPeriod) -> [Vec<u8>; LEAF_COUNT] {
    let mut merchants: Vec<[u8; 32]> = policy.merchants().to_vec();
    merchants.sort_unstable();
    let merchant_digest = hashv(
        &merchants
            .iter()
            .map(|m| m.as_slice())
            .collect::<Vec<&[u8]>>(),
    )
    .to_bytes();
    let mut mccs: Vec<u16> = policy.mcc_list().to_vec();
    mccs.sort_unstable();
    let mcc_bytes: Vec<u8> = mccs.iter().flat_map(|m| m.to_le_bytes()).collect();
    let mcc_digest = hashv(&[&mcc_bytes]).to_bytes();

    let cat = |parts: &[&[u8]]| parts.concat();
    [
        policy.binding.to_bytes().to_vec(),
        policy.policy_version.to_le_bytes().to_vec(),
        policy.budget_cents.to_le_bytes().to_vec(),
        policy.max_purchase_cents.to_le_bytes().to_vec(),
        policy.max_purchases_per_period.to_le_bytes().to_vec(),
        merchant_digest.to_vec(),
        mcc_digest.to_vec(),
        cat(&[
            &policy.expires_at.to_le_bytes(),
            &[policy.recurring_allowed as u8],
            &policy.fee_bps.to_le_bytes(),
        ]),
        cat(&[
            &period.period_index.to_le_bytes(),
            &period.period_start.to_le_bytes(),
            &period.period_end.to_le_bytes(),
        ]),
        period.captured_cents.to_le_bytes().to_vec(),
        period.reserved_cents.to_le_bytes().to_vec(),
        period.refunded_cents.to_le_bytes().to_vec(),
        period.purchases_count.to_le_bytes().to_vec(),
        policy.statement_outstanding_cents.to_le_bytes().to_vec(),
        vec![policy.frozen as u8, policy.recovery_state],
        cat(&[&policy.ledger_head, &policy.ledger_seq.to_le_bytes()]),
    ]
}

pub fn merkle_root(leaves: &[[u8; 32]; LEAF_COUNT]) -> [u8; 32] {
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() > 1 {
        level = level
            .chunks(2)
            .map(|pair| node_hash(&pair[0], &pair[1]))
            .collect();
    }
    level[0]
}

pub fn commitment_root(
    policy: &CardPolicy,
    period: &CardPeriod,
    master_salt: &[u8; 32],
) -> [u8; 32] {
    let values = leaf_values(policy, period);
    let mut leaves = [[0u8; 32]; LEAF_COUNT];
    for (i, value) in values.iter().enumerate() {
        let index = i as u8;
        leaves[i] = leaf_hash(index, &leaf_salt(master_salt, index), value);
    }
    merkle_root(&leaves)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_layout_is_fixed() {
        let mut e = LedgerEvent::new(EV_CAPTURE);
        e.auth_id_hash = [0xaa; 32];
        e.event_id_hash = [0xbb; 32];
        e.amount_cents = 0x0102;
        e.state_after = 3;
        let b = ledger_event_bytes(5, &e, 2, 0x10);
        assert_eq!(b.len(), 94);
        assert_eq!(&b[0..8], &5u64.to_le_bytes());
        assert_eq!(b[8], EV_CAPTURE);
        assert_eq!(b[9], 0xaa);
        assert_eq!(b[41], 0xbb);
        assert_eq!(&b[73..81], &0x0102u64.to_le_bytes());
        assert_eq!(b[81], 3);
        assert_eq!(&b[82..86], &2u32.to_le_bytes());
        assert_eq!(&b[86..94], &0x10i64.to_le_bytes());
    }

    #[test]
    fn single_leaf_disclosure_verifies_against_root() {
        // A verifier holding leaf i's value + salt + 4 sibling hashes rebuilds the root.
        let salt = [42u8; 32];
        let leaves: [[u8; 32]; LEAF_COUNT] =
            core::array::from_fn(|i| leaf_hash(i as u8, &leaf_salt(&salt, i as u8), &[i as u8]));
        let root = merkle_root(&leaves);
        let i = 9usize;
        let mut level = leaves.to_vec();
        let mut idx = i;
        let mut proof = vec![];
        while level.len() > 1 {
            proof.push(level[idx ^ 1]);
            level = level.chunks(2).map(|p| node_hash(&p[0], &p[1])).collect();
            idx /= 2;
        }
        let mut acc = leaf_hash(i as u8, &leaf_salt(&salt, i as u8), &[i as u8]);
        let mut idx = i;
        for sib in proof {
            acc = if idx % 2 == 0 {
                node_hash(&acc, &sib)
            } else {
                node_hash(&sib, &acc)
            };
            idx /= 2;
        }
        assert_eq!(acc, root);
    }
}
