//! Deterministic in-process model of `card_policy` on PER for connector tests.
//! It decodes the exact instructions Axum builds, applies the program's rules
//! (contracts.md §1.3 + Changelog) and serves account bytes in the deployed
//! layout, so the real decoders and error mapping run end to end. Knobs model
//! a slow rollup (lands after the deadline), a dropped transaction and an
//! outage.

use super::program::{self, reservation_state as rs};
use super::tee::{TeeRead, TxOutcome};
use ed25519_dalek::SigningKey;
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_message::Instruction;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Default)]
pub struct FakePolicy {
    pub binding: Address,
    pub owner: Address,
    pub authorizer: Address,
    pub version: u32,
    pub budget: u64,
    pub max_purchase: u64,
    pub max_count: u16,
    pub merchants: Vec<[u8; 32]>,
    pub mccs: Vec<u16>,
    pub frozen: bool,
    pub recovery: u8,
    pub outstanding: u64,
    pub exceptions_open: u16,
    pub fee_bps: u16,
    pub ledger_seq: u64,
    pub commit_seq: u64,
    pub ledger_head: [u8; 32],
    pub recon_digest: [u8; 32],
    pub repayments: Vec<[u8; 32]>,
    pub period_seconds: u32,
}

#[derive(Debug, Clone, Default)]
pub struct FakePeriod {
    pub index: u32,
    pub start: i64,
    /// 0 = far future (the default test card never ends its period).
    pub end: i64,
    pub captured: u64,
    pub reserved: u64,
    pub refunded: u64,
    pub count: u16,
    pub exception: u64,
}

#[derive(Debug, Clone)]
pub struct FakeIntent {
    pub id: [u8; 16],
    pub agent: [u8; 32],
    pub merchant: [u8; 32],
    pub max: u64,
    pub version: u32,
    pub expires_at: i64,
    pub state: u8,
}

#[derive(Debug, Clone, Default)]
pub struct FakeReservation {
    pub auth_id: [u8; 32],
    pub hold: u64,
    pub captured: u64,
    pub reversed: u64,
    pub refunded: u64,
    pub state: u8,
    pub dispute: u8,
    pub flags: u8,
    pub capture_ids: Vec<[u8; 32]>,
}

#[derive(Debug, Default)]
pub struct Card {
    pub policy: FakePolicy,
    pub period: FakePeriod,
    pub period_pda: Address,
    pub intents: HashMap<Address, FakeIntent>,
    pub reservations: HashMap<Address, FakeReservation>,
    pub event_ids: HashSet<[u8; 32]>,
}

#[derive(Debug, Default)]
struct State {
    cards: HashMap<Address, Card>,
    signatures: HashMap<String, TxOutcome>,
    log: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub struct Knobs {
    /// Confirmation takes this long; if it exceeds the caller's deadline the
    /// transaction still lands (effects applied) but the caller sees Unknown.
    pub confirm_delay: Duration,
    /// The next N submissions vanish: no effect, outcome Unknown.
    pub drop_next: usize,
    /// Reads return RpcError while set.
    pub outage: bool,
    /// The card's private state is gone: reads return null, writes fail.
    pub lost: bool,
}

pub struct FakePer {
    key: SigningKey,
    state: Mutex<State>,
    pub knobs: Mutex<Knobs>,
}

impl std::fmt::Debug for FakePer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("FakePer")
    }
}

