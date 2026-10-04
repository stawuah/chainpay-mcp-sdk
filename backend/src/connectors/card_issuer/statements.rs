//! Statements, simulated credit and repayment (contracts.md §4.2, §7).
//!
//! **Simulated credit.** No credit facility exists behind these statements:
//! the "partner" that confirms a repayment is a labelled simulation
//! ([`partner_confirm`]). Everything else is real: the lines come from the
//! money movements `card_policy` actually booked, the amount due is exact
//! integer cents, and a statement is discharged only after
//!
//! 1. an existing ChainPay `execute_payment` receipt on Devnet is verified
//!    against the statement (mint, network, amount, recipient, reference =
//!    `invoice_hash` = statement digest, payer = card owner), **and**
//! 2. the simulated partner ledger confirmed the same digest and amount, **and**
//! 3. `record_repayment` reduced `statement_outstanding_cents` on PER.
//!
//! A wrong mint, network, amount, recipient or reference can never close a
//! statement: it lands in `repayment_mismatch` and stays payable.
//!
//! **Postings.** Every confirmed money movement on PER (capture, refund,
//! exception debit/credit, single-message authorization) writes one posting
//! row, keyed by its event id so a retry never double counts. A statement
//! close takes the open postings up to its cut, freezes them as lines and
//! re-files them under the statement. Postings that land after a cut go to the
//! next statement (posting-date semantics), never into the void.
//!
//! **Rollover.** `roll_period` resets the purchase allowance only; holds and
//! credit exposure carry over on-chain, and an unpaid statement stays payable
//! across any number of later closes.

use super::program;
use super::routes::{Caller, CardsError, card_pdas, owned_card, readable_card};
use super::tee::{TeeRead, TxOutcome};
use super::{CONNECTOR, CardsConnector, cents, log_id, now_ms, parse_cents, rfc3339, updated_now};
use crate::storage::{CardIndex, CardKind, CardPut, StorageError, StoredCardRecord};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const SIMULATED_LABEL: &str = "Simulated credit";
pub const PARTNER_LABEL: &str = "Simulated partner ledger";
pub const DUE_DAYS: u64 = 21;
/// Devnet USDC (the mint the existing Devnet flow registers).
pub const DEVNET_USDC_MINT: &str = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SPL_TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const MANDATE_DISCRIMINATOR: [u8; 8] = [139, 106, 43, 122, 82, 211, 96, 162];
const RECEIPT_DISCRIMINATOR: [u8; 8] = [168, 198, 209, 4, 60, 235, 126, 109];
const PAGE: u32 = 200;

// ------------------------------------------------------------------ config

/// Where repayments must land. `partner_token_account` is the simulated
/// partner's token account for `mint` on Devnet; without it the repayment
/// route answers 503 rather than verify against nothing.
#[derive(Debug, Clone)]
pub struct RepaymentConfig {
    pub mint: String,
    pub partner_token_account: Option<String>,
}

impl Default for RepaymentConfig {
    fn default() -> Self {
        Self {
            mint: DEVNET_USDC_MINT.into(),
            partner_token_account: None,
        }
    }
}

pub fn is_address(value: &str) -> bool {
    bs58::decode(value)
        .into_vec()
        .is_ok_and(|bytes| bytes.len() == 32)
}

// ------------------------------------------------------------------- money

/// `fee(x) = floor(x · fee_bps / 10_000)`, the program's one rule for debit
/// and credit lines alike (contracts.md §1.5, review fixes 2026-10-04): split
/// refunds never credit more than one refund, and statements match on-chain
/// exposure line for line. Vectors: `shared/cards/fee-vectors.json`.
pub fn fee_cents(amount: u64, fee_bps: u16) -> u64 {
    ((amount as u128 * fee_bps as u128) / 10_000) as u64
}

/// Signed cents as an exact decimal string (`-250`, `0`, `2010`).
pub fn signed(value: i128) -> String {
    value.to_string()
}

fn parse_signed(value: &Value) -> i128 {
    value
        .as_str()
        .and_then(|v| v.parse::<i128>().ok())
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostingKind {
    Purchase,
    Refund,
    AdjustmentDebit,
    AdjustmentCredit,
}

impl PostingKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Purchase => "purchase",
            Self::Refund => "refund",
            Self::AdjustmentDebit => "adjustment_debit",
            Self::AdjustmentCredit => "adjustment_credit",
        }
    }
    pub fn is_credit(self) -> bool {
        matches!(self, Self::Refund | Self::AdjustmentCredit)
    }
    fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "purchase" => Self::Purchase,
            "refund" => Self::Refund,
            "adjustment_debit" => Self::AdjustmentDebit,
            "adjustment_credit" => Self::AdjustmentCredit,
            _ => return None,
        })
    }
}

/// The posting a confirmed `card_policy` step books, mirroring the program's
/// exposure rules: captures and debit exceptions add `amount + fee`, refunds
/// and correction credits remove it, an over-hold moves no money.
pub fn posting_for_label(label: &str) -> Option<(PostingKind, Option<&'static str>)> {
    Some(match label {
        "capture" | "single_message" | "late_capture" => (PostingKind::Purchase, None),
        // Clearing above a fully captured hold whose Reservation was closed.
        // Booked exactly like the open-hold path, where `capture` posts the
        // whole amount as a purchase (the row carries the review flag).
        "over_capture" => (PostingKind::Purchase, None),
        "refund" => (PostingKind::Refund, None),
        "forced_capture" => (PostingKind::AdjustmentDebit, Some("forced_capture")),
        "unpaired_capture" => (PostingKind::AdjustmentDebit, Some("unpaired_capture")),
        "return_reversal" => (PostingKind::AdjustmentDebit, Some("return_reversal")),
        "correction_debit" => (PostingKind::AdjustmentDebit, Some("correction_debit")),
        "correction_credit" => (PostingKind::AdjustmentCredit, Some("correction_credit")),
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub event_id: String,
    pub kind: PostingKind,
    pub amount: u64,
    pub fee: u64,
    pub posted_at: String,
    pub display_name: String,
    pub exception: Option<String>,
}

impl Line {
    /// Signed effect on what the owner owes, fee included.
    pub fn signed_total(&self) -> i128 {
        let gross = (self.amount + self.fee) as i128;
        if self.kind.is_credit() { -gross } else { gross }
    }
    fn signed_amount(&self) -> i128 {
        if self.kind.is_credit() {
            -(self.amount as i128)
        } else {
            self.amount as i128
        }
    }
    fn signed_fee(&self) -> i128 {
        if self.kind.is_credit() {
            -(self.fee as i128)
        } else {
            self.fee as i128
        }
    }
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "lineId": self.event_id,
            "kind": self.kind.as_str(),
            "amountCents": signed(self.signed_amount()),
            "feeCents": signed(self.signed_fee()),
            "postedAt": self.posted_at,
            "merchant": {"displayName": self.display_name},
        });
        if let Some(exception) = &self.exception {
            v["exception"] = json!(exception);
            v["needsReview"] = json!(true);
        }
        v
    }
    pub fn digest(&self) -> String {
        canonical_hash(
            "chainpay-card-statement-line:v1\n",
            &json!({
                "lineId": self.event_id,
                "kind": self.kind.as_str(),
                "amountCents": signed(self.signed_amount()),
                "feeCents": signed(self.signed_fee()),
                "postedAt": self.posted_at,
            }),
        )
    }
    fn from_json(value: &Value) -> Option<Self> {
        let amount = parse_signed(&value["amountCents"]).unsigned_abs() as u64;
        let fee = parse_signed(&value["feeCents"]).unsigned_abs() as u64;
        Some(Self {
            event_id: value["lineId"].as_str()?.to_owned(),
            kind: PostingKind::parse(value["kind"].as_str()?)?,
            amount,
            fee,
            posted_at: value["postedAt"].as_str()?.to_owned(),
            display_name: value["merchant"]["displayName"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            exception: value["exception"].as_str().map(str::to_owned),
        })
    }
}

/// Exact statement totals (contracts.md §7.1), integers only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Totals {
    pub purchases: i128,
    pub refunds: i128,
    pub fees: i128,
    /// `purchases − refunds + fees`; negative when credits exceed debits.
    pub total: i128,
    /// Credit carried in from earlier statements, applied here.
    pub carried_credit: i128,
    /// `max(0, total − carried_credit)`: the exact amount to repay.
    pub amount_due: i128,
    /// `max(0, carried_credit − total)`: credit left for the next statement.
    pub credit_forward: i128,
}

pub fn totals(lines: &[Line], carried_credit: u64) -> Totals {
    let purchases: i128 = lines
        .iter()
        .filter(|l| !l.kind.is_credit())
        .map(|l| l.amount as i128)
        .sum();
    let refunds: i128 = lines
        .iter()
        .filter(|l| l.kind.is_credit())
        .map(|l| l.amount as i128)
        .sum();
    let fees: i128 = lines.iter().map(Line::signed_fee).sum();
    let total = purchases - refunds + fees;
    let net = total - carried_credit as i128;
    Totals {
        purchases,
        refunds,
        fees,
        total,
        carried_credit: carried_credit as i128,
        amount_due: net.max(0),
        credit_forward: (-net).max(0),
    }
}

/// `sha256(domain ‖ canonical JSON)` where canonical = sorted keys, compact,
/// strings and integers only (RFC 8785 for this value shape).
pub fn canonical_hash(domain: &str, value: &Value) -> String {
    let text = serde_json::to_string(value).expect("json");
    program::hex(&Sha256::digest(format!("{domain}{text}").as_bytes()))
}

