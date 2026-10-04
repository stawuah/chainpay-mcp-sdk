//! Private statement repayment through MagicBlock Private Payments
//! (Ephemeral SPL Token, hosted API `payments.magicblock.app`), Devnet USDC
//! only (contracts.md §7.3, PLAN workstream E).
//!
//! **Model (shown to the owner before they opt in).** The owner's tokens move
//! out of their wallet into MagicBlock's per-mint Global Vault (a deposit that
//! credits their private balance on the TEE rollup). The payment itself is a
//! private transfer inside the rollup; MagicBlock's transfer queue then pays
//! the simulated partner's ordinary token account **from the vault**, tagged
//! with a `clientRefId`. This differs from ChainPay's usual model, where tokens
//! stay in the owner's account until a mandate-approved payment.
//!
//! **What ChainPay verifies (all at finalized commitment on Solana Devnet):**
//! a settlement transaction in which the Ephemeral SPL Token program ran
//! `ExecuteReadyQueuedTransfer`, logged our `clientRefId`, and moved exactly
//! the amount due of the configured mint from the program's vault PDA (derived
//! here, never trusted from input) to the configured partner token account.
//! Only that program can sign for its vault PDA, so the transfer and the log
//! line come from the program, not from a third party.
//!
//! **What it cannot verify:** who paid. The vault breaks the on-chain link
//! between the owner's deposit and the partner's credit, which is the point of
//! the method, so the transparent path's "payer = card owner" check has no
//! private equivalent. Anyone who knows the `clientRefId` could pay the
//! statement on the owner's behalf. The amount and the partner's credit are
//! public at settlement; only the sender link is hidden, and amount/timing
//! correlation can still re-link them (MagicBlock says the same).
//!
//! The discharge rule is unchanged: verified settlement, then the labelled
//! simulated partner ledger re-reads it and books the digest once, then
//! `record_repayment` on PER.

use super::routes::{Caller, CardsError, owned_card};
use super::statements::{
    self, BaseChain, StatementEvent, apply_event, statement_row, statement_view,
};
use super::{CardsConnector, log_id, now_ms, parse_cents, rfc3339, updated_now};
use crate::storage::{CardIndex, CardKind, CardPut, StoredCardRecord};
use serde::Deserialize;
use serde_json::{Value, json};
use solana_address::Address;
use std::sync::Arc;

pub const METHOD: &str = "magicblock_private_payments";
pub const EPHEMERAL_SPL_PROGRAM: &str = "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2";
pub const PAYMENTS_API: &str = "https://payments.magicblock.app";
const SPL_TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const EXECUTE_LOG: &str = "Program log: Instruction: ExecuteReadyQueuedTransfer";
const REF_LOG: &str = "Program log: client_ref_id: ";
/// Signature pages listed per check (100 each) and transactions read per
/// check; the cursor moves forward across checks.
const LIST_PAGES: usize = 20;
const TX_BUDGET: usize = 150;

// ----------------------------------------------------------- derivations

fn addr(value: &str) -> Option<Address> {
    value.parse().ok()
}

/// The Ephemeral SPL Token program's Global Vault PDA for `mint` (seeds
/// `[mint]`) and the vault's token account (the ATA of `(vault, mint)`).
pub fn vault_accounts(mint: &str) -> Option<(String, String)> {
    let mint = addr(mint)?;
    let program = addr(EPHEMERAL_SPL_PROGRAM)?;
    let vault = Address::find_program_address(&[mint.as_ref()], &program).0;
    let token = addr(SPL_TOKEN_PROGRAM)?;
    let ata = addr(ATA_PROGRAM)?;
    let vault_ata =
        Address::find_program_address(&[vault.as_ref(), token.as_ref(), mint.as_ref()], &ata).0;
    Some((vault.to_string(), vault_ata.to_string()))
}

/// Opaque, per-attempt `clientRefId` (a u64 the hosted API accepts as a
/// numeric string). Keyed with the record index key, so nobody without
/// ChainPay's key can link a public settlement to a statement digest, and a
/// new attempt never reuses an old reference. Never zero, at most 12 digits.
pub fn client_ref_id(cards: &CardsConnector, digest: &str, seq: u64) -> String {
    let hex = cards.crypto.blind(
        "private-repayment-ref",
        format!("{digest}\n{seq}").as_bytes(),
    );
    let mut bytes = [0u8; 8];
    for (i, b) in bytes.iter_mut().enumerate() {
        *b = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap_or(0);
    }
    // At most 12 digits (~40 bits): inside every JSON/JS integer path, and
    // never shaped like a 13-19 digit card number, which the plaintext
    // scanners (Convex validator, Rust scanner test) refuse on sight.
    (u64::from_be_bytes(bytes) % 999_999_999_999 + 1).to_string()
}

// ------------------------------------------------------ settlement parsing

/// One queued payout the program executed in a transaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settlement {
    pub client_ref_id: String,
    pub source: String,
    pub destination: String,
    pub authority: String,
    pub mint: String,
    pub amount: u64,
}

/// Invocation structure recovered from the logs. Every `invoke` at stack
/// height ≥ 2 is one inner instruction, in the same order the RPC lists inner
/// instructions; for each we keep the Ephemeral SPL Token frame that invoked
/// it directly (if any). Each such frame records whether it logged
/// `ExecuteReadyQueuedTransfer` and its `client_ref_id`. A log line counts only
/// while that program's own frame is on top of the stack, so a line printed by
/// any other program can never pose as one. `None` = unparseable (truncated or
/// unbalanced logs, a duplicate or malformed reference): never evidence.
struct Frames {
    /// Per execute-capable frame: (is execute, reference).
    frames: Vec<(bool, Option<String>)>,
    /// Per inner instruction (invoke at height ≥ 2): the direct parent frame
    /// index when the parent is the Ephemeral SPL Token program.
    parents: Vec<Option<usize>>,
}

fn parse_frames(logs: &[Value]) -> Option<Frames> {
    // Stack entries: (program, Ephemeral SPL frame index if that program).
    let mut stack: Vec<(String, Option<usize>)> = Vec::new();
    let mut out = Frames {
        frames: Vec::new(),
        parents: Vec::new(),
    };
    for line in logs.iter().filter_map(Value::as_str) {
        if line.starts_with("Log truncated") {
            return None;
        }
        if let Some(rest) = line.strip_prefix("Program ") {
            let mut parts = rest.split(' ');
            let program = parts.next().unwrap_or("");
            match parts.next() {
                Some("invoke") => {
                    if !stack.is_empty() {
                        out.parents.push(stack.last().and_then(|(_, f)| *f));
                    }
                    let frame = (program == EPHEMERAL_SPL_PROGRAM).then(|| {
                        out.frames.push((false, None));
                        out.frames.len() - 1
                    });
                    stack.push((program.to_owned(), frame));
                    continue;
                }
                Some("success") | Some("failed:") => {
                    if stack.last().map(|(p, _)| p.as_str()) != Some(program) {
                        return None;
                    }
                    stack.pop();
                    continue;
                }
                _ => {}
            }
        }
        let Some((_, Some(frame))) = stack.last() else {
            continue;
        };
        let frame = &mut out.frames[*frame];
        if line == EXECUTE_LOG {
            frame.0 = true;
        } else if let Some(value) = line.strip_prefix(REF_LOG) {
            if frame.1.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            frame.1 = Some(value.to_owned());
        }
    }
    if !stack.is_empty() {
        return None;
    }
    Some(out)
}

