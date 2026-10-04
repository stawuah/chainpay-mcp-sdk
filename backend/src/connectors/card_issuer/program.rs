//! `card_policy` client: PDAs, instruction encoders, account decoders and the
//! error table (contracts.md §1 + Changelog). Byte layouts follow the IDL at
//! `programs/card_policy/idl/card_policy.json`; the tests pin discriminators
//! and offsets against it.

use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_message::{AccountMeta, Hash, Instruction, Message, VersionedMessage};
use solana_transaction::versioned::VersionedTransaction;

pub const CARD_POLICY_PROGRAM_ID: &str = "Cz9vYKFZFwx8Bqag95xZtw8dqUjS4k9AoyMh1pFo82F";
pub const TEE_VALIDATOR: &str = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
pub const DELEGATION_PROGRAM: &str = "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
pub const PERMISSION_PROGRAM: &str = "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1";
pub const MAGIC_PROGRAM: &str = "Magic11111111111111111111111111111111111111";
pub const MAGIC_VAULT: &str = "MagicVau1t999999999999999999999999999999999";
pub const MAGIC_CONTEXT: &str = "MagicContext1111111111111111111111111111111";
pub const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
pub const COMPUTE_BUDGET_PROGRAM: &str = "ComputeBudget111111111111111111111111111111";

pub const ISSUER_LITHIC_SANDBOX: u8 = 1;
pub const ISSUER_CARD_SIM: u8 = 2;
pub const ACTION_ESCROW_INDEX: u8 = 255;
/// Program `MIN_PREFUND` is 2,942,720 lamports at 32 lamports/byte (contracts.md
/// Changelog, final fixes: AuthGuard included). Rounded up for headroom; the
/// program refuses anything below its constant. Closed intents and
/// reservations return their rent, so this bounds holds open at once, not the
/// card's lifetime.
pub const PREFUND_LAMPORTS: u64 = 5_000_000;
pub const ESCROW_TOP_UP_LAMPORTS: u64 = 20_000_000;

pub mod reservation_state {
    pub const RESERVED: u8 = 1;
    pub const PARTIALLY_CAPTURED: u8 = 2;
    pub const CAPTURED: u8 = 3;
    pub const REVERSED: u8 = 4;
    pub const EXPIRED: u8 = 5;
}
pub const FLAG_LATE_CAPTURE: u8 = 1;
pub const FLAG_OVER_CAPTURE: u8 = 1 << 1;
pub const FLAG_SINGLE_MESSAGE: u8 = 1 << 2;
pub const FLAG_RECURRING: u8 = 1 << 3;

pub mod exception_kind {
    pub const FORCED_CAPTURE: u8 = 1;
    pub const OVER_CAPTURE: u8 = 2;
    pub const OVER_HOLD: u8 = 3;
    pub const CORRECTION_DEBIT: u8 = 4;
    pub const CORRECTION_CREDIT: u8 = 5;
    pub const RETURN_REVERSAL: u8 = 6;
    pub const UNPAIRED_CAPTURE: u8 = 7;
    /// Clearing after a reversed/expired hold whose Reservation was closed.
    pub const LATE_CAPTURE: u8 = 8;
}
pub const FREEZE_AUTHORIZER_SAFETY: u8 = 2;
pub const FREEZE_RECOVERY: u8 = 3;

pub fn addr(value: &str) -> Address {
    value.parse().expect("static address")
}

pub fn program_id() -> Address {
    addr(CARD_POLICY_PROGRAM_ID)
}

fn pda(seeds: &[&[u8]], program: &Address) -> Address {
    Address::find_program_address(seeds, program).0
}

// ------------------------------------------------------------------ hashes

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// `sha256("chainpay-merchant:v1\n" || UPPER(trim(acceptor_id)))`.
pub fn merchant_id_hash(acceptor_id: &str) -> [u8; 32] {
    sha256(&[
        b"chainpay-merchant:v1\n",
        acceptor_id.trim().to_uppercase().as_bytes(),
    ])
}

/// `sha256("chainpay-auth-id:v1\n" || issuer_u8 || lithic_txn_token_utf8)`.
pub fn auth_id_hash(issuer: u8, transaction_token: &str) -> [u8; 32] {
    sha256(&[
        b"chainpay-auth-id:v1\n",
        &[issuer],
        transaction_token.as_bytes(),
    ])
}

/// Issuer event id used for capture/reverse/refund/dispute/exception replay
/// guards: `sha256("chainpay-card-event:v1\n" || issuer_u8 || event_token)`.
pub fn event_id_hash(issuer: u8, event_token: &str) -> [u8; 32] {
    sha256(&[
        b"chainpay-card-event:v1\n",
        &[issuer],
        event_token.as_bytes(),
    ])
}

/// `sha256("chainpay-card-ref:v1\n" || lithic_card_token_utf8 || ref_salt32)`.
pub fn issuer_card_ref_hash(card_token: &str, ref_salt: &[u8; 32]) -> [u8; 32] {
    sha256(&[b"chainpay-card-ref:v1\n", card_token.as_bytes(), ref_salt])
}

/// Opaque Convex lookup for a Lithic card token (contracts.md §5 `cards.reference`).
pub fn card_reference(card_token: &str) -> String {
    hex(&sha256(&[
        b"chainpay-lithic-card:v1\n",
        card_token.as_bytes(),
    ]))
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
            let _ = write!(out, "{b:02x}");
            out
        })
}

pub fn unhex<const N: usize>(value: &str) -> Option<[u8; N]> {
    if value.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, chunk) in value.as_bytes().chunks(2).enumerate() {
        out[i] = u8::from_str_radix(std::str::from_utf8(chunk).ok()?, 16).ok()?;
    }
    Some(out)
}

// -------------------------------------------------------------------- PDAs

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardAccounts {
    pub binding: Address,
    pub policy: Address,
    pub period: Address,
    pub commitment: Address,
    pub escrow: Address,
}

impl CardAccounts {
    pub fn derive(owner: &Address, card_id: &[u8; 32]) -> Self {
        let program = program_id();
        let binding = pda(&[b"card_binding", owner.as_ref(), card_id], &program);
        let policy = pda(&[b"card_policy", binding.as_ref()], &program);
        let period = pda(&[b"card_period", binding.as_ref()], &program);
        let commitment = pda(&[b"card_commit", binding.as_ref()], &program);
        let escrow = pda(
            &[b"balance", policy.as_ref(), &[ACTION_ESCROW_INDEX]],
            &addr(DELEGATION_PROGRAM),
        );
        Self {
            binding,
            policy,
            period,
            commitment,
            escrow,
        }
    }
}