#[derive(Debug, Clone)]
pub struct DigestInput<'a> {
    pub card_id: &'a str,
    pub statement_seq: u64,
    pub period_index: u32,
    pub close_kind: &'a str,
    pub closed_at: &'a str,
    pub due_at: &'a str,
    pub totals: &'a Totals,
    pub line_digests: Vec<String>,
}

/// Statement digest (contracts.md §7.1): the `invoice_hash` a repayment must
/// carry. Binds every amount, the due date and each line.
pub fn statement_digest(input: &DigestInput) -> String {
    let t = input.totals;
    canonical_hash(
        "chainpay-card-statement:v1\n",
        &json!({
            "v": 1,
            "cardId": input.card_id,
            "statementSeq": input.statement_seq,
            "periodIndex": input.period_index,
            "closeKind": input.close_kind,
            "closedAt": input.closed_at,
            "dueAt": input.due_at,
            "purchasesCents": signed(t.purchases),
            "refundsCents": signed(t.refunds),
            "feeCents": signed(t.fees),
            "totalCents": signed(t.total),
            "carriedCreditCents": signed(t.carried_credit),
            "amountDueCents": signed(t.amount_due),
            "lineDigests": input.line_digests,
        }),
    )
}

/// Token base units for `cents` of a mint with `decimals` (USDC 6 → ×10_000).
pub fn base_units(cents: u64, decimals: u8) -> Option<u64> {
    if decimals < 2 {
        return None;
    }
    10u64
        .checked_pow(decimals as u32 - 2)
        .and_then(|scale| cents.checked_mul(scale))
}

// ------------------------------------------------------------ state machine

/// Statement events (contracts.md §4.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatementEvent {
    ReceiptVerified,
    ReceiptMismatch,
    PartnerConfirmed,
    RepaymentRecorded,
    NothingDue,
}

/// The only transitions a statement can take. Anything else is refused, so a
/// failed check can never skip ahead to `discharged`.
pub fn transition(from: &str, event: StatementEvent) -> Option<&'static str> {
    use StatementEvent::*;
    Some(match (from, event) {
        ("closed" | "repayment_mismatch", ReceiptVerified) => "repayment_observed",
        ("closed" | "repayment_mismatch", ReceiptMismatch) => "repayment_mismatch",
        ("repayment_observed", PartnerConfirmed) => "partner_confirmed",
        ("partner_confirmed", RepaymentRecorded) => "discharged",
        ("closed", NothingDue) => "discharged",
        _ => return None,
    })
}

// ----------------------------------------------------------------- postings

fn posting_key(card_id: &str, event_id: &str) -> String {
    format!("post:{card_id}:{event_id}")
}

pub fn open_reference(card_id: &str) -> String {
    format!("post:{card_id}:open")
}

fn filed_reference(card_id: &str, seq: u64) -> String {
    format!("post:{card_id}:{seq:06}")
}

fn statement_key(card_id: &str, seq: u64) -> String {
    format!("stmt:{card_id}:{seq:06}")
}

/// Write the posting for one confirmed money movement. Create-only and keyed
/// by the event id, so a retried event or a replayed duplicate is a no-op.
/// The fee rate is read from PER at posting time (the rate the program just
/// applied); if PER is unreachable the close resolves it and flags the line.
pub async fn record_posting(
    cards: &CardsConnector,
    card: &StoredCardRecord,
    event_id: &[u8; 32],
    label: &str,
    amount: u64,
    display_name: &str,
) -> bool {
    let Some((kind, exception)) = posting_for_label(label) else {
        return true;
    };
    if amount == 0 {
        return true;
    }
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let event_hex = program::hex(event_id);
    let key = posting_key(&card_id, &event_hex);
    if let Ok(Some(_)) = cards
        .store
        .get_card_record(CardKind::CardEvents, &key)
        .await
    {
        return true;
    }
    let fee_bps = match card_pdas(card) {
        Ok((policy, _)) => match cards.per.read(&policy, Duration::from_secs(3)).await {
            TeeRead::Visible { data, .. } => program::decode_policy(&data).ok().map(|p| p.fee_bps),
            _ => None,
        },
        Err(_) => None,
    };
    let posted_at = rfc3339(now_ms());
    let line = json!({
        "kind": kind.as_str(),
        "amountCents": cents(amount),
        "feeBps": fee_bps,
        "displayName": display_name,
        "exception": exception,
    });
    let record = json!({
        "v": 1,
        "type": "posting",
        "cardId": card_id,
        "eventIdHash": event_hex,
        "postedAt": posted_at,
        "statementSeq": Value::Null,
        "line": cards.crypto.seal_json(CardKind::CardEvents.as_str(), &key, &line),
    });
    let index = CardIndex {
        owner: card.index.owner.clone(),
        connector: Some(CONNECTOR.into()),
        reference: Some(open_reference(&card_id)),
        idempotency: None,
    };
    match cards
        .store
        .put_card_record(
            CardKind::CardEvents,
            &key,
            index,
            record,
            None,
            updated_now(),
        )
        .await
    {
        Ok(_) => true,
        Err(_) => {
            super::card_log!("posting not stored for card {}", log_id(&card_id));
            false
        }
    }
}

fn line_from_posting(
    cards: &CardsConnector,
    row: &StoredCardRecord,
    fallback_bps: u16,
) -> Option<(Line, bool)> {
    let line: Value = cards
        .crypto
        .open_json(CardKind::CardEvents.as_str(), &row.key, &row.record["line"])
        .ok()?;
    let kind = PostingKind::parse(line["kind"].as_str()?)?;
    let amount = parse_cents(line["amountCents"].as_str()?)?;
    let (bps, assumed) = match line["feeBps"].as_u64() {
        Some(bps) => (bps as u16, false),
        None => (fallback_bps, true),
    };
    Some((
        Line {
            event_id: row.record["eventIdHash"].as_str()?.to_owned(),
            kind,
            amount,
            fee: fee_cents(amount, bps),
            posted_at: row.record["postedAt"].as_str()?.to_owned(),
            display_name: line["displayName"].as_str().unwrap_or("").to_owned(),
            exception: line["exception"].as_str().map(str::to_owned),
        },
        assumed,
    ))
}

/// Every posting row under one index reference, oldest first.
/// Every row of `kind` under one index reference (all pages), newest first.
pub(crate) async fn all_under(
    cards: &CardsConnector,
    kind: CardKind,
    owner: &str,
    reference: &str,
) -> Result<Vec<StoredCardRecord>, StorageError> {
    let mut out = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let page = cards
            .store
            .list_card_records_for_owner(kind, owner, CONNECTOR, reference, before.as_deref(), PAGE)
            .await?;
        let full = page.len() as u32 == PAGE;
        before = page.last().map(|r| r.updated.clone());
        out.extend(page);
        if !full {
            return Ok(out);
        }
    }
}

pub(crate) async fn postings_under(
    cards: &CardsConnector,
    owner: &str,
    reference: &str,
) -> Result<Vec<StoredCardRecord>, StorageError> {
    let mut out = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let page = cards
            .store
            .list_card_records_for_owner(
                CardKind::CardEvents,
                owner,
                CONNECTOR,
                reference,
                before.as_deref(),
                PAGE,
            )
            .await?;
        let full = page.len() as u32 == PAGE;
        before = page.last().map(|r| r.updated.clone());
        out.extend(page.into_iter().filter(|r| r.record["type"] == "posting"));
        if !full {
            break;
        }
    }
    out.sort_by(|a, b| {
        a.record["postedAt"]
            .as_str()
            .cmp(&b.record["postedAt"].as_str())
            .then(a.key.cmp(&b.key))
    });
    Ok(out)
}

// -------------------------------------------------------------------- close

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseKind {
    /// `roll_period` was observed for `period_index` (the closed period).
    PeriodEnd { period_index: u32 },
    /// Owner asked to close now (pay off mid-period, or before `wipe_card`,
    /// which needs zero credit exposure). The budget period is untouched.
    Interim { period_index: u32 },
}

impl CloseKind {
    fn label(&self) -> &'static str {
        match self {
            Self::PeriodEnd { .. } => "period_end",
            Self::Interim { .. } => "interim",
        }
    }
    fn period_index(&self) -> u32 {
        match self {
            Self::PeriodEnd { period_index } | Self::Interim { period_index } => *period_index,
        }
    }
}

fn billing(card: &StoredCardRecord) -> Value {
    card.record["billing"].clone()
}

/// Close a statement. Two-phase so a crash at any point resumes exactly:
/// (1) reserve the sequence number and the cut on the card row (compare and
/// swap), (2) write the statement (create-only), (3) re-file its postings,
/// (4) clear the reservation and carry any credit forward.
/// Returns `None` when there was nothing to bill (no lines, no carried credit).
pub async fn close_statement(
    cards: &Arc<CardsConnector>,
    card_id: &str,
    kind: CloseKind,
) -> Result<Option<StoredCardRecord>, CardsError> {
    close_statement_op(cards, card_id, kind, None).await
}