/// Inner instructions flattened in execution order (groups by index).
fn inner_instructions(tx: &Value) -> Vec<Value> {
    let mut groups: Vec<&Value> = tx["meta"]["innerInstructions"]
        .as_array()
        .map(|g| g.iter().collect())
        .unwrap_or_default();
    groups.sort_by_key(|g| g["index"].as_u64().unwrap_or(u64::MAX));
    groups
        .into_iter()
        .flat_map(|g| g["instructions"].as_array().cloned().unwrap_or_default())
        .collect()
}

/// Every queued payout the program executed in a `getTransaction`
/// (jsonParsed) result, any mint: each `ExecuteReadyQueuedTransfer` frame is
/// paired with the token transfer it invoked itself. A payout counts as a
/// vault payout only when its authority is the vault PDA **derived** for its
/// mint and its source is that vault's token account; anything else is
/// reported with mint `not-vault:…`. `None` when the transaction failed or
/// cannot be attributed unambiguously: such a transaction is never evidence.
pub fn settlements_in(tx: &Value) -> Option<Vec<Settlement>> {
    if !tx["meta"]["err"].is_null() {
        return None;
    }
    let frames = parse_frames(tx["meta"]["logMessages"].as_array()?)?;
    let inner = inner_instructions(tx);
    if inner.len() != frames.parents.len() {
        return None;
    }
    let mut per_frame: Vec<Vec<Settlement>> = vec![Vec::new(); frames.frames.len()];
    for (ix, parent) in inner.iter().zip(&frames.parents) {
        let Some(f) = parent else { continue };
        if ix["programId"] != SPL_TOKEN_PROGRAM {
            continue;
        }
        let kind = ix["parsed"]["type"].as_str().unwrap_or("");
        if kind != "transferChecked" && kind != "transfer" {
            continue;
        }
        let info = &ix["parsed"]["info"];
        let amount = info["tokenAmount"]["amount"]
            .as_str()
            .or(info["amount"].as_str())
            .and_then(|a| a.parse::<u64>().ok())?;
        let mint = info["mint"].as_str().unwrap_or("").to_owned();
        let source = info["source"].as_str().unwrap_or("").to_owned();
        let authority = info["authority"].as_str().unwrap_or("").to_owned();
        let is_vault = vault_accounts(&mint).is_some_and(|(v, va)| v == authority && va == source);
        per_frame[*f].push(Settlement {
            client_ref_id: String::new(),
            destination: info["destination"].as_str().unwrap_or("").to_owned(),
            mint: if is_vault {
                mint
            } else {
                format!("not-vault:{mint}")
            },
            source,
            authority,
            amount,
        });
    }
    let mut out = Vec::new();
    for ((execute, reference), mut transfers) in frames.frames.into_iter().zip(per_frame) {
        if !execute {
            continue;
        }
        // One execute frame = exactly one reference and one payout.
        let (Some(reference), 1) = (reference, transfers.len()) else {
            return None;
        };
        let mut t = transfers.pop()?;
        t.client_ref_id = reference;
        out.push(t);
    }
    Some(out)
}

/// Pick the payout that settles the statement. Exactly one payout tagged with
/// the reference must pay the exact amount, in the configured mint, from the
/// vault, to the partner: that one is the settlement (the method pins
/// `split: 1`). Extra payouts with the same reference (the reference becomes
/// public at settlement, so anyone can add some) never undo it. Without such a
/// payout, the mismatch fields describe what did arrive.
pub fn check(
    found: &[(String, Settlement)],
    expected_amount: u64,
    mint: &str,
    partner_account: &str,
) -> Result<(String, u64), Vec<&'static str>> {
    if let Some((sig, s)) = found.iter().find(|(_, s)| {
        s.mint == mint && s.destination == partner_account && s.amount == expected_amount
    }) {
        return Ok((sig.clone(), s.amount));
    }
    let mut mismatch = Vec::new();
    for (_, s) in found {
        if s.mint != mint {
            mismatch.push("mint");
        }
        if s.destination != partner_account {
            mismatch.push("recipient");
        }
        if s.amount != expected_amount {
            mismatch.push("amount");
        }
    }
    if mismatch.is_empty() {
        mismatch.push("amount");
    }
    mismatch.sort();
    mismatch.dedup();
    Err(mismatch)
}

// --------------------------------------------------------------- RPC reads

async fn rpc(base: &BaseChain, method: &str, params: Value) -> Result<Value, ()> {
    let response = base
        .rpc
        .forward_proxy(crate::api::JsonRpcProxyRequest {
            jsonrpc: "2.0".into(),
            id: json!(1),
            method: method.into(),
            params: Some(params),
        })
        .await
        .map_err(|_| ())?;
    Ok(response["result"].clone())
}

async fn newest_signature(base: &BaseChain, account: &str) -> Result<Option<String>, ()> {
    let page = rpc(
        base,
        "getSignaturesForAddress",
        json!([account, {"limit": 1, "commitment": "finalized"}]),
    )
    .await?;
    Ok(page
        .as_array()
        .and_then(|p| p.first())
        .and_then(|s| s["signature"].as_str())
        .map(str::to_owned))
}

pub async fn transaction(base: &BaseChain, signature: &str) -> Result<Option<Value>, ()> {
    let tx = rpc(
        base,
        "getTransaction",
        json!([signature, {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 0}]),
    )
    .await?;
    Ok((!tx.is_null()).then_some(tx))
}

pub enum Scan {
    /// `(signature, payout)` for every payout tagged with the reference.
    Found(Vec<(String, Settlement)>, u64),
    /// Nothing yet. `advance` = newest signature checked in full, so the next
    /// pass starts after it (the cursor only ever moves forward over history
    /// that held no payout for this reference).
    Pending {
        advance: Option<String>,
    },
    Unavailable,
}