pub fn intent_pda(policy: &Address, intent_id: &[u8; 16]) -> Address {
    pda(&[b"intent", policy.as_ref(), intent_id], &program_id())
}

pub fn reservation_pda(policy: &Address, auth_id_hash: &[u8; 32]) -> Address {
    pda(&[b"res", policy.as_ref(), auth_id_hash], &program_id())
}

/// Per-card replay guard for closed reservations (`["auth_guard", policy]`).
pub fn auth_guard_pda(policy: &Address) -> Address {
    pda(&[b"auth_guard", policy.as_ref()], &program_id())
}

/// Anchor `AccountNotInitialized`: the instruction named an account that does
/// not exist (here: a Reservation already closed).
pub const ACCOUNT_NOT_INITIALIZED: u32 = 3012;

/// Size of the guard ring (`card_policy::constants::GUARD_RING`): a duplicate
/// auth id is refused on-chain for this many later closes on the same card.
pub const GUARD_RING: u64 = 256;
/// Capture ids a Reservation keeps; `capture` refuses one more (`CaptureLimit`).
pub const CAPTURE_RING: usize = 8;

pub fn permission_pda(account: &Address) -> Address {
    pda(
        &[b"permission:", account.as_ref()],
        &addr(PERMISSION_PROGRAM),
    )
}

// ------------------------------------------------------------ instructions

fn disc(name: &str) -> [u8; 8] {
    let digest = sha256(&[format!("global:{name}").as_bytes()]);
    digest[..8].try_into().expect("8 bytes")
}

fn w(key: Address) -> AccountMeta {
    AccountMeta::new(key, false)
}
fn r(key: Address) -> AccountMeta {
    AccountMeta::new_readonly(key, false)
}
fn signer(key: Address) -> AccountMeta {
    AccountMeta::new_readonly(key, true)
}
fn signer_w(key: Address) -> AccountMeta {
    AccountMeta::new(key, true)
}

fn ix(name: &str, accounts: Vec<AccountMeta>, args: &[u8]) -> Instruction {
    let mut data = disc(name).to_vec();
    data.extend_from_slice(args);
    Instruction {
        program_id: program_id(),
        accounts,
        data,
    }
}

/// Program optional account placeholder (Anchor: the program id itself).
fn none_account() -> AccountMeta {
    r(program_id())
}

#[derive(Debug, Clone)]
pub struct IntentArgs {
    pub intent_id: [u8; 16],
    pub agent: [u8; 32],
    pub merchant_id_hash: [u8; 32],
    pub mcc: u16,
    pub max_amount_cents: u64,
    pub expires_at: i64,
}

pub fn open_checkout_intent(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    a: &IntentArgs,
) -> Instruction {
    let intent = intent_pda(policy, &a.intent_id);
    let mut args = Vec::with_capacity(16 + 32 + 32 + 2 + 8 + 3 + 8);
    args.extend_from_slice(&a.intent_id);
    args.extend_from_slice(&a.agent);
    args.extend_from_slice(&a.merchant_id_hash);
    args.extend_from_slice(&a.mcc.to_le_bytes());
    args.extend_from_slice(&a.max_amount_cents.to_le_bytes());
    args.extend_from_slice(b"USD");
    args.extend_from_slice(&a.expires_at.to_le_bytes());
    ix(
        "open_checkout_intent",
        vec![
            signer(*authorizer),
            w(*policy),
            r(*period),
            w(intent),
            w(permission_pda(&intent)),
            w(addr(MAGIC_VAULT)),
            r(addr(MAGIC_PROGRAM)),
            r(addr(PERMISSION_PROGRAM)),
        ],
        &args,
    )
}

#[derive(Debug, Clone)]
pub struct AuthorizeArgs {
    pub auth_id_hash: [u8; 32],
    pub intent_id: [u8; 16],
    pub amount_cents: u64,
    pub merchant_id_hash: [u8; 32],
    pub mcc: u16,
    pub merchant_initiated: bool,
    pub single_message: bool,
}

pub fn authorize(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    a: &AuthorizeArgs,
) -> Instruction {
    let intent = intent_pda(policy, &a.intent_id);
    let reservation = reservation_pda(policy, &a.auth_id_hash);
    let mut args = Vec::with_capacity(32 + 16 + 8 + 3 + 32 + 2 + 2);
    args.extend_from_slice(&a.auth_id_hash);
    args.extend_from_slice(&a.intent_id);
    args.extend_from_slice(&a.amount_cents.to_le_bytes());
    args.extend_from_slice(b"USD");
    args.extend_from_slice(&a.merchant_id_hash);
    args.extend_from_slice(&a.mcc.to_le_bytes());
    args.push(a.merchant_initiated as u8);
    args.push(a.single_message as u8);
    ix(
        "authorize",
        vec![
            signer(*authorizer),
            w(*policy),
            w(*period),
            w(intent),
            w(reservation),
            w(permission_pda(&reservation)),
            w(addr(MAGIC_VAULT)),
            r(addr(MAGIC_PROGRAM)),
            r(addr(PERMISSION_PROGRAM)),
            // Replay guard for closed reservations (read-only; may be empty).
            r(auth_guard_pda(policy)),
        ],
        &args,
    )
}

/// #29: close a final Reservation; its rent returns to the card prefund and
/// its auth id moves into the guard ring (created on the card's first close).
pub fn close_reservation(
    signer_key: &Address,
    policy: &Address,
    period: &Address,
    auth_id_hash: &[u8; 32],
) -> Instruction {
    let reservation = reservation_pda(policy, auth_id_hash);
    let guard = auth_guard_pda(policy);
    ix(
        "close_reservation",
        vec![
            signer(*signer_key),
            w(*policy),
            r(*period),
            w(reservation),
            w(permission_pda(&reservation)),
            w(guard),
            w(permission_pda(&guard)),
            w(addr(MAGIC_VAULT)),
            r(addr(MAGIC_PROGRAM)),
            r(addr(PERMISSION_PROGRAM)),
        ],
        &[],
    )
}

fn reservation_ix(
    name: &str,
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    reservation: Option<&Address>,
    args: &[u8],
) -> Instruction {
    ix(
        name,
        vec![
            signer(*authorizer),
            w(*policy),
            w(*period),
            reservation.map_or_else(none_account, |r| w(*r)),
        ],
        args,
    )
}

pub fn capture(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    reservation: &Address,
    amount_cents: u64,
    capture_id_hash: &[u8; 32],
) -> Instruction {
    let mut args = amount_cents.to_le_bytes().to_vec();
    args.extend_from_slice(capture_id_hash);
    reservation_ix(
        "capture",
        authorizer,
        policy,
        period,
        Some(reservation),
        &args,
    )
}