/// `op`: digest of the owner's close operation, written into the reservation
/// and the statement itself so a retried request finds what it produced.
pub async fn close_statement_op(
    cards: &Arc<CardsConnector>,
    card_id: &str,
    kind: CloseKind,
    op: Option<&str>,
) -> Result<Option<StoredCardRecord>, CardsError> {
    // Phase 1: reserve (or resume an earlier reservation).
    let mut reserved: Option<Value> = None;
    let at = rfc3339(now_ms());
    let wanted = kind.clone();
    cards
        .update_card(card_id, |record| {
            if record["billing"]["closing"].is_object() {
                reserved = Some(record["billing"]["closing"].clone());
                return;
            }
            let seq = record["billing"]["nextSeq"].as_u64().unwrap_or(1);
            let closing = json!({"seq": seq, "kind": wanted.label(), "periodIndex": wanted.period_index(), "cut": at, "op": op});
            if !record["billing"].is_object() {
                record["billing"] = json!({});
            }
            record["billing"]["closing"] = closing.clone();
            record["billing"]["nextSeq"] = json!(seq + 1);
            reserved = Some(closing);
        })
        .await?
        .ok_or_else(|| CardsError::not_found("Card not found"))?;
    let closing = reserved.ok_or_else(CardsError::internal)?;
    let resumed_other = closing["kind"] != kind.label()
        || closing["periodIndex"].as_u64() != Some(kind.period_index() as u64)
        || (op.is_some() && closing["op"].as_str() != op && !closing["op"].is_null());
    let result = finish_close(cards, card_id, &closing).await?;
    if resumed_other {
        // An earlier close was interrupted; it is finished now. Run this one.
        return Box::pin(close_statement_op(cards, card_id, kind, op)).await;
    }
    Ok(result)
}

async fn finish_close(
    cards: &Arc<CardsConnector>,
    card_id: &str,
    closing: &Value,
) -> Result<Option<StoredCardRecord>, CardsError> {
    let card = cards
        .card(card_id)
        .await?
        .ok_or_else(|| CardsError::not_found("Card not found"))?;
    let owner = card.index.owner.clone().unwrap_or_default();
    let seq = closing["seq"].as_u64().ok_or_else(CardsError::internal)?;
    let close_kind = closing["kind"].as_str().unwrap_or("interim").to_owned();
    let period_index = closing["periodIndex"].as_u64().unwrap_or(0) as u32;
    let cut = closing["cut"].as_str().unwrap_or("").to_owned();
    let key = statement_key(card_id, seq);
    let carried =
        parse_cents(billing(&card)["carriedCreditCents"].as_str().unwrap_or("0")).unwrap_or(0);

    let existing = cards
        .store
        .get_card_record(CardKind::CardStatements, &key)
        .await?;
    let (statement, line_ids) = match existing {
        Some(row) => {
            let ids = stored_line_ids(cards, &row)?;
            (Some(row), ids)
        }
        None => {
            let open = postings_under(cards, &owner, &open_reference(card_id)).await?;
            let fallback_bps = current_fee_bps(cards, &card).await;
            let mut lines = Vec::new();
            let mut fee_assumed = false;
            for row in open.iter().filter(|r| {
                r.record["postedAt"]
                    .as_str()
                    .is_some_and(|p| p <= cut.as_str())
            }) {
                match line_from_posting(cards, row, fallback_bps.unwrap_or(0)) {
                    Some((line, assumed)) => {
                        if assumed && fallback_bps.is_none() {
                            // No fee rate known at all: never guess an amount.
                            return Err(CardsError::unavailable(
                                "per_unavailable",
                                "The card's fee rate is unreadable right now; retry the close",
                            ));
                        }
                        fee_assumed |= assumed;
                        lines.push(line);
                    }
                    None => return Err(CardsError::internal()),
                }
            }
            // Nothing new posted: no statement. A carried credit simply
            // stays carried until there is something to apply it to.
            if lines.is_empty() {
                clear_closing(cards, card_id, seq, &close_kind, period_index, None).await?;
                return Ok(None);
            }
            let t = totals(&lines, carried);
            let closed_ms = parse_rfc3339_ms(&cut).unwrap_or_else(now_ms);
            let due_at = rfc3339(closed_ms + DUE_DAYS * 86_400_000);
            let line_digests: Vec<String> = lines.iter().map(Line::digest).collect();
            let digest = statement_digest(&DigestInput {
                card_id,
                statement_seq: seq,
                period_index,
                close_kind: &close_kind,
                closed_at: &cut,
                due_at: &due_at,
                totals: &t,
                line_digests,
            });
            let line_json: Vec<Value> = lines.iter().map(Line::to_json).collect();
            let state = if t.amount_due == 0 {
                "discharged"
            } else {
                "closed"
            };
            let mut history = vec![json!({"state": "closed", "at": cut})];
            if state == "discharged" {
                history.push(json!({"state": "discharged", "at": cut, "reason": "nothing_due"}));
            }
            let record = json!({
                "v": 1,
                "type": "statement",
                "cardId": card_id,
                "statementSeq": seq,
                "periodIndex": period_index,
                "closeKind": close_kind,
                "state": state,
                "closedAt": cut,
                "dueAt": due_at,
                "purchasesCents": signed(t.purchases),
                "refundsCents": signed(t.refunds),
                "feeCents": signed(t.fees),
                "totalCents": signed(t.total),
                "carriedCreditCents": signed(t.carried_credit),
                "amountDueCents": signed(t.amount_due),
                "creditForwardCents": signed(t.credit_forward),
                "lineCount": lines.len(),
                "feeAssumed": fee_assumed,
                "digest": digest,
                "label": SIMULATED_LABEL,
                "simulatedCredit": true,
                "repayment": Value::Null,
                "partner": Value::Null,
                "closeOperation": closing["op"],
                "history": history,
                "lines": cards.crypto.seal_json(CardKind::CardStatements.as_str(), &key, &line_json),
            });
            let index = CardIndex {
                owner: Some(owner.clone()),
                connector: Some(CONNECTOR.into()),
                reference: Some(card_id.to_owned()),
                idempotency: Some(format!("stmt-digest:{digest}")),
            };
            match cards
                .store
                .put_card_record(
                    CardKind::CardStatements,
                    &key,
                    index,
                    record,
                    None,
                    updated_now(),
                )
                .await?
            {
                CardPut::Written(row) => {
                    let ids = lines.iter().map(|l| l.event_id.clone()).collect();
                    (Some(row), ids)
                }
                // A concurrent finisher won: refile exactly what it billed.
                CardPut::Conflict(Some(row)) => {
                    let ids = stored_line_ids(cards, &row)?;
                    (Some(row), ids)
                }
                CardPut::Conflict(None) => return Err(CardsError::internal()),
            }
        }
    };
    // Phase 3: re-file the postings under the statement.
    for id in &line_ids {
        refile_posting(cards, card_id, id, seq).await?;
    }
    let forward = statement
        .as_ref()
        .and_then(|s| s.record["creditForwardCents"].as_str())
        .and_then(parse_cents)
        .unwrap_or(0);
    clear_closing(
        cards,
        card_id,
        seq,
        &close_kind,
        period_index,
        Some(forward),
    )
    .await?;
    if let Some(row) = &statement {
        super::card_log!("statement {} closed ({close_kind})", log_id(&row.key));
        cards.metrics.count("statements_closed");
    }
    Ok(statement)
}

fn stored_line_ids(
    cards: &CardsConnector,
    row: &StoredCardRecord,
) -> Result<Vec<String>, CardsError> {
    let lines: Vec<Value> = cards
        .crypto
        .open_json(
            CardKind::CardStatements.as_str(),
            &row.key,
            &row.record["lines"],
        )
        .map_err(|_| CardsError::internal())?;
    Ok(lines
        .iter()
        .filter_map(|l| l["lineId"].as_str().map(str::to_owned))
        .collect())
}

async fn refile_posting(
    cards: &CardsConnector,
    card_id: &str,
    event_id: &str,
    seq: u64,
) -> Result<(), CardsError> {
    let key = posting_key(card_id, event_id);
    for _ in 0..5 {
        let Some(row) = cards
            .store
            .get_card_record(CardKind::CardEvents, &key)
            .await?
        else {
            return Ok(());
        };
        if row.record["statementSeq"].as_u64() == Some(seq) {
            return Ok(());
        }
        let mut record = row.record.clone();
        record["statementSeq"] = json!(seq);
        let mut index = row.index.clone();
        index.reference = Some(filed_reference(card_id, seq));
        match cards
            .store
            .put_card_record(
                CardKind::CardEvents,
                &key,
                index,
                record,
                Some(row.rev()),
                updated_now(),
            )
            .await?
        {
            CardPut::Written(_) => return Ok(()),
            CardPut::Conflict(_) => continue,
        }
    }
    Err(CardsError::internal())
}

async fn clear_closing(
    cards: &CardsConnector,
    card_id: &str,
    seq: u64,
    close_kind: &str,
    period_index: u32,
    credit_forward: Option<u64>,
) -> Result<(), CardsError> {
    cards
        .update_card(card_id, |record| {
            if record["billing"]["closing"]["seq"].as_u64() != Some(seq) {
                return;
            }
            record["billing"]["closing"] = Value::Null;
            if credit_forward.is_none() && record["billing"]["nextSeq"].as_u64() == Some(seq + 1) {
                // Nothing was billed: give the sequence number back.
                record["billing"]["nextSeq"] = json!(seq);
            }
            if let Some(forward) = credit_forward {
                record["billing"]["carriedCreditCents"] = json!(cents(forward));
                record["billing"]["lastStatementSeq"] = json!(seq);
            }
            if close_kind == "period_end" {
                record["billing"]["closedPeriodIndex"] = json!(period_index);
            }
        })
        .await?;
    Ok(())
}

async fn current_fee_bps(cards: &CardsConnector, card: &StoredCardRecord) -> Option<u16> {
    let (policy, _) = card_pdas(card).ok()?;
    match cards.per.read(&policy, Duration::from_secs(4)).await {
        TeeRead::Visible { data, .. } => program::decode_policy(&data).ok().map(|p| p.fee_bps),
        _ => None,
    }
}