/// Look through the partner account's finalized history newer than `cursor`
/// for payouts tagged `reference`, oldest first. Bounded per pass
/// (`LIST_PAGES` × 100 signatures listed, `TX_BUDGET` transactions read);
/// a busy account is worked through over several passes via `advance`.
pub async fn scan(
    base: &BaseChain,
    partner_account: &str,
    cursor: Option<&str>,
    reference: &str,
) -> Scan {
    let mut before: Option<String> = None;
    let mut signatures: Vec<(String, u64, bool)> = Vec::new();
    for _ in 0..LIST_PAGES {
        let mut opts = json!({"limit": 100, "commitment": "finalized"});
        if let Some(c) = cursor {
            opts["until"] = json!(c);
        }
        if let Some(b) = &before {
            opts["before"] = json!(b);
        }
        let Ok(page) = rpc(
            base,
            "getSignaturesForAddress",
            json!([partner_account, opts]),
        )
        .await
        else {
            return Scan::Unavailable;
        };
        let Some(page) = page.as_array() else {
            return Scan::Unavailable;
        };
        for s in page {
            if let Some(sig) = s["signature"].as_str() {
                signatures.push((
                    sig.to_owned(),
                    s["slot"].as_u64().unwrap_or(0),
                    s["err"].is_null(),
                ));
            }
        }
        if page.len() < 100 {
            break;
        }
        before = page
            .last()
            .and_then(|s| s["signature"].as_str())
            .map(str::to_owned);
    }
    let mut found = Vec::new();
    let mut slot = 0;
    let mut advance = None;
    let mut read = 0;
    for (signature, sig_slot, ok) in signatures.iter().rev() {
        if *ok {
            if read >= TX_BUDGET {
                break;
            }
            read += 1;
            let tx = match transaction(base, signature).await {
                Ok(Some(tx)) => tx,
                // Listed as finalized but not served yet: stop here, retry later.
                Ok(None) => break,
                Err(()) => return Scan::Unavailable,
            };
            for s in settlements_in(&tx).unwrap_or_default() {
                if s.client_ref_id == reference {
                    slot = slot.max(*sig_slot);
                    found.push((signature.clone(), s));
                }
            }
        }
        advance = Some(signature.clone());
    }
    if found.is_empty() {
        Scan::Pending { advance }
    } else {
        Scan::Found(found, slot)
    }
}

/// Re-read recorded settlement signatures directly (partner ledger path).
pub async fn reread(
    base: &BaseChain,
    signatures: &[String],
    reference: &str,
) -> Result<Vec<(String, Settlement)>, ()> {
    let mut found = Vec::new();
    for signature in signatures {
        let Some(tx) = transaction(base, signature).await? else {
            return Err(());
        };
        for s in settlements_in(&tx).ok_or(())? {
            if s.client_ref_id == reference {
                found.push((signature.clone(), s));
            }
        }
    }
    Ok(found)
}