pub fn reverse(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    reservation: &Address,
    amount_cents: u64,
    reason: u8,
    event_id_hash: &[u8; 32],
) -> Instruction {
    let mut args = amount_cents.to_le_bytes().to_vec();
    args.push(reason);
    args.extend_from_slice(event_id_hash);
    reservation_ix(
        "reverse",
        authorizer,
        policy,
        period,
        Some(reservation),
        &args,
    )
}

pub fn refund(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    reservation: Option<&Address>,
    amount_cents: u64,
    event_id_hash: &[u8; 32],
) -> Instruction {
    let mut args = amount_cents.to_le_bytes().to_vec();
    args.extend_from_slice(event_id_hash);
    reservation_ix("refund", authorizer, policy, period, reservation, &args)
}

pub fn record_dispute(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    reservation: &Address,
    state: u8,
    event_id_hash: &[u8; 32],
) -> Instruction {
    let mut args = vec![state];
    args.extend_from_slice(event_id_hash);
    reservation_ix(
        "record_dispute",
        authorizer,
        policy,
        period,
        Some(reservation),
        &args,
    )
}

pub fn record_exception(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    reservation: Option<&Address>,
    kind: u8,
    amount_cents: u64,
    event_id_hash: &[u8; 32],
) -> Instruction {
    let mut args = vec![kind];
    args.extend_from_slice(&amount_cents.to_le_bytes());
    args.extend_from_slice(event_id_hash);
    reservation_ix(
        "record_exception",
        authorizer,
        policy,
        period,
        reservation,
        &args,
    )
}

pub fn adjust_reservation(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    reservation: &Address,
    new_amount_cents: u64,
) -> Instruction {
    reservation_ix(
        "adjust_reservation",
        authorizer,
        policy,
        period,
        Some(reservation),
        &new_amount_cents.to_le_bytes(),
    )
}

pub fn freeze(signer_key: &Address, policy: &Address, period: &Address, reason: u8) -> Instruction {
    ix(
        "freeze",
        vec![signer(*signer_key), w(*policy), r(*period)],
        &[reason],
    )
}

pub fn recovery_freeze(
    signer_key: &Address,
    policy: &Address,
    period: &Address,
    reason: u8,
) -> Instruction {
    ix(
        "recovery_freeze",
        vec![signer(*signer_key), w(*policy), r(*period)],
        &[reason],
    )
}

pub fn unfreeze(owner: &Address, policy: &Address, period: &Address) -> Instruction {
    ix(
        "unfreeze",
        vec![signer(*owner), w(*policy), w(*period)],
        &[],
    )
}

pub fn close_checkout_intent(
    signer_key: &Address,
    policy: &Address,
    intent: &Address,
) -> Instruction {
    ix(
        "close_checkout_intent",
        vec![
            signer(*signer_key),
            w(*policy),
            w(*intent),
            w(permission_pda(intent)),
            w(addr(MAGIC_VAULT)),
            r(addr(MAGIC_PROGRAM)),
            r(addr(PERMISSION_PROGRAM)),
        ],
        &[],
    )
}

pub fn checkpoint(
    authorizer: &Address,
    accounts: &CardAccounts,
    master_salt: &[u8; 32],
    seq: u64,
) -> Instruction {
    let mut args = master_salt.to_vec();
    args.extend_from_slice(&seq.to_le_bytes());
    ix(
        "checkpoint",
        vec![
            signer_w(*authorizer),
            w(accounts.policy),
            r(accounts.period),
            r(accounts.binding),
            r(accounts.commitment),
            w(addr(MAGIC_CONTEXT)),
            r(addr(MAGIC_PROGRAM)),
        ],
        &args,
    )
}

/// `roll_period` (authorizer). `expired_reservations` are passed writable as
/// remaining accounts so the program can release holds past `hold_expires_at`.
pub fn roll_period(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    expired_reservations: &[Address],
) -> Instruction {
    let mut accounts = vec![signer(*authorizer), w(*policy), w(*period)];
    accounts.extend(expired_reservations.iter().map(|r| w(*r)));
    ix("roll_period", accounts, &[])
}

/// `record_repayment` (authorizer, contracts.md §1.3 #27). Only after the
/// statement is `partner_confirmed`; the digest is single use on-chain.
pub fn record_repayment(
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    statement_digest: &[u8; 32],
    amount_cents: u64,
) -> Instruction {
    let mut args = statement_digest.to_vec();
    args.extend_from_slice(&amount_cents.to_le_bytes());
    ix(
        "record_repayment",
        vec![signer(*authorizer), w(*policy), r(*period)],
        &args,
    )
}

/// `confirm_reconciled` (owner only). Built unsigned for the owner's wallet.
pub fn confirm_reconciled(
    owner: &Address,
    policy: &Address,
    period: &Address,
    recon_digest: &[u8; 32],
) -> Instruction {
    ix(
        "confirm_reconciled",
        vec![signer(*owner), w(*policy), w(*period)],
        recon_digest,
    )
}

#[derive(Debug, Clone)]
pub struct RestoreArgs {
    pub policy: PolicyArgs,
    pub period_index: u32,
    pub captured_cents: u64,
    pub reserved_cents: u64,
    pub refunded_cents: u64,
    pub purchases_count: u16,
    pub exception_cents: u64,
    pub statement_outstanding_cents: u64,
    pub ledger_head: [u8; 32],
    pub ledger_seq: u64,
    pub recon_digest: [u8; 32],
}

pub fn restore(
    owner: &Address,
    authorizer: &Address,
    policy: &Address,
    period: &Address,
    a: &RestoreArgs,
) -> Instruction {
    let mut args = a.policy.encode();
    args.extend_from_slice(&a.period_index.to_le_bytes());
    args.extend_from_slice(&a.captured_cents.to_le_bytes());
    args.extend_from_slice(&a.reserved_cents.to_le_bytes());
    args.extend_from_slice(&a.refunded_cents.to_le_bytes());
    args.extend_from_slice(&a.purchases_count.to_le_bytes());
    args.extend_from_slice(&a.exception_cents.to_le_bytes());
    args.extend_from_slice(&a.statement_outstanding_cents.to_le_bytes());
    args.extend_from_slice(&a.ledger_head);
    args.extend_from_slice(&a.ledger_seq.to_le_bytes());
    args.extend_from_slice(&a.recon_digest);
    ix(
        "restore",
        vec![signer(*owner), signer(*authorizer), w(*policy), w(*period)],
        &args,
    )
}

// ---- owner-side builders (prepare route, live driver, tests) ----