/// Parse the connector's own RFC 3339 strings (`YYYY-MM-DDTHH:MM:SS.mmmZ`).
pub fn parse_rfc3339_ms(value: &str) -> Option<u64> {
    let b = value.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[10] != b'T' {
        return None;
    }
    let num = |s: &str| s.parse::<i64>().ok();
    let (y, m, d) = (num(&value[0..4])?, num(&value[5..7])?, num(&value[8..10])?);
    let (hh, mm, ss) = (
        num(&value[11..13])?,
        num(&value[14..16])?,
        num(&value[17..19])?,
    );
    let ms = if b.len() >= 24 && b[19] == b'.' {
        num(&value[20..23])?
    } else {
        0
    };
    // Howard Hinnant's days_from_civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss;
    u64::try_from(secs * 1000 + ms).ok()
}

// ------------------------------------------------------- period-end tick

/// Cron step per card: roll the period on PER once it ended, then close the
/// period's statement; finish any interrupted close; push repayments that are
/// waiting for the partner or for `record_repayment`.
pub async fn tick(cards: &Arc<CardsConnector>, card: &StoredCardRecord) {
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    if billing(card)["closing"].is_object() {
        let closing = billing(card)["closing"].clone();
        let _ = finish_close(cards, &card_id, &closing).await;
    }
    let _ = period_end(cards, card).await;
    let _ = advance_pending(cards, card).await;
}