fn disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("global:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}

fn account_disc(name: &str) -> [u8; 8] {
    Sha256::digest(format!("account:{name}").as_bytes())[..8]
        .try_into()
        .unwrap()
}

const NAMES: [&str; 18] = [
    "roll_period",
    "record_repayment",
    "confirm_reconciled",
    "resolve_exception",
    "open_checkout_intent",
    "authorize",
    "capture",
    "reverse",
    "refund",
    "record_dispute",
    "record_exception",
    "adjust_reservation",
    "freeze",
    "recovery_freeze",
    "checkpoint",
    "close_checkout_intent",
    "unfreeze",
    "restore",
];

fn err(code: u32) -> Result<(), u32> {
    Err(code)
}

fn u64_at(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

impl FakePer {
    pub fn new() -> Self {
        Self {
            key: SigningKey::from_bytes(&[42; 32]),
            state: Mutex::new(State::default()),
            knobs: Mutex::new(Knobs::default()),
        }
    }

    pub fn authorizer(&self) -> Address {
        Address::from(self.key.verifying_key().to_bytes())
    }

    pub fn signing_key(&self) -> &SigningKey {
        &self.key
    }

    pub fn add_card(&self, policy_pda: Address, period_pda: Address, policy: FakePolicy) {
        self.state.lock().unwrap().cards.insert(
            policy_pda,
            Card {
                policy,
                period_pda,
                ..Default::default()
            },
        );
    }

    pub fn with_card<T>(&self, policy_pda: &Address, f: impl FnOnce(&mut Card) -> T) -> T {
        f(self
            .state
            .lock()
            .unwrap()
            .cards
            .get_mut(policy_pda)
            .expect("card"))
    }

    pub fn log(&self) -> Vec<String> {
        self.state.lock().unwrap().log.clone()
    }

    pub fn signature_status(&self, signature: &str) -> Option<TxOutcome> {
        self.state
            .lock()
            .unwrap()
            .signatures
            .get(signature)
            .cloned()
    }

    pub async fn submit(&self, instructions: Vec<Instruction>, deadline: Instant) -> TxOutcome {
        let mut sig = [0u8; 64];
        getrandom::fill(&mut sig).unwrap();
        let signature = bs58::encode(sig).into_string();
        let knobs = self.knobs.lock().unwrap().clone();
        if knobs.drop_next > 0 {
            self.knobs.lock().unwrap().drop_next -= 1;
            tokio::time::sleep(deadline.saturating_duration_since(Instant::now())).await;
            return TxOutcome::Unknown {
                signature: Some(signature),
            };
        }
        if knobs.lost {
            return TxOutcome::Failed {
                signature: Some(signature),
                reason: "account not found".into(),
            };
        }
        let result = {
            let mut state = self.state.lock().unwrap();
            let mut result = Ok(());
            for ix in instructions
                .iter()
                .filter(|ix| ix.program_id == program::program_id())
            {
                let name = NAMES
                    .iter()
                    .find(|n| ix.data.starts_with(&disc(n)))
                    .copied()
                    .unwrap_or("unknown");
                state.log.push(name.to_owned());
                result = apply(&mut state, &self.authorizer(), name, ix);
                if result.is_err() {
                    break;
                }
            }
            let outcome = match result {
                Ok(()) => TxOutcome::Confirmed {
                    signature: signature.clone(),
                },
                Err(code) => TxOutcome::ProgramError {
                    signature: signature.clone(),
                    code,
                },
            };
            state.signatures.insert(signature.clone(), outcome.clone());
            outcome
        };
        let remaining = deadline.saturating_duration_since(Instant::now());
        if knobs.confirm_delay > remaining {
            tokio::time::sleep(remaining).await;
            return TxOutcome::Unknown {
                signature: Some(signature),
            };
        }
        tokio::time::sleep(knobs.confirm_delay).await;
        result
    }

    pub fn read(&self, address: &Address) -> TeeRead {
        if self.knobs.lock().unwrap().outage {
            return TeeRead::RpcError("outage".into());
        }
        if self.knobs.lock().unwrap().lost {
            return TeeRead::NotVisible { slot: Some(1) };
        }
        let state = self.state.lock().unwrap();
        for (policy_pda, card) in &state.cards {
            if policy_pda == address {
                return TeeRead::Visible {
                    data: encode_policy(&card.policy),
                    owner: program::CARD_POLICY_PROGRAM_ID.into(),
                    slot: 1,
                };
            }
            if &card.period_pda == address {
                return TeeRead::Visible {
                    data: encode_period(policy_pda, &card.period),
                    owner: program::CARD_POLICY_PROGRAM_ID.into(),
                    slot: 1,
                };
            }
            if let Some(r) = card.reservations.get(address) {
                return TeeRead::Visible {
                    data: encode_reservation(policy_pda, r),
                    owner: program::CARD_POLICY_PROGRAM_ID.into(),
                    slot: 1,
                };
            }
            if let Some(i) = card.intents.get(address) {
                return TeeRead::Visible {
                    data: encode_intent(policy_pda, i),
                    owner: program::CARD_POLICY_PROGRAM_ID.into(),
                    slot: 1,
                };
            }
        }
        TeeRead::NotVisible { slot: Some(1) }
    }
}

fn now_secs() -> i64 {
    (super::now_ms() / 1000) as i64
}

fn with_fee(amount: u64, bps: u16) -> u64 {
    amount + (amount as u128 * bps as u128).div_ceil(10_000) as u64
}

fn ledger(card: &mut Card, kind: u8, amount: u64) {
    card.policy.ledger_seq += 1;
    let mut h = Sha256::new();
    h.update(card.policy.ledger_head);
    h.update([kind]);
    h.update(amount.to_le_bytes());
    card.policy.ledger_head = h.finalize().into();
}

fn apply(state: &mut State, authorizer: &Address, name: &str, ix: &Instruction) -> Result<(), u32> {
    let args = &ix.data[8..];
    // `restore` is co-signed: [owner, authorizer, policy, period].
    let policy_pda = ix.accounts[if name == "restore" { 2 } else { 1 }].pubkey;
    let signer = ix.accounts[0].pubkey;
    let card = state.cards.get_mut(&policy_pda).ok_or(6039u32)?;
    let is_authorizer = signer == *authorizer && card.policy.authorizer == *authorizer;
    let available = card
        .policy
        .budget
        .saturating_sub(card.period.captured + card.period.reserved);
    match name {
        "open_checkout_intent" => {
            if !is_authorizer {
                return err(6000);
            }
            if card.policy.frozen {
                return err(6004);
            }
            let id: [u8; 16] = args[0..16].try_into().unwrap();
            let agent: [u8; 32] = args[16..48].try_into().unwrap();
            let merchant: [u8; 32] = args[48..80].try_into().unwrap();
            let max = u64_at(args, 82);
            let expires_at = i64::from_le_bytes(args[93..101].try_into().unwrap());
            if !card.policy.merchants.is_empty() && !card.policy.merchants.contains(&merchant) {
                return err(6011);
            }
            if max > card.policy.max_purchase {
                return err(6015);
            }
            if max > available {
                return err(6016);
            }
            card.intents.insert(
                ix.accounts[3].pubkey,
                FakeIntent {
                    id,
                    agent,
                    merchant,
                    max,
                    version: card.policy.version,
                    expires_at,
                    state: 0,
                },
            );
            Ok(())
        }
        "authorize" => {
            if !is_authorizer {
                return err(6000);
            }
            let auth_id: [u8; 32] = args[0..32].try_into().unwrap();
            let amount = u64_at(args, 48);
            let merchant: [u8; 32] = args[59..91].try_into().unwrap();
            let single = args[94] != 0;
            let reservation = ix.accounts[4].pubkey;
            if card.reservations.contains_key(&reservation) {
                return err(6019);
            }
            if card.policy.frozen {
                return err(6004);
            }
            if card.policy.recovery != 0 {
                return err(6005);
            }
            if amount == 0 {
                return err(6035);
            }
            let intent = card
                .intents
                .get(&ix.accounts[3].pubkey)
                .cloned()
                .ok_or(6007u32)?;
            if intent.state != 0 {
                return err(6007);
            }
            if intent.expires_at <= now_secs() {
                return err(6008);
            }
            if intent.version != card.policy.version {
                return err(6009);
            }
            if merchant != intent.merchant {
                return err(6010);
            }
            if amount > intent.max {
                return err(6014);
            }
            if amount > card.policy.max_purchase {
                return err(6015);
            }
            if amount > available {
                return err(6016);
            }
            if card.policy.max_count > 0 && card.period.count >= card.policy.max_count {
                return err(6017);
            }
            card.intents.get_mut(&ix.accounts[3].pubkey).unwrap().state = 1;
            card.period.count += 1;
            let mut r = FakeReservation {
                auth_id,
                state: rs::RESERVED,
                hold: amount,
                ..Default::default()
            };
            if single {
                r.state = rs::CAPTURED;
                r.hold = 0;
                r.captured = amount;
                r.flags |= program::FLAG_SINGLE_MESSAGE;
                card.period.captured += amount;
                card.policy.outstanding += with_fee(amount, card.policy.fee_bps);
            } else {
                card.period.reserved += amount;
            }
            card.reservations.insert(reservation, r);
            ledger(card, 1, amount);
            Ok(())
        }
        "capture" | "reverse" | "record_dispute" | "adjust_reservation" => {
            if !is_authorizer {
                return err(6000);
            }
            let res_key = ix.accounts[3].pubkey;
            let fee_bps = card.policy.fee_bps as u64;
            let r = card.reservations.get_mut(&res_key).ok_or(6039u32)?;
            match name {
                "capture" => {
                    let amount = u64_at(args, 0);
                    let id: [u8; 32] = args[8..40].try_into().unwrap();
                    if r.capture_ids.contains(&id) {
                        return err(6020);
                    }
                    r.capture_ids.push(id);
                    if matches!(r.state, rs::REVERSED | rs::EXPIRED) {
                        r.flags |= program::FLAG_LATE_CAPTURE;
                        r.captured += amount;
                        card.period.captured += amount;
                    } else {
                        let take = amount.min(r.hold);
                        let excess = amount - take;
                        r.hold -= take;
                        r.captured += amount;
                        card.period.reserved = card.period.reserved.saturating_sub(take);
                        card.period.captured += amount;
                        if excess > 0 {
                            r.flags |= program::FLAG_OVER_CAPTURE;
                            card.period.exception += excess;
                            card.policy.exceptions_open += 1;
                        }
                        r.state = if r.hold == 0 {
                            rs::CAPTURED
                        } else {
                            rs::PARTIALLY_CAPTURED
                        };
                    }
                    card.policy.outstanding += amount + (amount * fee_bps).div_ceil(10_000);
                }
                "reverse" => {
                    let amount = u64_at(args, 0);
                    let reason = args[8];
                    let id: [u8; 32] = args[9..41].try_into().unwrap();
                    if card.event_ids.contains(&id) {
                        return err(6043);
                    }
                    if r.hold == 0 {
                        return err(6021);
                    }
                    card.event_ids.insert(id);
                    let release = amount.min(r.hold);
                    r.hold -= release;
                    r.reversed += release;
                    card.period.reserved = card.period.reserved.saturating_sub(release);
                    if r.hold == 0 && r.captured == 0 {
                        r.state = if reason == 1 {
                            rs::EXPIRED
                        } else {
                            rs::REVERSED
                        };
                    } else if r.hold == 0 {
                        r.state = rs::CAPTURED;
                    }
                }
                "record_dispute" => {
                    let id: [u8; 32] = args[1..33].try_into().unwrap();
                    if card.event_ids.contains(&id) {
                        return err(6043);
                    }
                    card.event_ids.insert(id);
                    r.dispute = args[0];
                }
                _ => {
                    let new = u64_at(args, 0);
                    if new < r.hold {
                        card.period.reserved -= r.hold - new;
                        r.hold = new;
                    } else if new > r.hold {
                        let delta = new - r.hold;
                        if delta > available {
                            return err(6016);
                        }
                        card.period.reserved += delta;
                        r.hold = new;
                    }
                }
            }
            Ok(())
        }
        "refund" | "record_exception" => {
            if !is_authorizer {
                return err(6000);
            }
            let (kind, amount, id) = if name == "refund" {
                (
                    0,
                    u64_at(args, 0),
                    <[u8; 32]>::try_from(&args[8..40]).unwrap(),
                )
            } else {
                (
                    args[0],
                    u64_at(args, 1),
                    <[u8; 32]>::try_from(&args[9..41]).unwrap(),
                )
            };
            if card.event_ids.contains(&id) {
                return err(6043);
            }
            card.event_ids.insert(id);
            let res_key = ix.accounts[3].pubkey;
            let reservation = (res_key != program::program_id()).then_some(res_key);
            let bps = card.policy.fee_bps;
            let credit = |card: &mut Card| {
                let gross = with_fee(amount, bps);
                card.policy.outstanding -= gross.min(card.policy.outstanding);
            };
            if name == "refund" {
                card.period.refunded += amount;
                if let Some(r) = reservation.and_then(|k| card.reservations.get_mut(&k)) {
                    r.refunded += amount;
                }
                credit(card);
            } else {
                card.policy.exceptions_open += 1;
                match kind {
                    program::exception_kind::CORRECTION_CREDIT => {
                        card.period.refunded += amount;
                        credit(card);
                    }
                    program::exception_kind::OVER_HOLD => {
                        if let Some(r) = reservation.and_then(|k| card.reservations.get_mut(&k)) {
                            r.hold += amount;
                        }
                        card.period.reserved += amount;
                    }
                    _ => {
                        card.period.captured += amount;
                        card.period.exception += amount;
                        card.policy.outstanding += with_fee(amount, bps);
                    }
                }
            }
            Ok(())
        }
        "freeze" => {
            card.policy.frozen = true;
            ledger(card, 8, 0);
            Ok(())
        }
        "unfreeze" => {
            if signer != card.policy.owner {
                return err(6000);
            }
            if card.policy.recovery != 0 {
                return err(6005);
            }
            card.policy.frozen = false;
            Ok(())
        }
        "roll_period" => {
            if !is_authorizer {
                return err(6000);
            }
            if card.period.end != 0 && now_secs() < card.period.end || card.period.end == 0 {
                return err(6022);
            }
            let now = now_secs();
            for meta in &ix.accounts[3..] {
                if let Some(r) = card.reservations.get_mut(&meta.pubkey) {
                    if matches!(r.state, rs::RESERVED | rs::PARTIALLY_CAPTURED) {
                        card.period.reserved = card.period.reserved.saturating_sub(r.hold);
                        r.hold = 0;
                        r.state = rs::EXPIRED;
                    }
                }
            }
            card.period.index = card.period.index.max(1) + 1;
            card.period.start = now;
            card.period.end = now + card.policy.period_seconds.max(86_400) as i64;
            // Purchase allowance only: holds and credit exposure carry over.
            card.period.captured = 0;
            card.period.refunded = 0;
            card.period.count = 0;
            card.period.exception = 0;
            ledger(card, 7, card.period.reserved);
            Ok(())
        }
        "record_repayment" => {
            if !is_authorizer {
                return err(6000);
            }
            let digest: [u8; 32] = args[0..32].try_into().unwrap();
            let amount = u64_at(args, 32);
            if amount == 0 {
                return err(6035);
            }
            if digest == [0; 32] {
                return err(6042);
            }
            if card.policy.repayments.contains(&digest) {
                return err(6032);
            }
            if amount > card.policy.outstanding {
                return err(6038);
            }
            card.policy.outstanding -= amount;
            card.policy.repayments.push(digest);
            if card.policy.repayments.len() > 8 {
                card.policy.repayments.remove(0);
            }
            ledger(card, 15, amount);
            Ok(())
        }
        "restore" => {
            // Co-signed: owner + the member authorizer.
            if signer != card.policy.owner || ix.accounts[1].pubkey != *authorizer {
                return err(6000);
            }
            if card.policy.recovery != 1 {
                return err(6026);
            }
            let tail = &args[args.len() - (4 + 8 * 3 + 2 + 8 * 2 + 32 + 8 + 32)..];
            let period_index = u32::from_le_bytes(tail[0..4].try_into().unwrap());
            card.period.index = period_index;
            card.period.captured = u64_at(tail, 4);
            card.period.reserved = u64_at(tail, 12);
            card.period.refunded = u64_at(tail, 20);
            card.period.count = u16::from_le_bytes(tail[28..30].try_into().unwrap());
            card.period.exception = u64_at(tail, 30);
            card.policy.outstanding = u64_at(tail, 38);
            card.policy.ledger_head = tail[46..78].try_into().unwrap();
            card.policy.ledger_seq = u64_at(tail, 78);
            card.policy.recon_digest = tail[86..118].try_into().unwrap();
            card.policy.recovery = 2;
            card.policy.version += 1;
            ledger(card, 13, 0);
            Ok(())
        }
        "confirm_reconciled" => {
            if signer != card.policy.owner {
                return err(6000);
            }
            if card.policy.recovery != 2 {
                return err(6026);
            }
            if args[0..32] != card.policy.recon_digest {
                return err(6037);
            }
            card.policy.recovery = 0;
            Ok(())
        }
        "recovery_freeze" => {
            card.policy.frozen = true;
            card.policy.recovery = 1;
            ledger(card, 12, 0);
            Ok(())
        }
        "checkpoint" => {
            card.policy.commit_seq = u64_at(args, 32);
            Ok(())
        }
        _ => Ok(()),
    }
}

pub fn encode_policy(p: &FakePolicy) -> Vec<u8> {
    let mut d = account_disc("CardPolicy").to_vec();
    d.extend_from_slice(p.binding.as_ref());
    d.extend_from_slice(p.owner.as_ref());
    d.extend_from_slice(p.authorizer.as_ref());
    d.extend_from_slice(&p.version.to_le_bytes());
    d.extend_from_slice(&p.budget.to_le_bytes());
    d.extend_from_slice(&p.max_purchase.to_le_bytes());
    d.extend_from_slice(&p.max_count.to_le_bytes());
    d.extend_from_slice(
        &(if p.period_seconds == 0 {
            2_592_000
        } else {
            p.period_seconds
        })
        .to_le_bytes(),
    );
    d.extend_from_slice(b"USD");
    d.push(p.merchants.len() as u8);
    for i in 0..8 {
        d.extend_from_slice(p.merchants.get(i).unwrap_or(&[0; 32]));
    }
    d.push(p.mccs.len() as u8);
    for i in 0..16 {
        d.extend_from_slice(&p.mccs.get(i).copied().unwrap_or(0).to_le_bytes());
    }
    d.extend_from_slice(&0i64.to_le_bytes());
    d.push(0);
    d.extend_from_slice(&p.fee_bps.to_le_bytes());
    d.push(p.frozen as u8);
    d.push(if p.frozen { 1 } else { 0 });
    d.push(p.recovery);
    d.extend_from_slice(&p.outstanding.to_le_bytes());
    d.extend_from_slice(&p.exceptions_open.to_le_bytes());
    d.push(2);
    d.extend_from_slice(&[0; 32 * 6 + 6]);
    d.extend_from_slice(&p.ledger_head);
    d.extend_from_slice(&p.ledger_seq.to_le_bytes());
    d.extend_from_slice(&p.commit_seq.to_le_bytes());
    d.push(1);
    d.extend_from_slice(&p.recon_digest);
    for i in 0..8 {
        d.extend_from_slice(p.repayments.get(i).unwrap_or(&[0; 32]));
    }
    d.push(p.repayments.len() as u8);
    d.extend_from_slice(&[0; 32 * 16 + 1 + 2]);
    d
}

pub fn encode_period(policy: &Address, p: &FakePeriod) -> Vec<u8> {
    let mut d = account_disc("CardPeriod").to_vec();
    d.extend_from_slice(policy.as_ref());
    d.extend_from_slice(&p.index.max(1).to_le_bytes());
    d.extend_from_slice(&p.start.to_le_bytes());
    d.extend_from_slice(&(if p.end == 0 { i64::MAX } else { p.end }).to_le_bytes());
    d.extend_from_slice(&p.captured.to_le_bytes());
    d.extend_from_slice(&p.reserved.to_le_bytes());
    d.extend_from_slice(&p.refunded.to_le_bytes());
    d.extend_from_slice(&p.count.to_le_bytes());
    d.extend_from_slice(&p.exception.to_le_bytes());
    d.push(1);
    d
}

pub fn encode_reservation(policy: &Address, r: &FakeReservation) -> Vec<u8> {
    let mut d = account_disc("Reservation").to_vec();
    d.extend_from_slice(policy.as_ref());
    d.extend_from_slice(&r.auth_id);
    d.extend_from_slice(&[0; 32]);
    d.extend_from_slice(&1u32.to_le_bytes());
    d.extend_from_slice(&r.hold.to_le_bytes());
    d.extend_from_slice(&r.captured.to_le_bytes());
    d.extend_from_slice(&r.reversed.to_le_bytes());
    d.extend_from_slice(&r.refunded.to_le_bytes());
    d.push(r.state);
    d.push(r.dispute);
    d.push(r.flags);
    d.extend_from_slice(&now_secs().to_le_bytes());
    d.extend_from_slice(&(now_secs() + 7 * 86_400).to_le_bytes());
    d.push(1);
    d.push(r.capture_ids.len() as u8);
    d.extend_from_slice(&[0; 32 * 8]);
    d
}

pub fn encode_intent(policy: &Address, i: &FakeIntent) -> Vec<u8> {
    let mut d = account_disc("CheckoutIntent").to_vec();
    d.extend_from_slice(policy.as_ref());
    d.extend_from_slice(&i.id);
    d.extend_from_slice(&i.agent);
    d.extend_from_slice(&i.merchant);
    d.extend_from_slice(&0u16.to_le_bytes());
    d.extend_from_slice(&i.max.to_le_bytes());
    d.extend_from_slice(b"USD");
    d.extend_from_slice(&i.version.to_le_bytes());
    d.extend_from_slice(&i.expires_at.to_le_bytes());
    d.push(i.state);
    d.extend_from_slice(&[0; 32]);
    d.push(1);
    d
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn fake_accounts_round_trip_through_the_real_decoders() {
        let policy = FakePolicy {
            version: 3,
            budget: 5_000,
            max_purchase: 4_000,
            merchants: vec![[1; 32]],
            frozen: true,
            ledger_seq: 9,
            commit_seq: 2,
            ..Default::default()
        };
        let decoded = program::decode_policy(&encode_policy(&policy)).unwrap();
        assert_eq!(
            (
                decoded.policy_version,
                decoded.budget_cents,
                decoded.frozen,
                decoded.ledger_seq,
                decoded.commit_seq
            ),
            (3, 5_000, true, 9, 2)
        );
        let r = FakeReservation {
            hold: 7,
            captured: 3,
            state: rs::PARTIALLY_CAPTURED,
            ..Default::default()
        };
        let decoded =
            program::decode_reservation(&encode_reservation(&Address::default(), &r)).unwrap();
        assert_eq!(
            (
                decoded.amount_reserved_cents,
                decoded.captured_cents,
                decoded.state
            ),
            (7, 3, rs::PARTIALLY_CAPTURED)
        );
        let period = program::decode_period(&encode_period(
            &Address::default(),
            &FakePeriod {
                captured: 5,
                reserved: 6,
                ..Default::default()
            },
        ))
        .unwrap();
        assert_eq!((period.captured_cents, period.reserved_cents), (5, 6));
        let intent = FakeIntent {
            id: [1; 16],
            agent: [2; 32],
            merchant: [3; 32],
            max: 9,
            version: 1,
            expires_at: 5,
            state: 0,
        };
        assert_eq!(
            program::decode_intent(&encode_intent(&Address::default(), &intent))
                .unwrap()
                .max_amount_cents,
            9
        );
    }
}