pub fn init_card(
    owner: &Address,
    card_id: &[u8; 32],
    issuer: u8,
    card_ref_hash: &[u8; 32],
    prefund: u64,
) -> Instruction {
    let accounts = CardAccounts::derive(owner, card_id);
    let mut args = card_id.to_vec();
    args.push(issuer);
    args.extend_from_slice(card_ref_hash);
    args.extend_from_slice(&prefund.to_le_bytes());
    ix(
        "init_card",
        vec![
            signer_w(*owner),
            w(accounts.binding),
            w(accounts.policy),
            w(accounts.period),
            w(accounts.commitment),
            r(addr(SYSTEM_PROGRAM)),
        ],
        &args,
    )
}

pub fn delegate_card(owner: &Address, card_id: &[u8; 32]) -> Instruction {
    let accounts = CardAccounts::derive(owner, card_id);
    let program = program_id();
    let delegation = addr(DELEGATION_PROGRAM);
    let buffer = |account: &Address| pda(&[b"buffer", account.as_ref()], &program);
    let record = |account: &Address| pda(&[b"delegation", account.as_ref()], &delegation);
    let metadata =
        |account: &Address| pda(&[b"delegation-metadata", account.as_ref()], &delegation);
    ix(
        "delegate_card",
        vec![
            signer_w(*owner),
            r(accounts.binding),
            w(buffer(&accounts.policy)),
            w(record(&accounts.policy)),
            w(metadata(&accounts.policy)),
            w(accounts.policy),
            w(buffer(&accounts.period)),
            w(record(&accounts.period)),
            w(metadata(&accounts.period)),
            w(accounts.period),
            r(program),
            r(delegation),
            r(addr(SYSTEM_PROGRAM)),
        ],
        addr(TEE_VALIDATOR).as_ref(),
    )
}

/// Delegation program `TopUpEphemeralBalance` (discriminator 9, u64 LE), args
/// `{amount: u64, index: u8}` for the card's checkpoint escrow.
pub fn top_up_escrow(payer: &Address, escrow_authority: &Address, lamports: u64) -> Instruction {
    let escrow = pda(
        &[
            b"balance",
            escrow_authority.as_ref(),
            &[ACTION_ESCROW_INDEX],
        ],
        &addr(DELEGATION_PROGRAM),
    );
    let mut data = 9u64.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    data.push(ACTION_ESCROW_INDEX);
    Instruction {
        program_id: addr(DELEGATION_PROGRAM),
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*escrow_authority, false),
            AccountMeta::new(escrow, false),
            AccountMeta::new_readonly(addr(SYSTEM_PROGRAM), false),
        ],
        data,
    }
}

fn permission_accounts(owner: &Address, policy: &Address, period: &Address) -> Vec<AccountMeta> {
    vec![
        signer(*owner),
        w(*policy),
        w(*period),
        w(permission_pda(policy)),
        w(permission_pda(period)),
        w(addr(MAGIC_VAULT)),
        r(addr(MAGIC_PROGRAM)),
        r(addr(PERMISSION_PROGRAM)),
    ]
}