async fn period_end(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
) -> Result<(), CardsError> {
    let card_id = card.record["cardId"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let (policy_pda, period_pda) = card_pdas(card)?;
    let (TeeRead::Visible { data: pd, .. }, TeeRead::Visible { data: qd, .. }) = (
        cards.per.read(&policy_pda, Duration::from_secs(4)).await,
        cards.per.read(&period_pda, Duration::from_secs(4)).await,
    ) else {
        return Ok(());
    };
    let policy = program::decode_policy(&pd).map_err(|_| CardsError::internal())?;
    let period = program::decode_period(&qd).map_err(|_| CardsError::internal())?;
    if policy.authorizer != cards.authorizer() || period.period_index == 0 {
        return Ok(());
    }
    let closed = billing(card)["closedPeriodIndex"].as_u64().unwrap_or(0) as u32;
    // A roll already happened (ours, interrupted before the close): close the
    // periods it left behind, oldest first.
    if period.period_index > closed + 1 {
        close_statement(
            cards,
            &card_id,
            CloseKind::PeriodEnd {
                period_index: period.period_index - 1,
            },
        )
        .await?;
        return Ok(());
    }
    let now = (now_ms() / 1000) as i64;
    if now < period.period_end {
        return Ok(());
    }
    let expired = expired_reservations(cards, card, &policy_pda, now).await;
    let outcome = cards
        .per
        .submit(
            vec![program::roll_period(
                &cards.authorizer(),
                &policy_pda,
                &period_pda,
                &expired,
            )],
            Instant::now() + Duration::from_secs(8),
        )
        .await;
    match outcome {
        TxOutcome::Confirmed { .. } => {
            cards.metrics.count("periods_rolled");
            close_statement(
                cards,
                &card_id,
                CloseKind::PeriodEnd {
                    period_index: period.period_index,
                },
            )
            .await?;
            if let Ok(Some(fresh)) = cards.card(&card_id).await {
                let _ = super::routes::checkpoint(cards, &fresh).await;
                let _ = super::reconcile::snapshot(cards, &fresh).await;
            }
            Ok(())
        }
        TxOutcome::ProgramError { code, .. } => {
            super::card_log!(
                "roll_period refused for card {}: {}",
                log_id(&card_id),
                program::error_name(code).unwrap_or("unknown")
            );
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Open reservations whose hold expired, read from PER (at most 16 per roll).
async fn expired_reservations(
    cards: &CardsConnector,
    card: &StoredCardRecord,
    policy: &Address,
    now: i64,
) -> Vec<Address> {
    let owner = card.index.owner.clone().unwrap_or_default();
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let Ok(rows) = cards
        .store
        .list_card_records_for_owner(CardKind::CardEvents, &owner, CONNECTOR, card_id, None, PAGE)
        .await
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for row in rows.iter().filter(|r| {
        r.record["type"] == "transaction"
            && matches!(
                r.record["state"].as_str(),
                Some("reserved" | "partially_captured")
            )
    }) {
        let Some(token) = row.key.strip_prefix("asa:") else {
            continue;
        };
        let pda = program::reservation_pda(
            policy,
            &program::auth_id_hash(cards.config.issuer_code, token),
        );
        if let TeeRead::Visible { data, .. } = cards.per.read(&pda, Duration::from_secs(3)).await {
            if program::decode_reservation(&data).is_ok_and(|r| {
                matches!(
                    r.state,
                    program::reservation_state::RESERVED
                        | program::reservation_state::PARTIALLY_CAPTURED
                ) && now >= r.hold_expires_at
            }) {
                out.push(pda);
            }
        }
        if out.len() == 16 {
            break;
        }
    }
    out
}

// ----------------------------------------------------------------- routes

fn statement_id_of(row: &StoredCardRecord) -> String {
    row.key.strip_prefix("stmt:").unwrap_or(&row.key).to_owned()
}

/// `StatementView` (contracts.md §7) plus the exact payment instructions.
pub fn statement_view(cards: &CardsConnector, row: &StoredCardRecord) -> Value {
    let r = &row.record;
    let lines = cards
        .crypto
        .open_json::<Value>(CardKind::CardStatements.as_str(), &row.key, &r["lines"])
        .unwrap_or(json!([]));
    let state = r["state"].as_str().unwrap_or("closed");
    let due_ms = r["dueAt"]
        .as_str()
        .and_then(parse_rfc3339_ms)
        .unwrap_or(u64::MAX);
    let overdue = matches!(state, "closed" | "repayment_mismatch") && now_ms() > due_ms;
    let amount_due = parse_cents(r["amountDueCents"].as_str().unwrap_or("0")).unwrap_or(0);
    let mut view = json!({
        "statementId": statement_id_of(row),
        "cardId": r["cardId"],
        "statementSeq": r["statementSeq"],
        "periodIndex": r["periodIndex"],
        "closeKind": r["closeKind"],
        "state": state,
        "displayState": if overdue { "overdue" } else { state },
        "overdue": overdue,
        "closedAt": r["closedAt"],
        "dueAt": r["dueAt"],
        "purchasesCents": r["purchasesCents"],
        "refundsCents": r["refundsCents"],
        "feeCents": r["feeCents"],
        "totalCents": r["totalCents"],
        "carriedCreditCents": r["carriedCreditCents"],
        "amountDueCents": r["amountDueCents"],
        "creditForwardCents": r["creditForwardCents"],
        "digest": r["digest"],
        "lines": lines,
        "repayment": super::private_repay::owner_repayment(cards, row),
        "privateRepayment": super::private_repay::owner_attempts(cards, row),
        "partner": r["partner"],
        "discharge": r["discharge"],
        "history": r["history"],
        "label": SIMULATED_LABEL,
        "simulatedCredit": true,
    });
    if amount_due > 0 && matches!(state, "closed" | "repayment_mismatch") {
        let cfg = &cards.config.repayment;
        view["payWith"] = json!({
            "method": "chainpay_execute_payment",
            "cluster": "devnet",
            "mint": cfg.mint,
            "recipientTokenAccount": cfg.partner_token_account,
            "invoiceHash": r["digest"],
            "amountCents": cents(amount_due),
            "note": "Pay from your own spending permission; ChainPay never pays a statement by itself.",
        });
        // Opt-in alternative (contracts.md §7.3): the owner's client must show
        // the vault model before preparing an attempt.
        view["payPrivately"] = json!({
            "method": super::private_repay::METHOD,
            "prepare": format!("/v1/cards/{}/statements/{}/repayment/private", r["cardId"].as_str().unwrap_or(""), statement_id_of(row)),
            "cluster": "devnet",
            "verification": "settlement_to_partner_only",
            "payerVerified": false,
        });
    }
    view
}

pub async fn list(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
) -> Result<Value, CardsError> {
    let card = readable_card(cards, caller, card_id, "get_statement").await?;
    let owner = card.index.owner.clone().unwrap_or_default();
    let rows = cards
        .store
        .list_card_records_for_owner(
            CardKind::CardStatements,
            &owner,
            CONNECTOR,
            card_id,
            None,
            50,
        )
        .await?;
    let mut rows: Vec<&StoredCardRecord> = rows
        .iter()
        .filter(|r| r.record["type"] == "statement")
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.record["statementSeq"].as_u64().unwrap_or(0)));
    let open = open_view(cards, &card).await?;
    let agent_view = !caller.is_owner_session();
    let view = |row: &StoredCardRecord| {
        let mut v = statement_view(cards, row);
        if agent_view {
            super::private_repay::redact_for_agent(&mut v);
        }
        v
    };
    Ok(json!({
        "statements": rows.iter().map(|row| view(row)).collect::<Vec<_>>(),
        "open": open,
        "label": SIMULATED_LABEL,
        "simulatedCredit": true,
    }))
}

/// Running (not yet closed) statement: open postings so far, never a due amount.
async fn open_view(cards: &CardsConnector, card: &StoredCardRecord) -> Result<Value, CardsError> {
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let owner = card.index.owner.clone().unwrap_or_default();
    let open = postings_under(cards, &owner, &open_reference(card_id)).await?;
    let fallback = if open.is_empty() {
        None
    } else {
        current_fee_bps(cards, card).await
    };
    let lines: Vec<Line> = open
        .iter()
        .filter_map(|row| line_from_posting(cards, row, fallback.unwrap_or(0)).map(|(l, _)| l))
        .collect();
    let carried =
        parse_cents(billing(card)["carriedCreditCents"].as_str().unwrap_or("0")).unwrap_or(0);
    let t = totals(&lines, carried);
    Ok(json!({
        "lineCount": lines.len(),
        "purchasesCents": signed(t.purchases),
        "refundsCents": signed(t.refunds),
        "feeCents": signed(t.fees),
        "runningTotalCents": signed(t.total),
        "carriedCreditCents": signed(t.carried_credit),
        "lines": lines.iter().map(Line::to_json).collect::<Vec<_>>(),
    }))
}

pub async fn get(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    statement_id: &str,
) -> Result<Value, CardsError> {
    readable_card(cards, caller, card_id, "get_statement").await?;
    let row = statement_row(cards, card_id, statement_id).await?;
    let mut view = statement_view(cards, &row);
    if !caller.is_owner_session() {
        super::private_repay::redact_for_agent(&mut view);
    }
    Ok(view)
}

pub(super) async fn statement_row(
    cards: &CardsConnector,
    card_id: &str,
    statement_id: &str,
) -> Result<StoredCardRecord, CardsError> {
    if !statement_id.starts_with(&format!("{card_id}:")) || statement_id.len() > 100 {
        return Err(CardsError::not_found("Statement not found"));
    }
    cards
        .store
        .get_card_record(CardKind::CardStatements, &format!("stmt:{statement_id}"))
        .await?
        .filter(|row| row.record["type"] == "statement" && row.record["cardId"] == card_id)
        .ok_or_else(|| CardsError::not_found("Statement not found"))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CloseRequest {
    pub client_operation_id: String,
}

/// `POST /v1/cards/{cardId}/statements/close` (owner): close the running
/// statement now without touching the budget period.
pub async fn close_now(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    body: CloseRequest,
) -> Result<Value, CardsError> {
    super::routes::operation_id(&body.client_operation_id)?;
    let card = owned_card(cards, caller, card_id).await?;
    if super::recovery::in_recovery(&card) {
        return Err(CardsError::conflict(
            "card_in_recovery",
            "The card is in recovery; restore and reconcile it before closing a statement",
        ));
    }
    let op = format!("card-stmt-close:v1:{card_id}:{}", body.client_operation_id);
    let op_digest = program::hex(&Sha256::digest(op.as_bytes())[..16]);
    let (won, _, _, _) = cards
        .store
        .claim_operation(
            &op,
            &caller.wallet,
            json!({"cardId": card_id}),
            json!({"op": op_digest}),
        )
        .await?;
    if !won {
        // Same operation retried: answer with the statement it produced.
        let owner = card.index.owner.clone().unwrap_or_default();
        let rows = cards
            .store
            .list_card_records_for_owner(
                CardKind::CardStatements,
                &owner,
                CONNECTOR,
                card_id,
                None,
                50,
            )
            .await?;
        if let Some(row) = rows
            .iter()
            .find(|r| r.record["closeOperation"] == op_digest.as_str())
        {
            return Ok(statement_view(cards, row));
        }
    }
    let (_, period_pda) = card_pdas(&card)?;
    let period_index = match cards.per.read(&period_pda, Duration::from_secs(5)).await {
        TeeRead::Visible { data, .. } => {
            program::decode_period(&data)
                .map_err(|_| CardsError::internal())?
                .period_index
        }
        TeeRead::NotVisible { .. } => {
            return Err(CardsError::conflict(
                "policy_not_visible",
                "The card's private state is not readable by ChainPay's authorizer",
            ));
        }
        TeeRead::RpcError(_) => {
            return Err(CardsError::unavailable(
                "per_unavailable",
                "The private rollup is unreachable; retry",
            ));
        }
    };
    match close_statement_op(
        cards,
        card_id,
        CloseKind::Interim { period_index },
        Some(&op_digest),
    )
    .await?
    {
        Some(row) => {
            if let Ok(Some(fresh)) = cards.card(card_id).await {
                let _ = super::routes::checkpoint(cards, &fresh).await;
            }
            Ok(statement_view(cards, &row))
        }
        None => Err(CardsError::conflict(
            "nothing_to_close",
            "There is nothing on the running statement to close",
        )),
    }
}

// --------------------------------------------------------------- repayment

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RepaymentRequest {
    /// Optional echo of `payWith.method`; only the transparent label is
    /// accepted here (the private method has its own body).
    #[serde(default)]
    pub method: Option<String>,
    pub receipt_pda: String,
    pub mandate_pda: String,
    pub cluster: String,
}

/// What the receipt must show for this statement.
#[derive(Debug, Clone)]
pub struct ExpectedRepayment {
    pub cluster: String,
    pub chainpay_program: String,
    pub mandate: String,
    pub receipt: String,
    pub digest: [u8; 32],
    pub owner: String,
    pub mint: String,
    pub recipient: String,
    pub amount_cents: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verification {
    Verified {
        amount_base_units: u64,
        decimals: u8,
        executed_at_slot: u64,
    },
    Mismatch(Vec<&'static str>),
    /// The receipt is not finalized (yet). Nothing changes; retry later.
    NotFound,
    Unavailable,
}

fn pda_with_bump(seeds: &[&[u8]], program: &Address) -> Option<Address> {
    Some(Address::find_program_address(seeds, program).0)
}

fn key_bytes(value: &str) -> Option<[u8; 32]> {
    bs58::decode(value).into_vec().ok()?.try_into().ok()
}

/// Verify a repayment receipt (contracts.md §7.2) at **finalized**
/// commitment. Every field is checked and every mismatch is reported; then
/// the existing settlement verifier (`verify_receipt_account`) must also pass
/// on the same account, so the card path can never be looser than payments.
pub async fn verify_receipt(base: &BaseChain, expected: &ExpectedRepayment) -> Verification {
    let mut mismatch: Vec<&'static str> = Vec::new();
    if expected.cluster != "devnet" || base.cluster != "devnet" {
        mismatch.push("network");
    }
    let (Some(program), Some(mandate_key)) = (
        key_bytes(&expected.chainpay_program).map(Address::from),
        key_bytes(&expected.mandate),
    ) else {
        return Verification::Mismatch(vec!["mandate"]);
    };
    let derived = pda_with_bump(&[b"receipt", &mandate_key, &expected.digest], &program);
    if derived.map(|d| d.to_string()) != Some(expected.receipt.clone()) {
        mismatch.push("reference");
    }
    let receipt = match base.account(&expected.receipt).await {
        Ok(Some(account)) => account,
        Ok(None) => {
            return if mismatch.is_empty() {
                Verification::NotFound
            } else {
                Verification::Mismatch(mismatch)
            };
        }
        Err(()) => return Verification::Unavailable,
    };
    let data = &receipt.data;
    if receipt.owner != expected.chainpay_program {
        mismatch.push("program");
    }
    if data.len() < crate::receipts::RECEIPT_ACCOUNT_LENGTH || data[..8] != RECEIPT_DISCRIMINATOR {
        mismatch.push("receipt");
        return Verification::Mismatch(mismatch);
    }
    if data[8..40] != mandate_key {
        mismatch.push("mandate");
    }
    if data[40..72] != expected.digest {
        mismatch.push("reference");
    }
    let mint_ok = key_bytes(&expected.mint).is_some_and(|m| data[104..136] == m);
    if !mint_ok {
        mismatch.push("mint");
    }
    if !key_bytes(&expected.recipient).is_some_and(|r| data[168..200] == r) {
        mismatch.push("recipient");
    }
    if data[280] != 1 {
        mismatch.push("receipt_status");
    }
    // Amount: exact base units of the configured mint's decimals.
    let decimals = match base.account(&expected.mint).await {
        Ok(Some(mint))
            if [SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM].contains(&mint.owner.as_str())
                && mint.data.len() >= 45 =>
        {
            mint.data[44]
        }
        Ok(_) => {
            mismatch.push("mint");
            0
        }
        Err(()) => return Verification::Unavailable,
    };
    let receipt_amount = u64::from_le_bytes(data[200..208].try_into().expect("8 bytes"));
    let want = base_units(expected.amount_cents, decimals);
    if want != Some(receipt_amount) {
        mismatch.push("amount");
    }
    // Payer: the mandate the receipt names belongs to the card owner.
    match base.account(&expected.mandate).await {
        Ok(Some(m)) => {
            if m.owner != expected.chainpay_program
                || m.data.len() < 72
                || m.data[..8] != MANDATE_DISCRIMINATOR
                || !key_bytes(&expected.owner).is_some_and(|o| m.data[8..40] == o)
            {
                mismatch.push("payer");
            }
        }
        Ok(None) => mismatch.push("payer"),
        Err(()) => return Verification::Unavailable,
    }
    mismatch.sort();
    mismatch.dedup();
    if !mismatch.is_empty() {
        return Verification::Mismatch(mismatch);
    }
    // Existing settlement verifier, same account, same expectations.
    let record = crate::status::PaymentRecord {
        payment_id: String::new(),
        idempotency_key: String::new(),
        mandate: expected.mandate.clone(),
        invoice_hash: program::hex(&expected.digest),
        receipt_address: Some(expected.receipt.clone()),
        agent: None,
        mint: Some(expected.mint.clone()),
        recipient: Some(expected.recipient.clone()),
        amount: want,
        token_program: None,
        signing_mode: crate::status::SigningMode::Human,
        signature: None,
        slot: None,
        status: crate::status::PaymentStatus::Confirmed,
        error: None,
        created_at_ms: 0,
        updated_at_ms: 0,
    };
    let account = crate::rpc::RpcAccount {
        owner: receipt.owner.clone(),
        data: receipt.data.clone(),
    };
    if crate::server::verify_receipt_account(&account, &record, &expected.chainpay_program).is_err()
    {
        return Verification::Mismatch(vec!["receipt"]);
    }
    Verification::Verified {
        amount_base_units: receipt_amount,
        decimals,
        executed_at_slot: u64::from_le_bytes(data[240..248].try_into().expect("8 bytes")),
    }
}

/// Base-layer reads at finalized commitment, attached by the server.
#[derive(Clone)]
pub struct BaseChain {
    pub rpc: crate::rpc::RpcClient,
    pub chainpay_program: String,
    pub cluster: &'static str,
}

impl std::fmt::Debug for BaseChain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BaseChain")
    }
}

impl BaseChain {
    pub async fn account(&self, address: &str) -> Result<Option<crate::rpc::RpcAccount>, ()> {
        self.rpc
            .account_info_committed(address, "finalized")
            .await
            .map_err(|_| ())
    }
}

fn push_history(record: &mut Value, state: &str, extra: Value) {
    let mut entry = json!({"state": state, "at": rfc3339(now_ms())});
    if let (Some(e), Some(x)) = (entry.as_object_mut(), extra.as_object()) {
        for (k, v) in x {
            e.insert(k.clone(), v.clone());
        }
    }
    let mut history = record["history"].as_array().cloned().unwrap_or_default();
    history.push(entry);
    history.truncate(64);
    record["history"] = json!(history);
}

/// Compare-and-swap a statement through one state-machine event.
pub(super) async fn apply_event(
    cards: &CardsConnector,
    key: &str,
    event: StatementEvent,
    mut f: impl FnMut(&mut Value),
) -> Result<Option<StoredCardRecord>, CardsError> {
    for _ in 0..5 {
        let Some(row) = cards
            .store
            .get_card_record(CardKind::CardStatements, key)
            .await?
        else {
            return Ok(None);
        };
        let from = row.record["state"].as_str().unwrap_or("").to_owned();
        let Some(to) = transition(&from, event) else {
            return Ok(None);
        };
        let mut record = row.record.clone();
        record["state"] = json!(to);
        f(&mut record);
        push_history(&mut record, to, json!({}));
        match cards
            .store
            .put_card_record(
                CardKind::CardStatements,
                key,
                row.index.clone(),
                record,
                Some(row.rev()),
                updated_now(),
            )
            .await?
        {
            CardPut::Written(row) => return Ok(Some(row)),
            CardPut::Conflict(_) => continue,
        }
    }
    Err(CardsError::internal())
}

fn expected_for(
    cards: &CardsConnector,
    base: &BaseChain,
    card: &StoredCardRecord,
    statement: &StoredCardRecord,
    receipt: &str,
    mandate: &str,
    cluster: &str,
) -> Result<ExpectedRepayment, CardsError> {
    let cfg = &cards.config.repayment;
    let recipient = cfg.partner_token_account.clone().ok_or_else(|| {
        CardsError::unavailable(
            "repayment_unconfigured",
            "Statement repayment has no partner account configured on this deployment",
        )
    })?;
    let digest = statement.record["digest"]
        .as_str()
        .and_then(program::unhex::<32>)
        .ok_or_else(CardsError::internal)?;
    Ok(ExpectedRepayment {
        cluster: cluster.to_owned(),
        chainpay_program: base.chainpay_program.clone(),
        mandate: mandate.to_owned(),
        receipt: receipt.to_owned(),
        digest,
        owner: card.index.owner.clone().unwrap_or_default(),
        mint: cfg.mint.clone(),
        recipient,
        amount_cents: parse_cents(statement.record["amountDueCents"].as_str().unwrap_or(""))
            .ok_or_else(CardsError::internal)?,
    })
}

/// `POST /v1/cards/{cardId}/statements/{statementId}/repayment` (owner).
/// Verifies an existing receipt; never pays by itself.
pub async fn submit_repayment(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    statement_id: &str,
    body: RepaymentRequest,
) -> Result<Value, CardsError> {
    let card = owned_card(cards, caller, card_id).await?;
    if body
        .method
        .as_deref()
        .is_some_and(|m| m != "chainpay_execute_payment")
    {
        return Err(CardsError::bad(
            "invalid_body",
            "Request body does not match the contract schema",
        ));
    }
    if !is_address(&body.receipt_pda) || !is_address(&body.mandate_pda) {
        return Err(CardsError::bad(
            "invalid_body",
            "receiptPda and mandatePda must be Solana addresses",
        ));
    }
    let base = cards
        .base()
        .ok_or_else(|| CardsError::unavailable("rpc_unavailable", "Solana RPC is not attached"))?;
    let row = statement_row(cards, card_id, statement_id).await?;
    let state = row.record["state"].as_str().unwrap_or("").to_owned();
    let amount_due = parse_cents(row.record["amountDueCents"].as_str().unwrap_or("0")).unwrap_or(0);
    if amount_due == 0 {
        return Err(CardsError::conflict(
            "nothing_due",
            "This statement has nothing to repay",
        ));
    }
    match state.as_str() {
        "closed" | "repayment_mismatch" => {}
        "repayment_observed" | "partner_confirmed" | "discharged" => {
            if row.record["repayment"]["receiptPda"] != body.receipt_pda.as_str() {
                return Err(CardsError::conflict(
                    "already_repaid",
                    "This statement already has a verified repayment",
                ));
            }
            let row = advance(cards, &card, &row).await?;
            return Ok(
                json!({"state": row.record["state"], "statement": statement_view(cards, &row)}),
            );
        }
        _ => {
            return Err(CardsError::conflict(
                "statement_state",
                "This statement cannot take a repayment",
            ));
        }
    }
    let expected = expected_for(
        cards,
        &base,
        &card,
        &row,
        &body.receipt_pda,
        &body.mandate_pda,
        &body.cluster,
    )?;
    let checked_at = rfc3339(now_ms());
    match verify_receipt(&base, &expected).await {
        Verification::Verified {
            amount_base_units,
            decimals,
            executed_at_slot,
        } => {
            let repayment = json!({
                "receiptPda": body.receipt_pda,
                "mandatePda": body.mandate_pda,
                "cluster": "devnet",
                "mint": expected.mint,
                "recipient": expected.recipient,
                "amountBaseUnits": amount_base_units.to_string(),
                "decimals": decimals,
                "executedAtSlot": executed_at_slot.to_string(),
                "verifiedAt": checked_at,
                "commitment": "finalized",
                "mismatch": [],
            });
            let updated = apply_event(cards, &row.key, StatementEvent::ReceiptVerified, |record| {
                record["repayment"] = repayment.clone();
            })
            .await?
            .ok_or_else(|| {
                CardsError::conflict("statement_state", "The statement changed; reload it")
            })?;
            super::card_log!("statement {} repayment verified", log_id(&row.key));
            let updated = advance(cards, &card, &updated).await?;
            Ok(
                json!({"state": updated.record["state"], "statement": statement_view(cards, &updated)}),
            )
        }
        Verification::Mismatch(fields) => {
            cards.metrics.count("repayment_discrepancies");
            let attempt = json!({"receiptPda": body.receipt_pda, "mandatePda": body.mandate_pda, "checkedAt": checked_at, "mismatch": fields});
            let updated = apply_event(cards, &row.key, StatementEvent::ReceiptMismatch, |record| {
                record["repayment"] = attempt.clone();
            })
            .await?
            .ok_or_else(|| {
                CardsError::conflict("statement_state", "The statement changed; reload it")
            })?;
            super::card_log!(
                "statement {} repayment mismatch {:?}",
                log_id(&row.key),
                fields
            );
            Ok(
                json!({"state": "repayment_mismatch", "mismatch": fields, "statement": statement_view(cards, &updated)}),
            )
        }
        Verification::NotFound => Err(CardsError::conflict(
            "receipt_not_finalized",
            "No finalized ChainPay receipt exists at receiptPda yet; retry after the payment finalizes",
        )),
        Verification::Unavailable => Err(CardsError::unavailable(
            "rpc_unavailable",
            "Solana RPC is unavailable; retry",
        )),
    }
}

/// Push a verified statement forward: simulated partner confirmation, then
/// `record_repayment` on PER, then `discharged`. Safe to call repeatedly.
pub async fn advance(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    row: &StoredCardRecord,
) -> Result<StoredCardRecord, CardsError> {
    let mut row = row.clone();
    if row.record["state"] == "repayment_observed" {
        if let Some(next) = partner_confirm(cards, card, &row).await? {
            row = next;
        }
    }
    if row.record["state"] == "partner_confirmed" {
        if let Some(next) = discharge(cards, card, &row).await? {
            row = next;
        }
    }
    Ok(row)
}

/// **Simulated** partner ledger (labelled everywhere). It stands in for the
/// credit partner's own books: it independently re-reads the receipt at
/// finalized commitment, checks that the funds reached its token account for
/// this digest and amount, and books the digest once (create-only), so one
/// payment can never settle two statements.
pub async fn partner_confirm(
    cards: &CardsConnector,
    card: &StoredCardRecord,
    row: &StoredCardRecord,
) -> Result<Option<StoredCardRecord>, CardsError> {
    let Some(base) = cards.base() else {
        return Ok(None);
    };
    let private = row.record["repayment"]["method"] == super::private_repay::METHOD;
    // Evidence the partner books against: the receipt PDA (transparent) or
    // the settlement signatures it re-read itself (private).
    let evidence = if private {
        let Some(signatures) = super::private_repay::partner_reverify(cards, row).await? else {
            return Ok(None);
        };
        super::private_repay::ledger_evidence(cards, &signatures)
    } else {
        let receipt = row.record["repayment"]["receiptPda"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let mandate = row.record["repayment"]["mandatePda"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let expected = expected_for(cards, &base, card, row, &receipt, &mandate, "devnet")?;
        let Verification::Verified { .. } = verify_receipt(&base, &expected).await else {
            cards.metrics.count("repayment_discrepancies");
            return Ok(None);
        };
        receipt
    };
    let receipt = evidence;
    let digest = row.record["digest"].as_str().unwrap_or("").to_owned();
    let key = format!("partner:{digest}");
    let at = rfc3339(now_ms());
    let partner_ref = format!("sim-partner-{}", &digest[..16]);
    let entry = json!({
        "v": 1,
        "type": "partner_ledger_entry",
        "simulated": true,
        "label": PARTNER_LABEL,
        "cardId": row.record["cardId"],
        "statementKey": row.key,
        "digest": digest,
        "amountCents": row.record["amountDueCents"],
        "receiptPda": if private { Value::Null } else { json!(receipt) },
        "evidence": receipt,
        "method": if private { super::private_repay::METHOD } else { "chainpay_execute_payment" },
        "confirmedAt": at,
        "ref": partner_ref,
    });
    let index = CardIndex {
        owner: card.index.owner.clone(),
        connector: Some(CONNECTOR.into()),
        reference: Some(format!(
            "partner:{}",
            row.record["cardId"].as_str().unwrap_or("")
        )),
        idempotency: None,
    };
    let booked = match cards
        .store
        .put_card_record(
            CardKind::CardStatements,
            &key,
            index,
            entry,
            None,
            updated_now(),
        )
        .await?
    {
        CardPut::Written(entry) => entry,
        CardPut::Conflict(Some(existing)) => existing,
        CardPut::Conflict(None) => return Err(CardsError::internal()),
    };
    if booked.record["statementKey"] != row.key.as_str()
        || booked.record["amountCents"] != row.record["amountDueCents"]
        || booked.record["evidence"]
            .as_str()
            .or(booked.record["receiptPda"].as_str())
            != Some(receipt.as_str())
    {
        cards.metrics.count("repayment_discrepancies");
        return Ok(None);
    }
    let partner = json!({"simulated": true, "label": PARTNER_LABEL, "confirmedAt": booked.record["confirmedAt"], "ref": booked.record["ref"]});
    apply_event(
        cards,
        &row.key,
        StatementEvent::PartnerConfirmed,
        |record| {
            record["partner"] = partner.clone();
        },
    )
    .await
}

/// Credit exposure this statement still accounts for on PER:
/// `min(max(total, 0), outstanding − max(0, net of every posting after its cut))`.
/// Equal to the statement total in the normal case; smaller only when a later
/// credit (refund) already reduced the exposure, or the program's clamp at
/// zero absorbed it. Never more than the statement's own total, so a missing
/// posting can never make `record_repayment` erase debt that belongs to a
/// later statement.
pub fn exposure_to_clear(total: i128, outstanding: u64, net_after_cut: i128) -> u64 {
    if total <= 0 {
        return 0;
    }
    let room = outstanding as i128 - net_after_cut.max(0);
    total.min(room).max(0) as u64
}

async fn net_after(
    cards: &CardsConnector,
    card: &StoredCardRecord,
    seq: u64,
) -> Result<i128, CardsError> {
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let owner = card.index.owner.clone().unwrap_or_default();
    let fallback = current_fee_bps(cards, card).await.unwrap_or(0);
    let mut net: i128 = postings_under(cards, &owner, &open_reference(card_id))
        .await?
        .iter()
        .filter_map(|row| line_from_posting(cards, row, fallback).map(|(l, _)| l.signed_total()))
        .sum();
    let statements = cards
        .store
        .list_card_records_for_owner(
            CardKind::CardStatements,
            &owner,
            CONNECTOR,
            card_id,
            None,
            200,
        )
        .await?;
    // Later statements still owed. A discharged one already had its exposure
    // cleared (or, for a credit, already netted by the program at refund time).
    for later in statements.iter().filter(|s| {
        s.record["type"] == "statement"
            && s.record["statementSeq"].as_u64().unwrap_or(0) > seq
            && s.record["state"] != "discharged"
    }) {
        let lines: Vec<Value> = cards
            .crypto
            .open_json(
                CardKind::CardStatements.as_str(),
                &later.key,
                &later.record["lines"],
            )
            .map_err(|_| CardsError::internal())?;
        net += lines
            .iter()
            .filter_map(Line::from_json)
            .map(|l| l.signed_total())
            .sum::<i128>();
    }
    Ok(net)
}

async fn save_plan(
    cards: &CardsConnector,
    row: &StoredCardRecord,
    amount: u64,
) -> Result<(), CardsError> {
    let mut record = row.record.clone();
    record["dischargePlan"] = json!({"amountCents": cents(amount), "at": rfc3339(now_ms())});
    match cards
        .store
        .put_card_record(
            CardKind::CardStatements,
            &row.key,
            row.index.clone(),
            record,
            Some(row.rev()),
            updated_now(),
        )
        .await?
    {
        CardPut::Written(_) => Ok(()),
        // Someone else planned or moved it: let the next pass re-read.
        CardPut::Conflict(_) => Err(CardsError::unavailable(
            "statement_busy",
            "The statement is being updated; retry",
        )),
    }
}

async fn discharge(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    row: &StoredCardRecord,
) -> Result<Option<StoredCardRecord>, CardsError> {
    let (policy_pda, period_pda) = card_pdas(card)?;
    let digest = row.record["digest"]
        .as_str()
        .and_then(program::unhex::<32>)
        .ok_or_else(CardsError::internal)?;
    let policy = match cards.per.read(&policy_pda, Duration::from_secs(5)).await {
        TeeRead::Visible { data, .. } => {
            program::decode_policy(&data).map_err(|_| CardsError::internal())?
        }
        _ => {
            super::card_log!(
                "stale_per_read card {}",
                log_id(card.record["cardId"].as_str().unwrap_or(""))
            );
            cards.metrics.count("stale_per_reads");
            return Ok(None);
        }
    };
    let total = parse_signed(&row.record["totalCents"]);
    let seq = row.record["statementSeq"].as_u64().unwrap_or(0);
    // The amount is fixed once, before the first submit, so a retry after an
    // unknown outcome records (and later reports) exactly the same number.
    let planned = row.record["dischargePlan"]["amountCents"]
        .as_str()
        .and_then(parse_cents);
    let mut on_chain = json!({"amountCents": planned.map(cents)});
    if !policy.repayment_recorded(&digest) {
        let amount = match planned {
            Some(amount) => amount,
            None => {
                let amount = exposure_to_clear(
                    total,
                    policy.statement_outstanding_cents,
                    net_after(cards, card, seq).await?,
                );
                save_plan(cards, row, amount).await?;
                amount
            }
        };
        if amount > 0 {
            let outcome = cards
                .per
                .submit(
                    vec![program::record_repayment(
                        &cards.authorizer(),
                        &policy_pda,
                        &period_pda,
                        &digest,
                        amount,
                    )],
                    Instant::now() + Duration::from_secs(8),
                )
                .await;
            match &outcome {
                TxOutcome::Confirmed { signature } => {
                    on_chain =
                        json!({"recordRepaymentTx": signature, "amountCents": cents(amount)});
                }
                TxOutcome::ProgramError { code, .. }
                    if program::error_name(*code) == Some("DuplicateRepayment") => {}
                TxOutcome::ProgramError { code, .. } => {
                    cards.metrics.count("repayment_discrepancies");
                    super::card_log!(
                        "record_repayment refused for {}: {}",
                        log_id(&row.key),
                        program::error_name(*code).unwrap_or("unknown")
                    );
                    return Ok(None);
                }
                _ => return Ok(None),
            }
            // Discharged only once PER shows the digest booked.
            let observed = match cards.per.read(&policy_pda, Duration::from_secs(5)).await {
                TeeRead::Visible { data, .. } => {
                    program::decode_policy(&data).is_ok_and(|p| p.repayment_recorded(&digest))
                }
                _ => false,
            };
            if !observed {
                return Ok(None);
            }
        } else {
            on_chain = json!({"amountCents": "0", "note": "exposure already cleared on PER"});
        }
    }
    let updated = apply_event(
        cards,
        &row.key,
        StatementEvent::RepaymentRecorded,
        |record| {
            record["discharge"] = on_chain.clone();
        },
    )
    .await?;
    if updated.is_some() {
        super::card_log!("statement {} discharged", log_id(&row.key));
        cards.metrics.count("statements_discharged");
        if let Ok(Some(fresh)) = cards
            .card(card.record["cardId"].as_str().unwrap_or(""))
            .await
        {
            let _ = super::routes::checkpoint(cards, &fresh).await;
            let _ = super::reconcile::snapshot(cards, &fresh).await;
        }
    }
    Ok(updated)
}

async fn advance_pending(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
) -> Result<(), CardsError> {
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let owner = card.index.owner.clone().unwrap_or_default();
    let rows = cards
        .store
        .list_card_records_for_owner(
            CardKind::CardStatements,
            &owner,
            CONNECTOR,
            card_id,
            None,
            50,
        )
        .await?;
    for row in rows.iter().filter(|r| {
        r.record["type"] == "statement"
            && matches!(
                r.record["state"].as_str(),
                Some("repayment_observed" | "partner_confirmed")
            )
    }) {
        let _ = advance(cards, card, row).await;
    }
    super::private_repay::advance_open_attempts(cards, card, &rows).await;
    Ok(())
}

/// Write any posting a crash skipped: single-message captures are booked by
/// `authorize` itself, so their posting is written after the ASA reply.
pub async fn backfill_postings(cards: &CardsConnector, card: &StoredCardRecord) {
    let owner = card.index.owner.clone().unwrap_or_default();
    let card_id = card.record["cardId"].as_str().unwrap_or_default();
    let Ok(rows) = cards
        .store
        .list_card_records_for_owner(CardKind::CardEvents, &owner, CONNECTOR, card_id, None, PAGE)
        .await
    else {
        return;
    };
    for row in rows
        .iter()
        .filter(|r| r.record["type"] == "transaction" && r.record["singleMessage"] == true)
    {
        let Some(token) = row.key.strip_prefix("asa:") else {
            continue;
        };
        let amount = parse_cents(row.record["capturedCents"].as_str().unwrap_or("0")).unwrap_or(0);
        if amount == 0 {
            continue;
        }
        let id = program::auth_id_hash(cards.config.issuer_code, token);
        let display = super::merchant_display(cards, row);
        record_posting(cards, card, &id, "single_message", amount, &display).await;
    }
}

#[cfg(test)]
mod unit {
    use super::*;

    fn line(kind: PostingKind, amount: u64, bps: u16, at: &str) -> Line {
        Line {
            event_id: format!("{:064x}", amount),
            kind,
            amount,
            fee: fee_cents(amount, bps),
            posted_at: at.into(),
            display_name: "Data API credits".into(),
            exception: None,
        }
    }

    #[test]
    fn fee_is_the_program_floor_rule() {
        assert_eq!(fee_cents(50_000, 50), 250);
        assert_eq!(fee_cents(1, 50), 0);
        assert_eq!(fee_cents(199, 50), 0);
        assert_eq!(fee_cents(200, 50), 1);
        assert_eq!(fee_cents(201, 50), 1);
        assert_eq!(fee_cents(1_500, 50), 7);
        assert_eq!(fee_cents(0, 50), 0);
        assert_eq!(fee_cents(12_345, 0), 0);
        assert_eq!(fee_cents(u64::MAX, 1_000), u64::MAX / 10);
    }

    /// The vectors the program and the SDK run too (review X6).
    #[test]
    fn shared_fee_vectors_hold() {
        let v: Value =
            serde_json::from_str(include_str!("../../../../shared/cards/fee-vectors.json"))
                .unwrap();
        let n = |x: &Value| x.as_str().unwrap().parse::<u64>().unwrap();
        for case in v["fee"].as_array().unwrap() {
            let bps = case["feeBps"].as_u64().unwrap() as u16;
            assert_eq!(
                fee_cents(n(&case["amountCents"]), bps),
                n(&case["feeCents"]),
                "{case}"
            );
        }
        for case in v["statements"].as_array().unwrap() {
            let bps = case["feeBps"].as_u64().unwrap() as u16;
            let lines: Vec<Line> = case["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| {
                    let kind = if l[0] == "purchase" {
                        PostingKind::Purchase
                    } else {
                        PostingKind::Refund
                    };
                    line(kind, n(&l[1]), bps, "2026-10-04T00:00:00.000Z")
                })
                .collect();
            let t = totals(&lines, 0);
            assert_eq!(
                t.fees.to_string(),
                case["feeCents"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                t.total.to_string(),
                case["totalCents"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
        for case in v["holds"].as_array().unwrap() {
            let bps = case["feeBps"].as_u64().unwrap() as u16;
            let captured = n(&case["capturedCents"]);
            let mut refunded = 0;
            let mut lines = vec![line(
                PostingKind::Purchase,
                captured,
                bps,
                "2026-10-04T00:00:00.000Z",
            )];
            for refund in case["refunds"].as_array().unwrap() {
                // Axum's cap for a closed hold: never past what it captured.
                if let Some(amount) =
                    super::super::events::refundable(captured, refunded, n(refund))
                {
                    refunded += amount;
                    lines.push(line(
                        PostingKind::Refund,
                        amount,
                        bps,
                        "2026-10-04T00:00:01.000Z",
                    ));
                }
            }
            assert_eq!(
                totals(&lines, 0).total.to_string(),
                case["outstandingCents"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn totals_are_exact_integers_with_per_line_fees() {
        // The live connector run: $15 + $10 captured, $5 returned, 50 bps.
        let lines = vec![
            line(PostingKind::Purchase, 1_500, 50, "2026-10-04T00:00:01.000Z"),
            line(PostingKind::Purchase, 1_000, 50, "2026-10-04T00:00:02.000Z"),
            line(PostingKind::Refund, 500, 50, "2026-10-04T00:00:03.000Z"),
        ];
        let t = totals(&lines, 0);
        assert_eq!(
            (t.purchases, t.refunds, t.fees, t.total),
            (2_500, 500, 10, 2_010)
        );
        assert_eq!((t.amount_due, t.credit_forward), (2_010, 0));
        // Per-line floors: never more than the fee of the sum.
        let pennies: Vec<Line> = (0..3)
            .map(|i| {
                line(
                    PostingKind::Purchase,
                    1,
                    50,
                    &format!("2026-10-04T00:00:0{i}.000Z"),
                )
            })
            .collect();
        assert_eq!(totals(&pennies, 0).fees, 0);
        assert_eq!(fee_cents(3, 50), 0);
    }

    #[test]
    fn credits_carry_forward_and_never_go_negative_due() {
        let refund_only = vec![line(
            PostingKind::Refund,
            500,
            50,
            "2026-10-04T00:00:00.000Z",
        )];
        let t = totals(&refund_only, 0);
        assert_eq!((t.total, t.amount_due, t.credit_forward), (-502, 0, 502));
        let next = vec![line(
            PostingKind::Purchase,
            2_000,
            50,
            "2026-10-05T00:00:00.000Z",
        )];
        let t = totals(&next, 502);
        assert_eq!((t.total, t.amount_due, t.credit_forward), (2_010, 1_508, 0));
        let t = totals(&[], 502);
        assert_eq!((t.amount_due, t.credit_forward), (0, 502));
    }

    #[test]
    fn digest_binds_every_amount_and_line() {
        let lines = vec![line(
            PostingKind::Purchase,
            2_000,
            50,
            "2026-10-04T00:00:01.000Z",
        )];
        let t = totals(&lines, 0);
        let input = |t: &Totals, digests: Vec<String>, due: &str| {
            statement_digest(&DigestInput {
                card_id: "c",
                statement_seq: 1,
                period_index: 1,
                close_kind: "interim",
                closed_at: "2026-10-04T00:00:02.000Z",
                due_at: due,
                totals: t,
                line_digests: digests,
            })
        };
        let base = input(&t, vec![lines[0].digest()], "2026-10-25T00:00:02.000Z");
        assert_eq!(base.len(), 64);
        assert_eq!(
            base,
            input(&t, vec![lines[0].digest()], "2026-10-25T00:00:02.000Z")
        );
        assert_ne!(
            base,
            input(&t, vec![lines[0].digest()], "2026-10-26T00:00:02.000Z")
        );
        let mut other = t.clone();
        other.amount_due += 1;
        assert_ne!(
            base,
            input(&other, vec![lines[0].digest()], "2026-10-25T00:00:02.000Z")
        );
        let mut changed = lines[0].clone();
        changed.amount += 1;
        assert_ne!(
            base,
            input(&t, vec![changed.digest()], "2026-10-25T00:00:02.000Z")
        );
        // Domain separated from the PayPal invoice binding and the line digest.
        assert_ne!(
            canonical_hash("chainpay-card-statement:v1\n", &json!({})),
            canonical_hash("chainpay:paypal-invoice-binding:v1\n", &json!({}))
        );
    }

    #[test]
    fn usdc_base_units_are_exact() {
        assert_eq!(base_units(2_010, 6), Some(20_100_000));
        assert_eq!(base_units(1, 2), Some(1));
        assert_eq!(base_units(1, 1), None);
        assert_eq!(base_units(u64::MAX, 6), None);
    }

    #[test]
    fn only_the_contract_transitions_exist() {
        use StatementEvent::*;
        assert_eq!(
            transition("closed", ReceiptVerified),
            Some("repayment_observed")
        );
        assert_eq!(
            transition("closed", ReceiptMismatch),
            Some("repayment_mismatch")
        );
        assert_eq!(
            transition("repayment_mismatch", ReceiptVerified),
            Some("repayment_observed")
        );
        assert_eq!(
            transition("repayment_observed", PartnerConfirmed),
            Some("partner_confirmed")
        );
        assert_eq!(
            transition("partner_confirmed", RepaymentRecorded),
            Some("discharged")
        );
        // No shortcut to discharged, and a mismatch never moves a verified statement.
        for from in [
            "closed",
            "repayment_mismatch",
            "repayment_observed",
            "discharged",
        ] {
            assert_eq!(transition(from, RepaymentRecorded), None, "{from}");
        }
        assert_eq!(transition("closed", PartnerConfirmed), None);
        assert_eq!(transition("repayment_mismatch", PartnerConfirmed), None);
        assert_eq!(transition("repayment_observed", ReceiptMismatch), None);
        assert_eq!(transition("discharged", ReceiptVerified), None);
        assert_eq!(transition("partner_confirmed", NothingDue), None);
    }

    #[test]
    fn exposure_cleared_never_exceeds_the_statement() {
        // Normal: exposure = this statement + later purchases.
        assert_eq!(exposure_to_clear(2_010, 2_010 + 700, 700), 2_010);
        // A later refund already reduced exposure.
        assert_eq!(exposure_to_clear(2_010, 2_010 - 503, -503), 1_507);
        // A later purchase not yet posted: never clear more than the total.
        assert_eq!(exposure_to_clear(2_010, 2_010 + 900, 0), 2_010);
        // Exposure already zero (clamped credit) or a credit statement.
        assert_eq!(exposure_to_clear(2_010, 0, 0), 0);
        assert_eq!(exposure_to_clear(-503, 900, 900), 0);
    }

    #[test]
    fn rfc3339_round_trips() {
        for ms in [0u64, 1_759_536_000_123, 951_782_400_000, 1_791_072_000_999] {
            assert_eq!(parse_rfc3339_ms(&rfc3339(ms)), Some(ms));
        }
        assert_eq!(parse_rfc3339_ms("nope"), None);
    }
}