// ------------------------------------------------------------------ routes

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PrepareRequest {
    pub client_operation_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SubmitRequest {
    pub method: String,
    pub attempt_id: String,
    pub cluster: String,
}

fn partner_account(cards: &CardsConnector) -> Result<String, CardsError> {
    cards
        .config
        .repayment
        .partner_token_account
        .clone()
        .ok_or_else(|| {
            CardsError::unavailable(
                "repayment_unconfigured",
                "Statement repayment has no partner account configured on this deployment",
            )
        })
}

fn attempts(record: &Value) -> Vec<Value> {
    record["privateRepayment"]["attempts"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

/// The private half of an attempt (reference, history cursor, settlement
/// signatures) is sealed in Convex like any other 🔒 field: a reader of the
/// operator's database must not be able to link the owner to the public
/// payout, which is exactly the link this method keeps off the chain.
fn secret_key(row_key: &str, part: &str) -> String {
    format!("{row_key}#private:{part}")
}

fn seal(cards: &CardsConnector, row_key: &str, part: &str, value: &Value) -> Value {
    cards.crypto.seal_json(
        CardKind::CardStatements.as_str(),
        &secret_key(row_key, part),
        value,
    )
}

fn open(cards: &CardsConnector, row_key: &str, part: &str, envelope: &Value) -> Value {
    if envelope.is_null() {
        return json!({});
    }
    cards
        .crypto
        .open_json::<Value>(
            CardKind::CardStatements.as_str(),
            &secret_key(row_key, part),
            envelope,
        )
        .unwrap_or_else(|_| json!({}))
}

/// Attempt with its sealed fields opened (server-side use and owner views).
fn full_attempt(cards: &CardsConnector, row_key: &str, attempt: &Value) -> Value {
    let id = attempt["attemptId"].as_str().unwrap_or("");
    let mut out = attempt.clone();
    let secret = open(cards, row_key, id, &attempt["secret"]);
    if let (Some(o), Some(x)) = (out.as_object_mut(), secret.as_object()) {
        o.remove("secret");
        for (k, v) in x {
            o.insert(k.clone(), v.clone());
        }
    }
    out
}

fn payable(row: &StoredCardRecord) -> Result<u64, CardsError> {
    let amount_due = parse_cents(row.record["amountDueCents"].as_str().unwrap_or("0")).unwrap_or(0);
    if amount_due == 0 {
        return Err(CardsError::conflict(
            "nothing_due",
            "This statement has nothing to repay",
        ));
    }
    Ok(amount_due)
}

/// Decimals of the configured mint, read on-chain once per attempt.
async fn mint_decimals(base: &BaseChain, mint: &str) -> Result<u8, CardsError> {
    match base.account(mint).await {
        Ok(Some(m)) if m.owner == SPL_TOKEN_PROGRAM && m.data.len() >= 45 => Ok(m.data[44]),
        Ok(_) => Err(CardsError::unavailable(
            "repayment_unconfigured",
            "The configured repayment mint is not an SPL token mint",
        )),
        Err(()) => Err(rpc_down()),
    }
}

fn rpc_down() -> CardsError {
    CardsError::unavailable("rpc_unavailable", "Solana RPC is unavailable; retry")
}

/// The partner token account's owner wallet (the `to` of the private
/// transfer), read on-chain. MagicBlock pays the wallet's associated token
/// account, so the configured account must be exactly that ATA for `mint`;
/// anything else would send the owner's money where verification can never
/// find it, and is refused before anyone pays.
async fn partner_wallet(base: &BaseChain, account: &str, mint: &str) -> Result<String, CardsError> {
    let unconfigured = |m: &str| CardsError::unavailable("repayment_unconfigured", m.to_owned());
    match base.account(account).await {
        Ok(Some(a)) if a.owner == SPL_TOKEN_PROGRAM && a.data.len() >= 64 => {
            let mint_key = addr(mint).ok_or_else(CardsError::internal)?;
            if a.data[..32] != *mint_key.as_ref() {
                return Err(unconfigured(
                    "The partner token account does not hold the repayment mint",
                ));
            }
            let owner: [u8; 32] = a.data[32..64]
                .try_into()
                .map_err(|_| CardsError::internal())?;
            let wallet = Address::from(owner);
            let token = addr(SPL_TOKEN_PROGRAM).ok_or_else(CardsError::internal)?;
            let ata_program = addr(ATA_PROGRAM).ok_or_else(CardsError::internal)?;
            let ata = Address::find_program_address(
                &[wallet.as_ref(), token.as_ref(), mint_key.as_ref()],
                &ata_program,
            )
            .0;
            if ata.to_string() != account {
                return Err(unconfigured(
                    "The partner token account is not the partner wallet's associated token account, where MagicBlock pays",
                ));
            }
            Ok(wallet.to_string())
        }
        Ok(_) => Err(unconfigured(
            "The partner token account does not exist on Devnet",
        )),
        Err(()) => Err(rpc_down()),
    }
}

/// What the owner's client needs to pay, plus the model it must show first.
fn attempt_view(cards: &CardsConnector, row: &StoredCardRecord, attempt: &Value) -> Value {
    let attempt = &full_attempt(cards, &row.key, attempt);
    let mint = &cards.config.repayment.mint;
    let (vault, vault_ata) = vault_accounts(mint).unwrap_or_default();
    json!({
        "attemptId": attempt["attemptId"],
        "state": attempt["state"],
        "method": METHOD,
        "statementId": row.key.strip_prefix("stmt:").unwrap_or(&row.key),
        "cluster": "devnet",
        "apiCluster": "devnet-private",
        "api": PAYMENTS_API,
        "mint": mint,
        "amountCents": row.record["amountDueCents"],
        "amountBaseUnits": attempt["amountBaseUnits"],
        "recipientWallet": attempt["recipientWallet"],
        "recipientTokenAccount": attempt["recipientTokenAccount"],
        "clientRefId": attempt["clientRefId"],
        "transfer": {
            "visibility": "private",
            "fromBalance": "ephemeral",
            "toBalance": "base",
            "split": 1,
            "exactOut": true,
            "minDelayMs": "0",
            "maxDelayMs": "0",
            "memo": null,
        },
        "vault": {
            "program": EPHEMERAL_SPL_PROGRAM,
            "vault": vault,
            "vaultTokenAccount": vault_ata,
            "custody": "Tokens leave your wallet for MagicBlock's shared vault when you deposit, before the payment. You can withdraw an unspent private balance back to your wallet.",
        },
        "verification": {
            "kind": "magicblock_queue_settlement",
            "commitment": "finalized",
            "checks": ["program", "vault", "reference", "mint", "recipient", "amount", "network"],
            "notVerifiable": ["payer"],
            "public": ["amount", "recipient", "settlement time", "reference (opaque number)"],
            "hidden": ["the link between your deposit and the partner's payout"],
        },
        "label": statements::SIMULATED_LABEL,
    })
}

/// `POST /v1/cards/{cardId}/statements/{statementId}/repayment/private`
/// (owner): get or create the open private-repayment attempt. Idempotent: an
/// attempt still waiting for its settlement is returned as is, whatever the
/// `clientOperationId`; a new one (with a new reference) is created only
/// after the previous attempt was found not to match or went stale.
pub async fn prepare(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    statement_id: &str,
    body: PrepareRequest,
) -> Result<Value, CardsError> {
    owned_card(cards, caller, card_id).await?;
    if body.client_operation_id.is_empty() || body.client_operation_id.len() > 128 {
        return Err(CardsError::bad(
            "invalid_body",
            "clientOperationId must be 1-128 characters",
        ));
    }
    let base = cards
        .base()
        .ok_or_else(|| CardsError::unavailable("rpc_unavailable", "Solana RPC is not attached"))?;
    let partner = partner_account(cards)?;
    let mint = cards.config.repayment.mint.clone();
    let first = statement_row(cards, card_id, statement_id).await?;
    let open_now = |row: &StoredCardRecord| {
        attempts(&row.record)
            .into_iter()
            .find(|a| a["state"] == "awaiting_settlement")
    };
    if let Some(open) = open_now(&first) {
        return Ok(attempt_view(cards, &first, &open));
    }
    // Chain reads once, outside the compare-and-swap loop.
    let decimals = mint_decimals(&base, &mint).await?;
    let wallet = partner_wallet(&base, &partner, &mint).await?;
    // Only settlements newer than this are considered for the attempt.
    let cursor = newest_signature(&base, &partner)
        .await
        .map_err(|_| rpc_down())?;
    for _ in 0..5 {
        let row = statement_row(cards, card_id, statement_id).await?;
        let cents_due = payable(&row)?;
        if !matches!(
            row.record["state"].as_str(),
            Some("closed" | "repayment_mismatch")
        ) {
            return Err(CardsError::conflict(
                "statement_state",
                "This statement cannot take a repayment",
            ));
        }
        if let Some(open) = open_now(&row) {
            return Ok(attempt_view(cards, &row, &open));
        }
        let list = attempts(&row.record);
        let seq = list.len() as u64 + 1;
        if seq > 20 {
            return Err(CardsError::conflict(
                "too_many_attempts",
                "This statement has too many private repayment attempts; use the transparent method",
            ));
        }
        let amount =
            statements::base_units(cents_due, decimals).ok_or_else(CardsError::internal)?;
        let digest = row.record["digest"].as_str().unwrap_or("").to_owned();
        let attempt_id = format!("p{seq}");
        let secret = json!({
            "clientRefId": client_ref_id(cards, &digest, seq),
            "partnerCursor": cursor,
        });
        let attempt = json!({
            "attemptId": attempt_id,
            "seq": seq,
            "state": "awaiting_settlement",
            "secret": seal(cards, &row.key, &attempt_id, &secret),
            "mint": mint,
            "decimals": decimals,
            "amountBaseUnits": amount.to_string(),
            "recipientWallet": wallet,
            "recipientTokenAccount": partner,
            "operation": cards.crypto.blind("private-repayment-op", body.client_operation_id.as_bytes()),
            "createdAt": rfc3339(now_ms()),
        });
        let mut record = row.record.clone();
        let mut next = list.clone();
        next.push(attempt.clone());
        record["privateRepayment"] = json!({"method": METHOD, "attempts": next});
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
            CardPut::Written(written) => {
                super::card_log!(
                    "statement {} private attempt {seq} opened",
                    log_id(&row.key)
                );
                return Ok(attempt_view(cards, &written, &attempt));
            }
            CardPut::Conflict(_) => continue,
        }
    }
    Err(CardsError::unavailable(
        "statement_busy",
        "The statement is being updated; retry",
    ))
}

/// Mark one attempt's state on the statement record; `sealed` fields are
/// merged into the attempt's sealed half and re-sealed.
fn set_attempt(
    cards: &CardsConnector,
    row_key: &str,
    record: &mut Value,
    attempt_id: &str,
    state: &str,
    extra: Value,
    sealed: Value,
) {
    let mut list = attempts(record);
    for a in list.iter_mut() {
        if a["attemptId"] == attempt_id {
            a["state"] = json!(state);
            if let (Some(obj), Some(x)) = (a.as_object_mut(), extra.as_object()) {
                for (k, v) in x {
                    obj.insert(k.clone(), v.clone());
                }
            }
            let mut secret = open(cards, row_key, attempt_id, &a["secret"]);
            if let (Some(obj), Some(x)) = (secret.as_object_mut(), sealed.as_object()) {
                for (k, v) in x {
                    obj.insert(k.clone(), v.clone());
                }
            }
            a["secret"] = seal(cards, row_key, attempt_id, &secret);
        }
    }
    record["privateRepayment"]["attempts"] = json!(list);
}

/// Change one attempt without a statement transition (stale, cursor moved,
/// payout that arrived after another method repaid the statement).
async fn update_attempt(
    cards: &CardsConnector,
    key: &str,
    attempt_id: &str,
    state: &str,
    extra: Value,
    sealed: Value,
) -> Result<(), CardsError> {
    for _ in 0..5 {
        let Some(row) = cards
            .store
            .get_card_record(CardKind::CardStatements, key)
            .await?
        else {
            return Ok(());
        };
        let mut record = row.record.clone();
        set_attempt(
            cards,
            key,
            &mut record,
            attempt_id,
            state,
            extra.clone(),
            sealed.clone(),
        );
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
            CardPut::Written(_) => return Ok(()),
            CardPut::Conflict(_) => continue,
        }
    }
    Err(CardsError::unavailable(
        "statement_busy",
        "The statement is being updated; retry",
    ))
}

/// Claim each settlement signature for one statement (create-only), so the
/// same payout can never be counted for two statements.
async fn claim_settlements(
    cards: &CardsConnector,
    card: &StoredCardRecord,
    row: &StoredCardRecord,
    signatures: &[String],
) -> Result<bool, CardsError> {
    for signature in signatures {
        // Blinded: the claim row must not name the public payout either.
        let key = format!(
            "private-settlement:{}",
            cards
                .crypto
                .blind("private-settlement-claim", signature.as_bytes())
        );
        let index = CardIndex {
            owner: card.index.owner.clone(),
            connector: Some(super::CONNECTOR.into()),
            reference: Some(format!(
                "private-settlement:{}",
                row.record["cardId"].as_str().unwrap_or("")
            )),
            idempotency: None,
        };
        let entry = json!({"v": 1, "type": "private_settlement_claim", "statementKey": row.key, "at": rfc3339(now_ms())});
        let claimed = match cards
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
            CardPut::Written(e) => e,
            CardPut::Conflict(Some(existing)) => existing,
            CardPut::Conflict(None) => return Err(CardsError::internal()),
        };
        if claimed.record["statementKey"] != row.key.as_str() {
            return Ok(false);
        }
    }
    Ok(true)
}