pub fn init_permission(
    owner: &Address,
    policy: &Address,
    period: &Address,
    authorizer: &Address,
) -> Instruction {
    ix(
        "init_permission",
        permission_accounts(owner, policy, period),
        authorizer.as_ref(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyArgs {
    pub budget_cents: u64,
    pub max_purchase_cents: u64,
    pub max_purchases_per_period: u16,
    pub period_seconds: u32,
    pub merchant_id_hashes: Vec<[u8; 32]>,
    pub mccs: Vec<u16>,
    pub expires_at: i64,
    pub recurring_allowed: bool,
    pub fee_bps: u16,
    pub authorizer: [u8; 32],
}

impl PolicyArgs {
    fn encode(&self) -> Vec<u8> {
        let mut args = Vec::new();
        args.extend_from_slice(&self.budget_cents.to_le_bytes());
        args.extend_from_slice(&self.max_purchase_cents.to_le_bytes());
        args.extend_from_slice(&self.max_purchases_per_period.to_le_bytes());
        args.extend_from_slice(&self.period_seconds.to_le_bytes());
        args.extend_from_slice(b"USD");
        args.extend_from_slice(&(self.merchant_id_hashes.len() as u32).to_le_bytes());
        for hash in &self.merchant_id_hashes {
            args.extend_from_slice(hash);
        }
        args.extend_from_slice(&(self.mccs.len() as u32).to_le_bytes());
        for mcc in &self.mccs {
            args.extend_from_slice(&mcc.to_le_bytes());
        }
        args.extend_from_slice(&self.expires_at.to_le_bytes());
        args.push(self.recurring_allowed as u8);
        args.extend_from_slice(&self.fee_bps.to_le_bytes());
        args.extend_from_slice(&self.authorizer);
        args
    }
}

pub fn set_policy(
    owner: &Address,
    policy: &Address,
    period: &Address,
    a: &PolicyArgs,
) -> Instruction {
    ix(
        "set_policy",
        permission_accounts(owner, policy, period),
        &a.encode(),
    )
}

pub fn set_compute_unit_limit(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction {
        program_id: addr(COMPUTE_BUDGET_PROGRAM),
        accounts: vec![],
        data,
    }
}

/// Legacy message for `payer` with zero signatures in place.
/// A message's meaning, independent of how a client ordered its account keys:
/// fee payer, then each instruction's program, `(key, signer, writable)`
/// metas and data. Wallets and web3.js re-sort keys when they recompile a
/// message (e.g. after refreshing the blockhash), so equality of bytes is
/// the wrong test for "is this the transaction we prepared".
pub type DecodedInstruction = (Address, Vec<(Address, bool, bool)>, Vec<u8>);

pub fn decode_message(message: &VersionedMessage) -> Option<(Address, Vec<DecodedInstruction>)> {
    if message
        .address_table_lookups()
        .is_some_and(|lookups| !lookups.is_empty())
    {
        return None;
    }
    let keys = message.static_account_keys();
    let header = message.header();
    let signed = header.num_required_signatures as usize;
    let ro_signed = header.num_readonly_signed_accounts as usize;
    let ro_unsigned = header.num_readonly_unsigned_accounts as usize;
    if signed == 0 || signed > keys.len() || ro_signed > signed || ro_unsigned > keys.len() - signed
    {
        return None;
    }
    let writable = |i: usize| {
        if i < signed {
            i < signed - ro_signed
        } else {
            i - signed < keys.len() - signed - ro_unsigned
        }
    };
    let mut out = Vec::new();
    for ix in message.instructions() {
        let program = *keys.get(ix.program_id_index as usize)?;
        let mut metas = Vec::new();
        for &index in &ix.accounts {
            let i = index as usize;
            metas.push((*keys.get(i)?, i < signed, writable(i)));
        }
        out.push((program, metas, ix.data.clone()));
    }
    Some((keys[0], out))
}

pub fn unsigned_transaction(
    payer: &Address,
    instructions: &[Instruction],
    blockhash: [u8; 32],
) -> VersionedTransaction {
    let message =
        Message::new_with_blockhash(instructions, Some(payer), &Hash::new_from_array(blockhash));
    let signers = message.header.num_required_signatures as usize;
    VersionedTransaction {
        signatures: vec![Default::default(); signers],
        message: VersionedMessage::Legacy(message),
    }
}

/// Sign with every key in `keys` whose address is a required signer.
pub fn sign_transaction(
    tx: &mut VersionedTransaction,
    keys: &[&ed25519_dalek::SigningKey],
) -> Result<(), &'static str> {
    use ed25519_dalek::Signer;
    let bytes = tx.message.serialize();
    let required = tx.message.header().num_required_signatures as usize;
    let account_keys = tx.message.static_account_keys().to_vec();
    for key in keys {
        let address = Address::from(key.verifying_key().to_bytes());
        let index = account_keys
            .iter()
            .take(required)
            .position(|candidate| *candidate == address)
            .ok_or("signer is not a required signer")?;
        tx.signatures[index] = key.sign(&bytes).to_bytes().into();
    }
    Ok(())
}

pub fn serialize_transaction(tx: &VersionedTransaction) -> Vec<u8> {
    wincode::serialize(tx).expect("transaction serializes")
}

// ---------------------------------------------------------------- decoders

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    Discriminator,
    Short,
}

fn account_disc(name: &str) -> [u8; 8] {
    sha256(&[format!("account:{name}").as_bytes()])[..8]
        .try_into()
        .expect("8 bytes")
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8], name: &str) -> Result<Self, DecodeError> {
        if data.len() < 8 {
            return Err(DecodeError::Short);
        }
        if data[..8] != account_disc(name) {
            return Err(DecodeError::Discriminator);
        }
        Ok(Self { data, at: 8 })
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        let out = self
            .data
            .get(self.at..self.at + n)
            .ok_or(DecodeError::Short)?;
        self.at += n;
        Ok(out)
    }
    fn arr<const N: usize>(&mut self) -> Result<[u8; N], DecodeError> {
        Ok(self.take(N)?.try_into().expect("length"))
    }
    fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, DecodeError> {
        Ok(u16::from_le_bytes(self.arr()?))
    }
    fn u32(&mut self) -> Result<u32, DecodeError> {
        Ok(u32::from_le_bytes(self.arr()?))
    }
    fn u64(&mut self) -> Result<u64, DecodeError> {
        Ok(u64::from_le_bytes(self.arr()?))
    }
    fn i64(&mut self) -> Result<i64, DecodeError> {
        Ok(i64::from_le_bytes(self.arr()?))
    }
    fn key(&mut self) -> Result<Address, DecodeError> {
        Ok(Address::from(self.arr::<32>()?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardPolicyAccount {
    pub binding: Address,
    pub owner: Address,
    pub authorizer: Address,
    pub policy_version: u32,
    pub budget_cents: u64,
    pub max_purchase_cents: u64,
    pub max_purchases_per_period: u16,
    pub period_seconds: u32,
    pub currency: [u8; 3],
    pub merchant_id_hashes: Vec<[u8; 32]>,
    pub mccs: Vec<u16>,
    pub expires_at: i64,
    pub recurring_allowed: bool,
    pub fee_bps: u16,
    pub frozen: bool,
    pub freeze_reason: u8,
    pub recovery_state: u8,
    pub statement_outstanding_cents: u64,
    pub exceptions_open: u16,
    pub ledger_head: [u8; 32],
    pub ledger_seq: u64,
    pub commit_seq: u64,
    /// Appended in 1A: digest `restore` stored; `confirm_reconciled` must match.
    pub recon_digest: [u8; 32],
    /// Last statement digests `record_repayment` accepted (replay ring).
    pub repayment_digests: Vec<[u8; 32]>,
}

impl CardPolicyAccount {
    /// `record_repayment` already accepted this statement digest.
    pub fn repayment_recorded(&self, digest: &[u8; 32]) -> bool {
        self.repayment_digests.iter().any(|d| d == digest)
    }
}

pub fn decode_policy(data: &[u8]) -> Result<CardPolicyAccount, DecodeError> {
    let mut r = Reader::new(data, "CardPolicy")?;
    let binding = r.key()?;
    let owner = r.key()?;
    let authorizer = r.key()?;
    let policy_version = r.u32()?;
    let budget_cents = r.u64()?;
    let max_purchase_cents = r.u64()?;
    let max_purchases_per_period = r.u16()?;
    let period_seconds = r.u32()?;
    let currency = r.arr::<3>()?;
    let merchant_count = r.u8()? as usize;
    let mut merchants = Vec::new();
    for _ in 0..8 {
        merchants.push(r.arr::<32>()?);
    }
    let mcc_count = r.u8()? as usize;
    let mut mccs = Vec::new();
    for _ in 0..16 {
        mccs.push(r.u16()?);
    }
    let expires_at = r.i64()?;
    let recurring_allowed = r.u8()? != 0;
    let fee_bps = r.u16()?;
    let frozen = r.u8()? != 0;
    let freeze_reason = r.u8()?;
    let recovery_state = r.u8()?;
    let statement_outstanding_cents = r.u64()?;
    let exceptions_open = r.u16()?;
    let _member_count = r.u8()?;
    r.take(32 * 6)?;
    r.take(6)?;
    let ledger_head = r.arr::<32>()?;
    let ledger_seq = r.u64()?;
    let commit_seq = r.u64()?;
    // Appended fields: absent on a short (pre-1A) account, never guessed.
    let (recon_digest, repayment_digests) = (|| {
        let _bump = r.u8()?;
        let recon = r.arr::<32>()?;
        let mut ring = Vec::new();
        for _ in 0..8 {
            ring.push(r.arr::<32>()?);
        }
        let _count = r.u8()?;
        // A ring: every non-zero slot is a recorded digest.
        ring.retain(|d| *d != [0u8; 32]);
        Ok::<_, DecodeError>((recon, ring))
    })()
    .unwrap_or(([0u8; 32], Vec::new()));
    merchants.truncate(merchant_count.min(8));
    mccs.truncate(mcc_count.min(16));
    Ok(CardPolicyAccount {
        binding,
        owner,
        authorizer,
        policy_version,
        budget_cents,
        max_purchase_cents,
        max_purchases_per_period,
        period_seconds,
        currency,
        merchant_id_hashes: merchants,
        mccs,
        expires_at,
        recurring_allowed,
        fee_bps,
        frozen,
        freeze_reason,
        recovery_state,
        statement_outstanding_cents,
        exceptions_open,
        ledger_head,
        ledger_seq,
        commit_seq,
        recon_digest,
        repayment_digests,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardPeriodAccount {
    pub policy: Address,
    pub period_index: u32,
    pub period_start: i64,
    pub period_end: i64,
    pub captured_cents: u64,
    pub reserved_cents: u64,
    pub refunded_cents: u64,
    pub purchases_count: u16,
    pub exception_cents: u64,
}

pub fn decode_period(data: &[u8]) -> Result<CardPeriodAccount, DecodeError> {
    let mut r = Reader::new(data, "CardPeriod")?;
    Ok(CardPeriodAccount {
        policy: r.key()?,
        period_index: r.u32()?,
        period_start: r.i64()?,
        period_end: r.i64()?,
        captured_cents: r.u64()?,
        reserved_cents: r.u64()?,
        refunded_cents: r.u64()?,
        purchases_count: r.u16()?,
        exception_cents: r.u64()?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReservationAccount {
    pub policy: Address,
    pub auth_id_hash: [u8; 32],
    pub intent: Address,
    pub period_index: u32,
    pub amount_reserved_cents: u64,
    pub captured_cents: u64,
    pub reversed_cents: u64,
    pub refunded_cents: u64,
    pub state: u8,
    pub dispute_state: u8,
    pub flags: u8,
    pub created_at: i64,
    pub hold_expires_at: i64,
}

pub fn decode_reservation(data: &[u8]) -> Result<ReservationAccount, DecodeError> {
    let mut r = Reader::new(data, "Reservation")?;
    Ok(ReservationAccount {
        policy: r.key()?,
        auth_id_hash: r.arr()?,
        intent: r.key()?,
        period_index: r.u32()?,
        amount_reserved_cents: r.u64()?,
        captured_cents: r.u64()?,
        reversed_cents: r.u64()?,
        refunded_cents: r.u64()?,
        state: r.u8()?,
        dispute_state: r.u8()?,
        flags: r.u8()?,
        created_at: r.i64()?,
        hold_expires_at: r.i64()?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckoutIntentAccount {
    pub policy: Address,
    pub intent_id: [u8; 16],
    pub agent: Address,
    pub merchant_id_hash: [u8; 32],
    pub mcc: u16,
    pub max_amount_cents: u64,
    pub currency: [u8; 3],
    pub policy_version: u32,
    pub expires_at: i64,
    pub state: u8,
}

pub fn decode_intent(data: &[u8]) -> Result<CheckoutIntentAccount, DecodeError> {
    let mut r = Reader::new(data, "CheckoutIntent")?;
    Ok(CheckoutIntentAccount {
        policy: r.key()?,
        intent_id: r.arr()?,
        agent: r.key()?,
        merchant_id_hash: r.arr()?,
        mcc: r.u16()?,
        max_amount_cents: r.u64()?,
        currency: r.arr()?,
        policy_version: r.u32()?,
        expires_at: r.i64()?,
        state: r.u8()?,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitmentAccount {
    pub binding: Address,
    pub seq: u64,
    pub root: [u8; 32],
    pub policy_version: u32,
    pub period_index: u32,
    pub written_slot: u64,
}

pub fn decode_commitment(data: &[u8]) -> Result<CommitmentAccount, DecodeError> {
    let mut r = Reader::new(data, "CardCommitment")?;
    Ok(CommitmentAccount {
        binding: r.key()?,
        seq: r.u64()?,
        root: r.arr()?,
        policy_version: r.u32()?,
        period_index: r.u32()?,
        written_slot: r.u64()?,
    })
}

// ------------------------------------------------------------------ errors

pub const ERRORS: [&str; 50] = [
    "Unauthorized",
    "ValidatorNotAllowed",
    "PolicyNotSet",
    "InvalidPolicy",
    "CardFrozen",
    "RecoveryFrozen",
    "PolicyExpired",
    "IntentInvalid",
    "IntentExpired",
    "IntentStale",
    "MerchantMismatch",
    "MerchantNotAllowed",
    "MccNotAllowed",
    "CurrencyMismatch",
    "AmountExceedsIntent",
    "AmountExceedsMax",
    "BudgetExceeded",
    "VelocityExceeded",
    "RecurringNotAllowed",
    "DuplicateAuthorization",
    "DuplicateCapture",
    "ReservationClosed",
    "PeriodNotEnded",
    "DisclosureBlocked",
    "MemberLimit",
    "ExceptionsOpen",
    "NotInRecovery",
    "StaleCommitment",
    "OpenReservations",
    "OutstandingBalance",
    "MathOverflow",
    "AuthorizerChangeRequiresFreeze",
    "DuplicateRepayment",
    "MemberNotFound",
    "PermissionNotInitialized",
    "InvalidAmount",
    "NoOpenExceptions",
    "ReconDigestMismatch",
    "RepaymentExceedsOutstanding",
    "InvalidAccount",
    "PrefundTooLow",
    "NotWiped",
    "InvalidEventId",
    "DuplicateEvent",
    "EphemeralAccountsOpen",
    "ReservationNotFinal",
    "CoSignerRequired",
    "RefundExceedsCapture",
    "CaptureLimit",
    "BudgetBelowCommitted",
];

pub fn error_name(code: u32) -> Option<&'static str> {
    code.checked_sub(6000)
        .and_then(|index| ERRORS.get(index as usize))
        .copied()
}

/// Lithic ASA `result` for a program rejection of `authorize` (contracts.md §3.1).
pub fn asa_result_for(code: u32) -> &'static str {
    match error_name(code) {
        Some("CardFrozen" | "RecoveryFrozen" | "PolicyExpired") => "CARD_PAUSED",
        Some(
            "MerchantMismatch"
            | "MerchantNotAllowed"
            | "MccNotAllowed"
            | "CurrencyMismatch"
            | "IntentInvalid"
            | "IntentExpired"
            | "IntentStale"
            | "RecurringNotAllowed",
        ) => "UNAUTHORIZED_MERCHANT",
        Some("BudgetExceeded" | "AmountExceedsIntent" | "AmountExceedsMax") => "INSUFFICIENT_FUNDS",
        Some("VelocityExceeded") => "VELOCITY_EXCEEDED",
        _ => "SUSPECTED_FRAUD",
    }
}

/// UI decline reason (contracts.md §9 `CardDeclineReason`).
pub fn decline_reason_for(code: u32) -> &'static str {
    match error_name(code) {
        Some("CardFrozen" | "RecoveryFrozen" | "PolicyExpired") => "frozen",
        Some(
            "MerchantMismatch"
            | "MerchantNotAllowed"
            | "MccNotAllowed"
            | "CurrencyMismatch"
            | "RecurringNotAllowed",
        ) => "merchant_not_allowed",
        Some("IntentInvalid" | "IntentExpired" | "IntentStale") => "intent_missing",
        Some("BudgetExceeded") => "over_budget",
        Some("AmountExceedsIntent" | "AmountExceedsMax") => "over_max",
        Some("VelocityExceeded") => "velocity",
        _ => "internal",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Re-sort a legacy message's unsigned keys the way web3.js does
    /// (stringwise within each header group) and remap the instructions.
    fn resort_like_web3(message: &Message) -> Message {
        let mut m = message.clone();
        let signed = m.header.num_required_signatures as usize;
        let ro_unsigned = m.header.num_readonly_unsigned_accounts as usize;
        let n = m.account_keys.len();
        let mut order: Vec<usize> = (0..n).collect();
        let (writable_unsigned, readonly_unsigned) = (signed..n - ro_unsigned, n - ro_unsigned..n);
        order[writable_unsigned.clone()].sort_by_key(|&i| message.account_keys[i].to_string());
        order[readonly_unsigned.clone()].sort_by_key(|&i| message.account_keys[i].to_string());
        m.account_keys = order.iter().map(|&i| message.account_keys[i]).collect();
        let remap = |old: u8| order.iter().position(|&i| i == old as usize).unwrap() as u8;
        for ix in &mut m.instructions {
            ix.program_id_index = remap(ix.program_id_index);
            ix.accounts = ix.accounts.iter().map(|&a| remap(a)).collect();
        }
        m
    }

    #[test]
    fn card_setup_transactions_compare_by_meaning_not_key_order() {
        let owner = Address::from([7u8; 32]);
        for seed in 1u8..40 {
            let card_id = [seed; 32];
            let ix = vec![init_card(
                &owner,
                &card_id,
                ISSUER_LITHIC_SANDBOX,
                &[3; 32],
                PREFUND_LAMPORTS,
            )];
            let tx = unsigned_transaction(&owner, &ix, [9; 32]);
            let VersionedMessage::Legacy(legacy) = &tx.message else {
                unreachable!()
            };
            let resorted = VersionedMessage::Legacy(resort_like_web3(legacy));
            assert_eq!(
                decode_message(&tx.message),
                decode_message(&resorted),
                "seed {seed}"
            );
        }
        // A changed amount or an extra instruction is a different transaction.
        let card_id = [1u8; 32];
        let want = unsigned_transaction(
            &owner,
            &[init_card(
                &owner,
                &card_id,
                ISSUER_LITHIC_SANDBOX,
                &[3; 32],
                PREFUND_LAMPORTS,
            )],
            [9; 32],
        );
        let more = unsigned_transaction(
            &owner,
            &[init_card(
                &owner,
                &card_id,
                ISSUER_LITHIC_SANDBOX,
                &[3; 32],
                PREFUND_LAMPORTS + 1,
            )],
            [9; 32],
        );
        let extra = unsigned_transaction(
            &owner,
            &[
                init_card(
                    &owner,
                    &card_id,
                    ISSUER_LITHIC_SANDBOX,
                    &[3; 32],
                    PREFUND_LAMPORTS,
                ),
                delegate_card(&owner, &card_id),
            ],
            [9; 32],
        );
        assert_ne!(decode_message(&want.message), decode_message(&more.message));
        assert_ne!(
            decode_message(&want.message),
            decode_message(&extra.message)
        );
    }

    const IDL: &str = include_str!("../../../../programs/card_policy/idl/card_policy.json");

    fn idl() -> serde_json::Value {
        serde_json::from_str(IDL).unwrap()
    }

    #[test]
    fn discriminators_match_the_deployed_idl() {
        let idl = idl();
        for ix in idl["instructions"].as_array().unwrap() {
            let name = ix["name"].as_str().unwrap();
            let expected: Vec<u8> = serde_json::from_value(ix["discriminator"].clone()).unwrap();
            assert_eq!(disc(name).to_vec(), expected, "{name}");
        }
        for account in idl["accounts"].as_array().unwrap() {
            let name = account["name"].as_str().unwrap();
            let expected: Vec<u8> =
                serde_json::from_value(account["discriminator"].clone()).unwrap();
            assert_eq!(account_disc(name).to_vec(), expected, "{name}");
        }
        assert_eq!(idl["address"], CARD_POLICY_PROGRAM_ID);
    }

    #[test]
    fn account_lists_match_the_idl_for_every_instruction_axum_sends() {
        let idl = idl();
        let find = |name: &str| {
            idl["instructions"]
                .as_array()
                .unwrap()
                .iter()
                .find(|ix| ix["name"] == name)
                .unwrap()["accounts"]
                .as_array()
                .unwrap()
                .clone()
        };
        let a = Address::from([1; 32]);
        let policy = Address::from([2; 32]);
        let period = Address::from([3; 32]);
        let res = Address::from([4; 32]);
        let accounts = CardAccounts::derive(&Address::from([7; 32]), &[9; 32]);
        let intent = IntentArgs {
            intent_id: [1; 16],
            agent: [2; 32],
            merchant_id_hash: [3; 32],
            mcc: 0,
            max_amount_cents: 1,
            expires_at: 1,
        };
        let auth = AuthorizeArgs {
            auth_id_hash: [5; 32],
            intent_id: [1; 16],
            amount_cents: 1,
            merchant_id_hash: [3; 32],
            mcc: 0,
            merchant_initiated: false,
            single_message: false,
        };
        let cases = vec![
            (
                "open_checkout_intent",
                open_checkout_intent(&a, &policy, &period, &intent),
            ),
            ("authorize", authorize(&a, &policy, &period, &auth)),
            ("capture", capture(&a, &policy, &period, &res, 1, &[1; 32])),
            (
                "reverse",
                reverse(&a, &policy, &period, &res, 1, 0, &[1; 32]),
            ),
            ("refund", refund(&a, &policy, &period, None, 1, &[1; 32])),
            (
                "record_dispute",
                record_dispute(&a, &policy, &period, &res, 1, &[1; 32]),
            ),
            (
                "record_exception",
                record_exception(&a, &policy, &period, None, 1, 1, &[1; 32]),
            ),
            (
                "adjust_reservation",
                adjust_reservation(&a, &policy, &period, &res, 1),
            ),
            ("freeze", freeze(&a, &policy, &period, 2)),
            ("recovery_freeze", recovery_freeze(&a, &policy, &period, 3)),
            ("unfreeze", unfreeze(&a, &policy, &period)),
            (
                "close_checkout_intent",
                close_checkout_intent(&a, &policy, &res),
            ),
            ("checkpoint", checkpoint(&a, &accounts, &[1; 32], 1)),
            ("roll_period", roll_period(&a, &policy, &period, &[])),
            (
                "record_repayment",
                record_repayment(&a, &policy, &period, &[1; 32], 1),
            ),
            (
                "confirm_reconciled",
                confirm_reconciled(&a, &policy, &period, &[1; 32]),
            ),
            ("init_card", init_card(&a, &[9; 32], 1, &[1; 32], 1)),
            ("delegate_card", delegate_card(&a, &[9; 32])),
            (
                "init_permission",
                init_permission(&a, &policy, &period, &res),
            ),
            (
                "set_policy",
                set_policy(
                    &a,
                    &policy,
                    &period,
                    &PolicyArgs {
                        budget_cents: 1,
                        max_purchase_cents: 1,
                        max_purchases_per_period: 0,
                        period_seconds: 86_400,
                        merchant_id_hashes: vec![[1; 32]],
                        mccs: vec![],
                        expires_at: 0,
                        recurring_allowed: false,
                        fee_bps: 0,
                        authorizer: [4; 32],
                    },
                ),
            ),
        ];
        for (name, instruction) in cases {
            let expected = find(name);
            assert_eq!(
                instruction.accounts.len(),
                expected.len(),
                "{name} account count"
            );
            for (meta, spec) in instruction.accounts.iter().zip(expected) {
                let label = format!("{name}.{}", spec["name"]);
                assert_eq!(
                    meta.is_signer,
                    spec["signer"].as_bool().unwrap_or(false),
                    "{label} signer"
                );
                if spec["optional"].as_bool() != Some(true) {
                    assert_eq!(
                        meta.is_writable,
                        spec["writable"].as_bool().unwrap_or(false),
                        "{label} writable"
                    );
                }
                if let Some(address) = spec["address"].as_str() {
                    assert_eq!(meta.pubkey.to_string(), address, "{label} address");
                }
            }
        }
    }

    #[test]
    fn pdas_match_the_live_devnet_card() {
        // evidence/program-devnet.md run 3: owner 3dh3…, binding DyMY…, policy 9sq4…
        let binding: Address = "DyMYRrmXkFAwyfM2k6hEtJCiKEnTmwpMUJeRGwvUriU"
            .parse()
            .unwrap();
        let program = program_id();
        assert_eq!(
            pda(&[b"card_policy", binding.as_ref()], &program).to_string(),
            "9sq4BbFRZPFrgnEgLXeiLDSfNwUBjsxMd1iTRaSurT2C"
        );
        assert_eq!(
            pda(&[b"card_period", binding.as_ref()], &program).to_string(),
            "93UjDJZeXWrfhzrRpo9NRUYHzDj9nTQkgNhf3NpgsZ3v"
        );
        assert_eq!(
            pda(&[b"card_commit", binding.as_ref()], &program).to_string(),
            "KJFhx2ue9ozRzz9vXKxrRmPqvctfEbj7VgHBJgCre21"
        );
        let policy: Address = "9sq4BbFRZPFrgnEgLXeiLDSfNwUBjsxMd1iTRaSurT2C"
            .parse()
            .unwrap();
        assert_eq!(
            pda(
                &[b"balance", policy.as_ref(), &[255]],
                &addr(DELEGATION_PROGRAM)
            )
            .to_string(),
            "2QNkhU4qHucysxrN8d8pgd4xoGeuUXvCB5STJqWXc97n"
        );
    }

    #[test]
    fn policy_decoder_reads_every_field_in_idl_order() {
        let mut data = account_disc("CardPolicy").to_vec();
        data.extend_from_slice(&[1; 32]);
        data.extend_from_slice(&[2; 32]);
        data.extend_from_slice(&[3; 32]);
        data.extend_from_slice(&7u32.to_le_bytes());
        data.extend_from_slice(&5_000u64.to_le_bytes());
        data.extend_from_slice(&4_000u64.to_le_bytes());
        data.extend_from_slice(&3u16.to_le_bytes());
        data.extend_from_slice(&86_400u32.to_le_bytes());
        data.extend_from_slice(b"USD");
        data.push(1);
        data.extend_from_slice(&[9; 32]);
        data.extend_from_slice(&[0; 32 * 7]);
        data.push(1);
        data.extend_from_slice(&5734u16.to_le_bytes());
        data.extend_from_slice(&[0; 30]);
        data.extend_from_slice(&0i64.to_le_bytes());
        data.push(0);
        data.extend_from_slice(&50u16.to_le_bytes());
        data.extend_from_slice(&[1, 1, 0]);
        data.extend_from_slice(&123u64.to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes());
        data.push(2);
        data.extend_from_slice(&[0; 32 * 6 + 6]);
        data.extend_from_slice(&[8; 32]);
        data.extend_from_slice(&11u64.to_le_bytes());
        data.extend_from_slice(&12u64.to_le_bytes());
        data.extend_from_slice(&[0; 300]);
        let policy = decode_policy(&data).unwrap();
        assert_eq!(policy.policy_version, 7);
        assert_eq!(policy.max_purchase_cents, 4_000);
        assert_eq!(policy.merchant_id_hashes, vec![[9; 32]]);
        assert_eq!(policy.mccs, vec![5734]);
        assert!(policy.frozen);
        assert_eq!(policy.statement_outstanding_cents, 123);
        assert_eq!(policy.ledger_seq, 11);
        assert_eq!(policy.commit_seq, 12);
        assert_eq!(decode_policy(&data[..40]), Err(DecodeError::Short));
    }

    #[test]
    fn error_table_matches_the_idl_and_maps_to_asa_results() {
        let idl = idl();
        for error in idl["errors"].as_array().unwrap() {
            let code = error["code"].as_u64().unwrap() as u32;
            assert_eq!(error_name(code), error["name"].as_str(), "{code}");
        }
        assert_eq!(asa_result_for(6016), "INSUFFICIENT_FUNDS");
        assert_eq!(asa_result_for(6004), "CARD_PAUSED");
        assert_eq!(asa_result_for(6010), "UNAUTHORIZED_MERCHANT");
        assert_eq!(asa_result_for(6017), "VELOCITY_EXCEEDED");
        assert_eq!(asa_result_for(6035), "SUSPECTED_FRAUD");
        assert_eq!(asa_result_for(9999), "SUSPECTED_FRAUD");
    }

    #[test]
    fn hashes_follow_the_contract_domains() {
        assert_eq!(
            merchant_id_hash("  demo-dataapi "),
            sha256(&[b"chainpay-merchant:v1\nDEMO-DATAAPI"])
        );
        assert_ne!(auth_id_hash(1, "t"), auth_id_hash(2, "t"));
        assert_eq!(unhex::<2>("0aff"), Some([10, 255]));
        assert_eq!(unhex::<2>("0afz"), None);
    }
}