pub enum Outcome {
    Verified(StoredCardRecord),
    Mismatch(StoredCardRecord, Vec<&'static str>),
    Pending,
}

/// Same expectations the attempt was opened with, recomputed from config and
/// the statement. A drift marks the attempt `stale` (so `prepare` can open a
/// fresh one) and is reported, never verified against.
async fn expectations(
    cards: &CardsConnector,
    row: &StoredCardRecord,
    attempt: &Value,
) -> Result<(String, String, u64), CardsError> {
    let partner = partner_account(cards)?;
    let mint = cards.config.repayment.mint.clone();
    let decimals = attempt["decimals"]
        .as_u64()
        .and_then(|d| u8::try_from(d).ok());
    let want = decimals.and_then(|d| statements::base_units(payable(row).ok()?, d));
    let fresh = want.is_some_and(|w| attempt["amountBaseUnits"] == w.to_string().as_str())
        && attempt["recipientTokenAccount"] == partner.as_str()
        && attempt["mint"] == mint.as_str();
    if !fresh {
        let id = attempt["attemptId"].as_str().unwrap_or("");
        update_attempt(
            cards,
            &row.key,
            id,
            "stale",
            json!({"checkedAt": rfc3339(now_ms())}),
            json!({}),
        )
        .await?;
        return Err(CardsError::conflict(
            "attempt_stale",
            "The repayment configuration changed since this attempt; prepare a new one",
        ));
    }
    Ok((partner, mint, want.unwrap_or(0)))
}

/// Look for the attempt's settlement and move the statement. Shared by the
/// owner route and the reconcile cron (which finishes a payment whose browser
/// went away).
pub async fn check_attempt(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    row: &StoredCardRecord,
    attempt_id: &str,
) -> Result<Outcome, CardsError> {
    let base = cards
        .base()
        .ok_or_else(|| CardsError::unavailable("rpc_unavailable", "Solana RPC is not attached"))?;
    let attempt = attempts(&row.record)
        .into_iter()
        .find(|a| a["attemptId"] == attempt_id)
        .map(|a| full_attempt(cards, &row.key, &a))
        .ok_or_else(|| CardsError::not_found("No such private repayment attempt"))?;
    if attempt["state"] != "awaiting_settlement" {
        return Err(CardsError::conflict(
            "attempt_spent",
            "This attempt was already checked; prepare a new private repayment",
        ));
    }
    let reference = attempt["clientRefId"].as_str().unwrap_or("").to_owned();
    if reference.is_empty() {
        return Err(CardsError::internal());
    }
    let (partner, mint, want) = expectations(cards, row, &attempt).await?;
    let (found, slot) = match scan(
        &base,
        &partner,
        attempt["partnerCursor"].as_str(),
        &reference,
    )
    .await
    {
        Scan::Found(found, slot) => (found, slot),
        Scan::Pending { advance } => {
            if let Some(next) = advance {
                if attempt["partnerCursor"].as_str() != Some(next.as_str()) {
                    update_attempt(
                        cards,
                        &row.key,
                        attempt_id,
                        "awaiting_settlement",
                        json!({}),
                        json!({"partnerCursor": next}),
                    )
                    .await?;
                }
            }
            return Ok(Outcome::Pending);
        }
        Scan::Unavailable => return Err(rpc_down()),
    };
    let checked_at = rfc3339(now_ms());
    let mut verdict = check(&found, want, &mint, &partner);
    if let Ok((sig, _)) = &verdict {
        if !claim_settlements(cards, card, row, std::slice::from_ref(sig)).await? {
            verdict = Err(vec!["reference"]);
        }
    }
    let observed: Vec<String> = {
        let mut s: Vec<String> = found.iter().map(|(sig, _)| sig.clone()).collect();
        s.dedup();
        s
    };
    match verdict {
        Ok((signature, amount)) => {
            let repayment = json!({
                "method": METHOD,
                "attemptId": attempt_id,
                "cluster": "devnet",
                "mint": mint,
                "recipient": partner,
                "amountBaseUnits": amount.to_string(),
                "settlement": seal(cards, &row.key, "repayment", &json!({"signatures": [signature], "slot": slot.to_string()})),
                "verification": "magicblock_queue_settlement",
                "payerVerified": false,
                "verifiedAt": checked_at,
                "commitment": "finalized",
                "mismatch": [],
            });
            let id = attempt_id.to_owned();
            let row_key = row.key.clone();
            let sig = signature.clone();
            let updated = apply_event(cards, &row.key, StatementEvent::ReceiptVerified, |record| {
                record["repayment"] = repayment.clone();
                set_attempt(
                    cards,
                    &row_key,
                    record,
                    &id,
                    "verified",
                    json!({"checkedAt": checked_at}),
                    json!({"settlementSignatures": [sig]}),
                );
            })
            .await?;
            let updated = match updated {
                Some(updated) => updated,
                // Lost a race with the cron (or the owner): if the winner
                // verified this same attempt, report that, not a conflict.
                None => {
                    let current = statement_row(
                        cards,
                        row.record["cardId"].as_str().unwrap_or(""),
                        row.key.strip_prefix("stmt:").unwrap_or(&row.key),
                    )
                    .await?;
                    if current.record["repayment"]["attemptId"] == attempt_id
                        && current.record["repayment"]["method"] == METHOD
                        && current.record["repayment"]["mismatch"]
                            .as_array()
                            .is_some_and(|m| m.is_empty())
                    {
                        return Ok(Outcome::Verified(current));
                    }
                    return Err(CardsError::conflict(
                        "statement_state",
                        "The statement changed; reload it",
                    ));
                }
            };
            super::card_log!("statement {} private repayment verified", log_id(&row.key));
            Ok(Outcome::Verified(updated))
        }
        Err(fields) => {
            cards.metrics.count("repayment_discrepancies");
            let attempt_record = json!({
                "method": METHOD,
                "attemptId": attempt_id,
                "settlement": seal(cards, &row.key, "repayment", &json!({"signatures": observed})),
                "checkedAt": checked_at,
                "mismatch": fields,
            });
            let id = attempt_id.to_owned();
            let f = fields.clone();
            let sigs = observed.clone();
            let row_key = row.key.clone();
            let updated = apply_event(cards, &row.key, StatementEvent::ReceiptMismatch, |record| {
                record["repayment"] = attempt_record.clone();
                set_attempt(
                    cards,
                    &row_key,
                    record,
                    &id,
                    "mismatch",
                    json!({"mismatch": f, "checkedAt": checked_at}),
                    json!({"settlementSignatures": sigs}),
                );
            })
            .await?;
            let updated = match updated {
                Some(updated) => updated,
                None => {
                    let current = statement_row(
                        cards,
                        row.record["cardId"].as_str().unwrap_or(""),
                        row.key.strip_prefix("stmt:").unwrap_or(&row.key),
                    )
                    .await?;
                    if current.record["repayment"]["attemptId"] == attempt_id {
                        return Ok(Outcome::Mismatch(current, fields));
                    }
                    return Err(CardsError::conflict(
                        "statement_state",
                        "The statement changed; reload it",
                    ));
                }
            };
            super::card_log!(
                "statement {} private repayment mismatch {:?}",
                log_id(&row.key),
                fields
            );
            Ok(Outcome::Mismatch(updated, fields))
        }
    }
}

/// `POST …/repayment` with `{"method":"magicblock_private_payments", attemptId, cluster}`.
pub async fn submit(
    cards: &Arc<CardsConnector>,
    caller: &Caller,
    card_id: &str,
    statement_id: &str,
    body: SubmitRequest,
) -> Result<Value, CardsError> {
    let card = owned_card(cards, caller, card_id).await?;
    if body.method != METHOD
        || body.attempt_id.is_empty()
        || body.attempt_id.len() > 8
        || !body.attempt_id.starts_with('p')
    {
        return Err(CardsError::bad(
            "invalid_body",
            "Request body does not match the contract schema",
        ));
    }
    if body.cluster != "devnet" {
        return Err(CardsError::bad(
            "network",
            "Private repayment runs on Devnet only",
        ));
    }
    let row = statement_row(cards, card_id, statement_id).await?;
    payable(&row)?;
    match row.record["state"].as_str().unwrap_or("") {
        "closed" | "repayment_mismatch" => {}
        "repayment_observed" | "partner_confirmed" | "discharged" => {
            if row.record["repayment"]["attemptId"] != body.attempt_id.as_str()
                || row.record["repayment"]["method"] != METHOD
            {
                return Err(CardsError::conflict(
                    "already_repaid",
                    "This statement already has a verified repayment",
                ));
            }
            let row = statements::advance(cards, &card, &row).await?;
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
    match check_attempt(cards, &card, &row, &body.attempt_id).await? {
        Outcome::Verified(updated) => {
            let updated = statements::advance(cards, &card, &updated).await?;
            Ok(
                json!({"state": updated.record["state"], "statement": statement_view(cards, &updated)}),
            )
        }
        Outcome::Mismatch(updated, fields) => Ok(
            json!({"state": "repayment_mismatch", "mismatch": fields, "statement": statement_view(cards, &updated)}),
        ),
        Outcome::Pending => {
            let mut e = CardsError::conflict(
                "settlement_pending",
                "No finalized MagicBlock settlement with this reference has reached the partner yet; retry shortly",
            );
            e.retryable = true;
            Err(e)
        }
    }
}

/// Simulated partner ledger, private method: re-read the recorded settlement
/// transaction (not the scan) and require the same reference, vault, mint,
/// recipient and exact amount. Returns the signatures it confirmed.
pub async fn partner_reverify(
    cards: &CardsConnector,
    row: &StoredCardRecord,
) -> Result<Option<Vec<String>>, CardsError> {
    let Some(base) = cards.base() else {
        return Ok(None);
    };
    let repayment = &row.record["repayment"];
    let attempt_id = repayment["attemptId"].as_str().unwrap_or("");
    let Some(attempt) = attempts(&row.record)
        .into_iter()
        .find(|a| a["attemptId"] == attempt_id)
        .map(|a| full_attempt(cards, &row.key, &a))
    else {
        return Ok(None);
    };
    let reference = attempt["clientRefId"].as_str().unwrap_or("").to_owned();
    let settlement = open(cards, &row.key, "repayment", &repayment["settlement"]);
    let signatures: Vec<String> = settlement["signatures"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|s| s.as_str().map(str::to_owned))
        .collect();
    if signatures.len() != 1 || reference.is_empty() {
        return Ok(None);
    }
    let partner = partner_account(cards)?;
    let mint = cards.config.repayment.mint.clone();
    let decimals = attempt["decimals"]
        .as_u64()
        .and_then(|d| u8::try_from(d).ok());
    let Some(want) = decimals.and_then(|d| statements::base_units(payable(row).ok()?, d)) else {
        return Ok(None);
    };
    let Ok(found) = reread(&base, &signatures, &reference).await else {
        return Ok(None);
    };
    if check(&found, want, &mint, &partner).is_err() {
        cards.metrics.count("repayment_discrepancies");
        return Ok(None);
    }
    Ok(Some(signatures))
}

/// Partner-ledger evidence for the private method: a keyed digest of the
/// settlement signatures (equal settlements match; the row never names them).
pub fn ledger_evidence(cards: &CardsConnector, signatures: &[String]) -> String {
    format!(
        "settlement:{}",
        cards.crypto.blind(
            "private-settlement-evidence",
            signatures.join(",").as_bytes()
        )
    )
}

/// Owner view of `repayment`: the sealed settlement opened.
pub fn owner_repayment(cards: &CardsConnector, row: &StoredCardRecord) -> Value {
    let mut repayment = row.record["repayment"].clone();
    if repayment["method"] == METHOD {
        let settlement = open(cards, &row.key, "repayment", &repayment["settlement"]);
        if let Some(o) = repayment.as_object_mut() {
            o.remove("settlement");
            o.insert(
                "settlementSignatures".into(),
                settlement["signatures"].clone(),
            );
            if !settlement["slot"].is_null() {
                o.insert("settlementSlot".into(), settlement["slot"].clone());
            }
        }
    }
    repayment
}

/// Agent-facing statement views never carry the private payment details
/// (reference, settlement signatures, partner wallet): an agent has no
/// business linking the owner to a public payout.
pub fn redact_for_agent(view: &mut Value) {
    if let Some(obj) = view.as_object_mut() {
        obj.remove("privateRepayment");
    }
    if view["repayment"]["method"] == METHOD {
        view["repayment"] = json!({
            "method": METHOD,
            "verifiedAt": view["repayment"]["verifiedAt"],
            "mismatch": view["repayment"]["mismatch"],
        });
    }
}

/// Owner view: the attempts without the internal cursor and operation digest.
pub fn owner_attempts(cards: &CardsConnector, row: &StoredCardRecord) -> Value {
    json!(
        attempts(&row.record)
            .into_iter()
            .map(|a| full_attempt(cards, &row.key, &a))
            .map(|a| json!({
                "attemptId": a["attemptId"],
                "state": a["state"],
                "clientRefId": a["clientRefId"],
                "amountBaseUnits": a["amountBaseUnits"],
                "recipientTokenAccount": a["recipientTokenAccount"],
                "createdAt": a["createdAt"],
                "checkedAt": a["checkedAt"],
                "mismatch": a["mismatch"],
                "unappliedBaseUnits": a["unappliedBaseUnits"],
                "settlementSignatures": a["settlementSignatures"],
            }))
            .collect::<Vec<_>>()
    )
}

/// Cron: finish open private attempts whose owner went away, and catch a
/// private payout that landed after the statement was repaid another way
/// (recorded on the attempt as `unapplied_payout` and counted as a
/// discrepancy, so the owner sees they paid twice). Bounded: one scan per
/// open attempt per pass.
pub async fn advance_open_attempts(
    cards: &Arc<CardsConnector>,
    card: &StoredCardRecord,
    rows: &[StoredCardRecord],
) {
    for row in rows.iter().filter(|r| r.record["type"] == "statement") {
        let Some(open) = attempts(&row.record)
            .into_iter()
            .find(|a| a["state"] == "awaiting_settlement")
        else {
            continue;
        };
        let attempt_id = open["attemptId"].as_str().unwrap_or("").to_owned();
        match row.record["state"].as_str() {
            Some("closed" | "repayment_mismatch") => {
                if let Ok(Outcome::Verified(updated)) =
                    check_attempt(cards, card, row, &attempt_id).await
                {
                    let _ = statements::advance(cards, card, &updated).await;
                }
            }
            Some("repayment_observed" | "partner_confirmed" | "discharged") => {
                let _ = orphan_check(cards, row, &open).await;
            }
            _ => {}
        }
    }
}

async fn orphan_check(
    cards: &CardsConnector,
    row: &StoredCardRecord,
    open: &Value,
) -> Result<(), CardsError> {
    let Some(base) = cards.base() else {
        return Ok(());
    };
    let attempt = full_attempt(cards, &row.key, open);
    let id = attempt["attemptId"].as_str().unwrap_or("");
    let reference = attempt["clientRefId"].as_str().unwrap_or("");
    let partner = partner_account(cards)?;
    match scan(
        &base,
        &partner,
        attempt["partnerCursor"].as_str(),
        reference,
    )
    .await
    {
        Scan::Found(found, _) => {
            cards.metrics.count("repayment_discrepancies");
            let sigs: Vec<String> = found.iter().map(|(s, _)| s.clone()).collect();
            let total: u64 = found.iter().map(|(_, s)| s.amount).sum();
            super::card_log!(
                "statement {} private payout arrived after repayment",
                log_id(&row.key)
            );
            update_attempt(
                cards,
                &row.key,
                id,
                "unapplied_payout",
                json!({"checkedAt": rfc3339(now_ms()), "unappliedBaseUnits": total.to_string()}),
                json!({"settlementSignatures": sigs}),
            )
            .await
        }
        Scan::Pending {
            advance: Some(next),
        } if attempt["partnerCursor"].as_str() != Some(next.as_str()) => {
            update_attempt(
                cards,
                &row.key,
                id,
                "awaiting_settlement",
                json!({}),
                json!({"partnerCursor": next}),
            )
            .await
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("testdata/magicblock_settlement_devnet.json");
    const LIVE_EXACT: &str = include_str!("testdata/magicblock_settlement_live_exact.json");
    const LIVE_WRONG: &str = include_str!("testdata/magicblock_settlement_live_wrong_amount.json");
    const DEVNET_PARTNER_ATA: &str = "3burs6CNFvrQW8US2C5W84do8J1EezWsQfsoBAvHF5q6";
    const USDC: &str = statements::DEVNET_USDC_MINT;

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn one(tx: &Value) -> Settlement {
        let mut found = settlements_in(tx).unwrap();
        assert_eq!(found.len(), 1);
        found.pop().unwrap()
    }

    #[test]
    fn vault_derivation_matches_devnet() {
        let (vault, vault_ata) = vault_accounts(USDC).unwrap();
        // Observed on Devnet, 4 Oct 2026 (settlement 4F7JFXqK…).
        assert_eq!(vault, "EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG");
        assert_eq!(vault_ata, "TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r");
    }

    #[test]
    fn real_devnet_settlement_parses() {
        let s = one(&fixture());
        assert_eq!(s.client_ref_id, "7003");
        assert_eq!(s.amount, 100_000);
        assert_eq!(s.destination, DEVNET_PARTNER_ATA);
        assert_eq!(s.mint, USDC);
        let pair = vec![("sig".to_owned(), s.clone())];
        assert_eq!(
            check(&pair, 100_000, USDC, DEVNET_PARTNER_ATA),
            Ok(("sig".into(), 100_000))
        );
        assert_eq!(
            check(&pair, 100_001, USDC, DEVNET_PARTNER_ATA),
            Err(vec!["amount"])
        );
        assert_eq!(
            check(
                &pair,
                100_000,
                USDC,
                "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
            ),
            Err(vec!["recipient"])
        );
        assert_eq!(
            check(
                &pair,
                100_000,
                "So11111111111111111111111111111111111111112",
                DEVNET_PARTNER_ATA
            ),
            Err(vec!["mint"])
        );
    }

    #[test]
    fn the_live_run_settlements_verify_with_this_code() {
        // Run 1 of evidence/private-repayment.md: the exact payout for attempt
        // p2 and the deliberate 0.50 USDC payout for attempt p1.
        let exact = one(&serde_json::from_str(LIVE_EXACT).unwrap());
        assert_eq!(
            (exact.client_ref_id.as_str(), exact.amount),
            ("145170267661", 10_050_000)
        );
        let pair = vec![("MDK3".to_owned(), exact)];
        assert!(check(&pair, 10_050_000, USDC, DEVNET_PARTNER_ATA).is_ok());
        let wrong = one(&serde_json::from_str(LIVE_WRONG).unwrap());
        assert_eq!(
            (wrong.client_ref_id.as_str(), wrong.amount),
            ("104958883709", 500_000)
        );
        let pair = vec![("26Ne".to_owned(), wrong)];
        assert_eq!(
            check(&pair, 10_050_000, USDC, DEVNET_PARTNER_ATA),
            Err(vec!["amount"])
        );
    }

    #[test]
    fn a_non_vault_transfer_is_reported_as_the_wrong_mint() {
        let mut tx = fixture();
        for group in tx["meta"]["innerInstructions"].as_array_mut().unwrap() {
            for ix in group["instructions"].as_array_mut().unwrap() {
                if ix["parsed"]["type"] == "transferChecked" {
                    ix["parsed"]["info"]["authority"] = json!("11111111111111111111111111111111");
                }
            }
        }
        let s = one(&tx);
        assert!(s.mint.starts_with("not-vault:"));
        let pair = vec![("x".to_owned(), s)];
        assert_eq!(
            check(&pair, 100_000, USDC, DEVNET_PARTNER_ATA),
            Err(vec!["mint"])
        );
    }

    #[test]
    fn failed_transaction_is_never_evidence() {
        let mut tx = fixture();
        tx["meta"]["err"] = json!({"InstructionError": [2, "Custom"]});
        assert!(settlements_in(&tx).is_none());
    }

    #[test]
    fn a_reference_logged_by_another_program_does_not_count() {
        let mut tx = fixture();
        let logs = tx["meta"]["logMessages"].as_array_mut().unwrap();
        let i = logs
            .iter()
            .position(|l| l.as_str().unwrap().starts_with(REF_LOG))
            .unwrap();
        logs.remove(i);
        let noop = logs
            .iter()
            .position(|l| {
                l.as_str()
                    .unwrap()
                    .starts_with("Program noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV invoke")
            })
            .unwrap();
        logs.insert(noop + 1, json!("Program log: client_ref_id: 7003"));
        // The execute frame now has no reference: the whole tx is refused.
        assert!(settlements_in(&tx).is_none());
    }

    #[test]
    fn spoofed_execute_log_from_another_program_is_ignored() {
        let logs = vec![
            json!("Program Evi1111111111111111111111111111111111111111 invoke [1]"),
            json!(EXECUTE_LOG),
            json!("Program log: client_ref_id: 42"),
            json!("Program Evi1111111111111111111111111111111111111111 success"),
        ];
        let f = parse_frames(&logs).unwrap();
        assert!(f.frames.is_empty());
    }

    #[test]
    fn unbalanced_or_truncated_logs_are_refused() {
        let logs = vec![
            json!(format!("Program {EPHEMERAL_SPL_PROGRAM} invoke [1]")),
            json!(EXECUTE_LOG),
        ];
        assert!(parse_frames(&logs).is_none());
        let mut tx = fixture();
        tx["meta"]["logMessages"]
            .as_array_mut()
            .unwrap()
            .push(json!("Log truncated"));
        assert!(settlements_in(&tx).is_none());
    }

    #[test]
    fn a_batch_with_another_mints_payout_still_yields_ours() {
        // Two execute frames in one tx: ours (USDC) and one for another mint
        // whose vault we derive too. Pairing is by frame, not by count.
        let mut tx = fixture();
        let other_mint = "So11111111111111111111111111111111111111112";
        let (ov, ova) = vault_accounts(other_mint).unwrap();
        let logs = tx["meta"]["logMessages"].as_array().unwrap().clone();
        let mut extra = vec![
            json!(format!("Program {EPHEMERAL_SPL_PROGRAM} invoke [1]")),
            json!(EXECUTE_LOG),
            json!(format!("Program {SPL_TOKEN_PROGRAM} invoke [2]")),
            json!(format!("Program {SPL_TOKEN_PROGRAM} success")),
            json!("Program log: client_ref_id: 99"),
            json!(format!("Program {EPHEMERAL_SPL_PROGRAM} success")),
        ];
        let mut all = logs.clone();
        all.append(&mut extra);
        tx["meta"]["logMessages"] = json!(all);
        let top = tx["transaction"]["message"]["instructions"]
            .as_array()
            .unwrap()
            .len();
        tx["meta"]["innerInstructions"].as_array_mut().unwrap().push(json!({
            "index": top,
            "instructions": [{"programId": SPL_TOKEN_PROGRAM, "parsed": {"type": "transferChecked", "info": {
                "authority": ov, "source": ova, "destination": DEVNET_PARTNER_ATA, "mint": other_mint,
                "tokenAmount": {"amount": "5"}}}}]
        }));
        let found = settlements_in(&tx).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].client_ref_id, "7003");
        assert_eq!(found[0].mint, USDC);
        assert_eq!(
            (found[1].client_ref_id.as_str(), found[1].mint.as_str()),
            ("99", other_mint)
        );
    }

    #[test]
    fn one_exact_payout_settles_and_extra_same_reference_payouts_never_undo_it() {
        let s = |dest: &str, amount| Settlement {
            client_ref_id: "1".into(),
            source: String::new(),
            destination: dest.into(),
            authority: String::new(),
            mint: USDC.into(),
            amount,
        };
        // Someone adds 1 base unit with the (now public) reference.
        let found = vec![
            ("real".to_owned(), s(DEVNET_PARTNER_ATA, 100)),
            ("grief".to_owned(), s(DEVNET_PARTNER_ATA, 1)),
        ];
        assert_eq!(
            check(&found, 100, USDC, DEVNET_PARTNER_ATA),
            Ok(("real".into(), 100))
        );
        // Split pieces never add up to a settlement: the method pins split 1.
        let found = vec![
            ("a".to_owned(), s(DEVNET_PARTNER_ATA, 60)),
            ("b".to_owned(), s(DEVNET_PARTNER_ATA, 40)),
        ];
        assert_eq!(
            check(&found, 100, USDC, DEVNET_PARTNER_ATA),
            Err(vec!["amount"])
        );
        let found = vec![("a".to_owned(), s("11111111111111111111111111111111", 100))];
        assert_eq!(
            check(&found, 100, USDC, DEVNET_PARTNER_ATA),
            Err(vec!["recipient"])
        );
    }
}
