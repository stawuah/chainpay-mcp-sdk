//! LiteSVM tests for every program/state row of the PLAN test matrix.
//!
//! The MagicBlock magic program and permission program only exist inside the
//! ER validator, so these tests load a binary built with `--features
//! litesvm-mock` (see `er.rs`): ephemeral accounts become ordinary
//! program-owned PDAs and permission/Magic Action CPIs become no-ops. The
//! policy logic, account checks and state transitions are the deployed ones.
//! Privacy itself is proven live on Devnet (scripts/per-integration.ts).
//!
//! Repayment tests also load the real ChainPay program (the CPI target of
//! `repay_statement`), and the owner-permission test loads MagicBlock's
//! permission program as deployed on Devnet.
//!
//! Build first (`make card-policy-test` does all three):
//!   cargo build-sbf --features litesvm-mock --sbf-out-dir target/mock
//!   cargo build-sbf --manifest-path ../chainpay/Cargo.toml --sbf-out-dir target/chainpay
//!   solana program dump -u devnet ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1 target/permission/permission.so
//!   solana program dump -u devnet 3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4 target/chainpay-devnet/chainpay.so

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use card_policy::constants::*;
use card_policy::instructions::common::MIN_PREFUND;
use card_policy::instructions::{PermissionOp, RestoreArgs};
use card_policy::policy::{AuthorizeArgs, IntentArgs, PolicyArgs};
use card_policy::state::{
    reservation_state as rs, AuthGuard, CardBinding, CardCommitment, CardPeriod, CardPolicy,
    CheckoutIntent, Reservation,
};
use card_policy::{accounts, chainpay, instruction};
use ephemeral_rollups_sdk::access_control::structs::PERMISSION_SEED;
use ephemeral_rollups_sdk::consts::{EPHEMERAL_VAULT_ID, MAGIC_CONTEXT_ID, PERMISSION_PROGRAM_ID};
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;
use std::path::PathBuf;

const NOW: i64 = 1_800_000_000;
const DAY: i64 = 86_400;
const MOCK_PREFUND: u64 = 2_000_000_000;
const SYSTEM: Pubkey = anchor_lang::system_program::ID;
/// Pseudo error code: the transaction failed because the card prefund ran dry.
const PREFUND_EXHAUSTED: u32 = u32::MAX;

fn err_code(name: &str) -> u32 {
    // Mirrors CardPolicyError declaration order (codes from 6000, contracts.md §1.4).
    const NAMES: &[&str] = &[
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
        "InvalidRepaymentReceipt",
        "RepaymentRecipientMismatch",
        "RepaymentExceedsReceipt",
        "InvalidRepaymentMandate",
    ];
    6000 + NAMES.iter().position(|n| *n == name).expect("known error") as u32
}

fn merchant(n: u8) -> [u8; 32] {
    [n; 32]
}

fn hash(tag: &str, n: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    let bytes = tag.as_bytes();
    out[..bytes.len().min(24)].copy_from_slice(&bytes[..bytes.len().min(24)]);
    out[24..].copy_from_slice(&n.to_le_bytes());
    out
}

struct Card {
    svm: LiteSVM,
    owner: Keypair,
    authorizer: Keypair,
    stranger: Keypair,
    binding: Pubkey,
    policy: Pubkey,
    period: Pubkey,
    commitment: Pubkey,
    logs: Vec<String>,
    chainpay: Option<Repay>,
}

/// ChainPay accounts for repayment tests: a 6-decimal USD stablecoin, the
/// owner's funded source account, the partner's token account, and a mandate
/// whose approved agent is this card's repay agent PDA.
struct Repay {
    mint: Pubkey,
    source: Pubkey,
    partner: Pubkey,
    stranger_account: Pubkey,
    config: Pubkey,
    asset: Pubkey,
    mandate: Pubkey,
    nonce_seq: u8,
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &card_policy::ID).0
}

fn permission(account: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PERMISSION_SEED, account.as_ref()], &PERMISSION_PROGRAM_ID).0
}

impl Card {
    fn new() -> Self {
        Self::with_prefund(MOCK_PREFUND)
    }

    fn with_prefund(prefund_lamports: u64) -> Self {
        Self::with_programs(prefund_lamports, chainpay_so())
    }

    /// `chainpay` is the ChainPay binary `repay_statement` calls: this
    /// checkout's build, or the program deployed on Devnet.
    fn with_programs(prefund_lamports: u64, chainpay: PathBuf) -> Self {
        let mut svm = LiteSVM::new();
        let so = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/mock/card_policy.so");
        svm.add_program_from_file(card_policy::ID, &so)
            .expect("build the mock binary first: cargo build-sbf --features litesvm-mock --sbf-out-dir target/mock");
        svm.add_program_from_file(chainpay::ID, &chainpay).expect(
            "build ChainPay first (make card-policy-test builds it and dumps the Devnet binary)",
        );
        let owner = Keypair::new();
        let authorizer = Keypair::new();
        let stranger = Keypair::new();
        for k in [&owner, &authorizer, &stranger] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let card_id = [11u8; 32];
        let binding = pda(&[CARD_BINDING_SEED, owner.pubkey().as_ref(), &card_id]);
        let mut card = Card {
            policy: pda(&[CARD_POLICY_SEED, binding.as_ref()]),
            period: pda(&[CARD_PERIOD_SEED, binding.as_ref()]),
            commitment: pda(&[CARD_COMMITMENT_SEED, binding.as_ref()]),
            binding,
            svm,
            owner,
            authorizer,
            stranger,
            logs: vec![],
            chainpay: None,
        };
        card.set_clock(NOW);
        let ix = card.ix(
            accounts::InitCard {
                owner: card.owner.pubkey(),
                binding: card.binding,
                policy: card.policy,
                period: card.period,
                commitment: card.commitment,
                system_program: SYSTEM,
            },
            instruction::InitCard {
                card_id,
                issuer: ISSUER_CARD_SIM,
                issuer_card_ref_hash: [12u8; 32],
                // The mock pays base-layer rent for "ephemeral" accounts, which is
                // ~200x the ER rate MIN_PREFUND is sized for.
                prefund_lamports,
            },
        );
        card.send(ix, &[]).expect("init_card");
        card
    }

    /// A card with permissions and the default policy ($50 budget, $30 max).
    fn ready() -> Self {
        Self::ready_with(Self::new())
    }

    fn ready_with(mut card: Self) -> Self {
        let ix = card.init_permission_ix(card.authorizer.pubkey());
        card.send_as(ix, "owner").expect("init_permission");
        card.set_policy(card.default_policy()).expect("set_policy");
        card
    }

    fn set_clock(&mut self, unix_timestamp: i64) {
        let mut clock = self.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        clock.unix_timestamp = unix_timestamp;
        self.svm.set_sysvar(&clock);
    }

    fn ix<A: ToAccountMetas, D: InstructionData>(&self, accounts: A, data: D) -> Instruction {
        Instruction {
            program_id: card_policy::ID,
            accounts: accounts.to_account_metas(None),
            data: data.data(),
        }
    }

    fn signer(&self, who: &str) -> &Keypair {
        match who {
            "owner" => &self.owner,
            "authorizer" => &self.authorizer,
            _ => &self.stranger,
        }
    }

    fn send(&mut self, ix: Instruction, extra: &[&Keypair]) -> Result<(), u32> {
        let owner = self.owner.insecure_clone();
        let mut signers = vec![&owner];
        signers.extend_from_slice(extra);
        self.send_signed(vec![ix], &signers)
    }

    fn send_as(&mut self, ix: Instruction, who: &str) -> Result<(), u32> {
        let kp = self.signer(who).insecure_clone();
        self.send_signed(vec![ix], &[&kp])
    }

    fn send_signed(&mut self, ixs: Vec<Instruction>, signers: &[&Keypair]) -> Result<(), u32> {
        self.svm.expire_blockhash();
        let msg = Message::new(&ixs, Some(&signers[0].pubkey()));
        let tx = Transaction::new(signers, msg, self.svm.latest_blockhash());
        match self.svm.send_transaction(tx) {
            Ok(meta) => {
                self.logs.extend(meta.logs);
                Ok(())
            }
            Err(failed) => {
                self.logs.extend(failed.meta.logs.clone());
                match failed.err {
                    solana_transaction_error_code::TxErr::InstructionError(
                        _,
                        solana_transaction_error_code::IxErr::Custom(code),
                    ) => Err(code),
                    // The mock's sponsor (policy PDA) ran out of prefund.
                    solana_transaction_error_code::TxErr::InsufficientFundsForRent { .. } => {
                        Err(PREFUND_EXHAUSTED)
                    }
                    other => panic!("unexpected failure: {other:?} {:#?}", failed.meta.logs),
                }
            }
        }
    }

    fn get<T: AccountDeserialize>(&self, key: &Pubkey) -> T {
        let account = self.svm.get_account(key).expect("account exists");
        T::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn exists(&self, key: &Pubkey) -> bool {
        self.svm
            .get_account(key)
            .map(|a| !a.data.is_empty())
            .unwrap_or(false)
    }

    fn policy(&self) -> CardPolicy {
        self.get(&self.policy)
    }

    fn period(&self) -> CardPeriod {
        self.get(&self.period)
    }

    fn reservation(&self, auth: u64) -> Reservation {
        self.get(&self.reservation_key(auth))
    }

    fn reservation_key(&self, auth: u64) -> Pubkey {
        pda(&[RESERVATION_SEED, self.policy.as_ref(), &hash("auth", auth)])
    }

    fn guard_key(&self) -> Pubkey {
        pda(&[AUTH_GUARD_SEED, self.policy.as_ref()])
    }

    fn guard(&self) -> AuthGuard {
        let account = self
            .svm
            .get_account(&self.guard_key())
            .expect("guard exists");
        assert!(account
            .data
            .starts_with(&<AuthGuard as anchor_lang::Discriminator>::DISCRIMINATOR));
        *bytemuck::from_bytes::<AuthGuard>(&account.data[8..])
    }

    fn lamports(&self, key: &Pubkey) -> u64 {
        self.svm.get_account(key).map(|a| a.lamports).unwrap_or(0)
    }

    fn close_reservation_as(&mut self, auth: u64, who: &str) -> Result<(), u32> {
        let reservation = self.reservation_key(auth);
        let guard = self.guard_key();
        let ix = self.ix(
            accounts::CloseReservation {
                signer: self.signer(who).pubkey(),
                policy: self.policy,
                period: self.period,
                reservation,
                reservation_permission: permission(&reservation),
                auth_guard: guard,
                auth_guard_permission: permission(&guard),
                vault: EPHEMERAL_VAULT_ID,
                magic_program: SYSTEM,
                permission_program: PERMISSION_PROGRAM_ID,
            },
            instruction::CloseReservation {},
        );
        self.send_as(ix, who)
    }

    fn close_reservation(&mut self, auth: u64) -> Result<(), u32> {
        self.close_reservation_as(auth, "authorizer")
    }

    fn close_intent(&mut self, id: u8) -> Result<(), u32> {
        let intent = self.intent_key(id);
        let ix = self.ix(
            accounts::CloseCheckoutIntent {
                signer: self.authorizer.pubkey(),
                policy: self.policy,
                intent,
                intent_permission: permission(&intent),
                vault: EPHEMERAL_VAULT_ID,
                magic_program: SYSTEM,
                permission_program: PERMISSION_PROGRAM_ID,
            },
            instruction::CloseCheckoutIntent {},
        );
        self.send_as(ix, "authorizer")
    }

    fn intent_key(&self, id: u8) -> Pubkey {
        pda(&[INTENT_SEED, self.policy.as_ref(), &[id; 16]])
    }

    fn default_policy(&self) -> PolicyArgs {
        PolicyArgs {
            budget_cents: 5_000,
            max_purchase_cents: 3_000,
            max_purchases_per_period: 0,
            period_seconds: 30 * DAY as u32,
            currency: USD,
            merchant_id_hashes: vec![merchant(1), merchant(2)],
            mccs: vec![],
            expires_at: 0,
            recurring_allowed: false,
            fee_bps: 50,
            authorizer: self.authorizer.pubkey(),
        }
    }

    fn permissions_accounts(&self, signer: Pubkey) -> accounts::CardPermissions {
        accounts::CardPermissions {
            owner: signer,
            policy: self.policy,
            period: self.period,
            policy_permission: permission(&self.policy),
            period_permission: permission(&self.period),
            vault: EPHEMERAL_VAULT_ID,
            magic_program: SYSTEM,
            permission_program: PERMISSION_PROGRAM_ID,
        }
    }

    fn init_permission_ix(&self, authorizer: Pubkey) -> Instruction {
        self.ix(
            self.permissions_accounts(self.owner.pubkey()),
            instruction::InitPermission { authorizer },
        )
    }

    fn set_policy_as(&mut self, args: PolicyArgs, who: &str) -> Result<(), u32> {
        let signer = self.signer(who).pubkey();
        let ix = self.ix(
            self.permissions_accounts(signer),
            instruction::SetPolicy { args },
        );
        self.send_as(ix, who)
    }

    fn set_policy(&mut self, args: PolicyArgs) -> Result<(), u32> {
        self.set_policy_as(args, "owner")
    }

    /// Owner + a co-signer passed as the first remaining account (signer).
    fn set_policy_cosigned(&mut self, args: PolicyArgs, cosigner: &str) -> Result<(), u32> {
        let mut ix = self.ix(
            self.permissions_accounts(self.owner.pubkey()),
            instruction::SetPolicy { args },
        );
        let co = self.signer(cosigner).insecure_clone();
        ix.accounts
            .push(AccountMeta::new_readonly(co.pubkey(), true));
        let owner = self.owner.insecure_clone();
        self.send_signed(vec![ix], &[&owner, &co])
    }

    fn update_permission(&mut self, op: PermissionOp, who: &str) -> Result<(), u32> {
        let signer = self.signer(who).pubkey();
        let ix = self.ix(
            self.permissions_accounts(signer),
            instruction::UpdatePermission { op },
        );
        self.send_as(ix, who)
    }

    fn intent_args(&self, id: u8, merchant_n: u8, max: u64) -> IntentArgs {
        IntentArgs {
            intent_id: [id; 16],
            agent: Pubkey::new_from_array([77u8; 32]),
            merchant_id_hash: merchant(merchant_n),
            mcc: 0,
            max_amount_cents: max,
            currency: USD,
            expires_at: self.now() + 600,
        }
    }

    fn now(&self) -> i64 {
        self.svm
            .get_sysvar::<anchor_lang::prelude::Clock>()
            .unix_timestamp
    }

    fn open_intent_ix(&self, args: IntentArgs, who: Pubkey) -> Instruction {
        let intent = pda(&[INTENT_SEED, self.policy.as_ref(), &args.intent_id]);
        self.ix(
            accounts::OpenCheckoutIntent {
                authorizer: who,
                policy: self.policy,
                period: self.period,
                intent,
                intent_permission: permission(&intent),
                vault: EPHEMERAL_VAULT_ID,
                magic_program: SYSTEM,
                permission_program: PERMISSION_PROGRAM_ID,
            },
            instruction::OpenCheckoutIntent { args },
        )
    }

    fn open_intent(&mut self, id: u8, merchant_n: u8, max: u64) -> Result<(), u32> {
        let ix = self.open_intent_ix(
            self.intent_args(id, merchant_n, max),
            self.authorizer.pubkey(),
        );
        self.send_as(ix, "authorizer")
    }

    fn auth_args(&self, auth: u64, intent: u8, amount: u64) -> AuthorizeArgs {
        AuthorizeArgs {
            auth_id_hash: hash("auth", auth),
            intent_id: [intent; 16],
            amount_cents: amount,
            currency: USD,
            merchant_id_hash: merchant(1),
            mcc: 5734,
            merchant_initiated: false,
            single_message: false,
        }
    }

    fn authorize_ix(&self, args: AuthorizeArgs, who: Pubkey) -> Instruction {
        let intent = pda(&[INTENT_SEED, self.policy.as_ref(), &args.intent_id]);
        let reservation = pda(&[RESERVATION_SEED, self.policy.as_ref(), &args.auth_id_hash]);
        self.ix(
            accounts::Authorize {
                authorizer: who,
                policy: self.policy,
                period: self.period,
                intent,
                reservation,
                reservation_permission: permission(&reservation),
                vault: EPHEMERAL_VAULT_ID,
                magic_program: SYSTEM,
                permission_program: PERMISSION_PROGRAM_ID,
                auth_guard: self.guard_key(),
            },
            instruction::Authorize { args },
        )
    }

    fn authorize_with(&mut self, args: AuthorizeArgs) -> Result<(), u32> {
        let ix = self.authorize_ix(args, self.authorizer.pubkey());
        self.send_as(ix, "authorizer")
    }

    fn authorize(&mut self, auth: u64, intent: u8, amount: u64) -> Result<(), u32> {
        self.authorize_with(self.auth_args(auth, intent, amount))
    }

    /// Opens an intent for merchant 1 and authorizes against it.
    fn buy(&mut self, auth: u64, intent: u8, amount: u64) -> Result<(), u32> {
        self.open_intent(intent, 1, amount)?;
        self.authorize(auth, intent, amount)
    }

    fn res_accounts(&self, auth: u64) -> accounts::ReservationEvent {
        accounts::ReservationEvent {
            authorizer: self.authorizer.pubkey(),
            policy: self.policy,
            period: self.period,
            reservation: self.reservation_key(auth),
        }
    }

    fn card_event_accounts(&self, auth: Option<u64>) -> accounts::CardEvent {
        accounts::CardEvent {
            authorizer: self.authorizer.pubkey(),
            policy: self.policy,
            period: self.period,
            reservation: auth.map(|a| self.reservation_key(a)),
        }
    }

    fn capture(&mut self, auth: u64, amount: u64, capture: u64) -> Result<(), u32> {
        let ix = self.ix(
            self.res_accounts(auth),
            instruction::Capture {
                amount_cents: amount,
                capture_id_hash: hash("capture", capture),
            },
        );
        self.send_as(ix, "authorizer")
    }

    fn reverse(&mut self, auth: u64, amount: u64, reason: u8, event: u64) -> Result<(), u32> {
        let ix = self.ix(
            self.res_accounts(auth),
            instruction::Reverse {
                amount_cents: amount,
                reason,
                event_id_hash: hash("event", event),
            },
        );
        self.send_as(ix, "authorizer")
    }

    fn refund(&mut self, auth: Option<u64>, amount: u64, event: u64) -> Result<(), u32> {
        let ix = self.ix(
            self.card_event_accounts(auth),
            instruction::Refund {
                amount_cents: amount,
                event_id_hash: hash("event", event),
            },
        );
        self.send_as(ix, "authorizer")
    }

    fn exception(
        &mut self,
        auth: Option<u64>,
        kind: u8,
        amount: u64,
        event: u64,
    ) -> Result<(), u32> {
        let ix = self.ix(
            self.card_event_accounts(auth),
            instruction::RecordException {
                kind,
                amount_cents: amount,
                event_id_hash: hash("event", event),
            },
        );
        self.send_as(ix, "authorizer")
    }

    fn freeze_accounts(&self, who: &str) -> accounts::FreezeCard {
        accounts::FreezeCard {
            signer: self.signer(who).pubkey(),
            policy: self.policy,
            period: self.period,
        }
    }

    fn owner_accounts(&self, who: &str) -> accounts::OwnerCardEvent {
        accounts::OwnerCardEvent {
            owner: self.signer(who).pubkey(),
            policy: self.policy,
            period: self.period,
        }
    }

    fn freeze(&mut self, who: &str, reason: u8) -> Result<(), u32> {
        let ix = self.ix(self.freeze_accounts(who), instruction::Freeze { reason });
        self.send_as(ix, who)
    }

    fn unfreeze(&mut self, who: &str) -> Result<(), u32> {
        let ix = self.ix(self.owner_accounts(who), instruction::Unfreeze {});
        self.send_as(ix, who)
    }

    fn roll(&mut self, reservations: &[u64]) -> Result<(), u32> {
        let mut ix = self.ix(
            accounts::RollPeriod {
                authorizer: self.authorizer.pubkey(),
                policy: self.policy,
                period: self.period,
            },
            instruction::RollPeriod {},
        );
        for auth in reservations {
            ix.accounts
                .push(AccountMeta::new(self.reservation_key(*auth), false));
        }
        self.send_as(ix, "authorizer")
    }

    fn checkpoint(&mut self, seq: u64) -> Result<(), u32> {
        let ix = self.ix(
            accounts::Checkpoint {
                authorizer: self.authorizer.pubkey(),
                policy: self.policy,
                period: self.period,
                binding: self.binding,
                commitment: self.commitment,
                magic_context: MAGIC_CONTEXT_ID,
                magic_program: SYSTEM,
            },
            instruction::Checkpoint {
                master_salt: [5u8; 32],
                seq,
            },
        );
        self.send_as(ix, "authorizer")
    }
}

trait Bytes {
    fn try_to_vec_bytes(&self) -> Vec<u8>;
}

impl<T: anchor_lang::AnchorSerialize> Bytes for T {
    fn try_to_vec_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.serialize(&mut out).unwrap();
        out
    }
}

/// Minimal shim so the match above reads clearly.
mod solana_transaction_error_code {
    pub use solana_instruction::error::InstructionError as IxErr;
    pub use solana_transaction_error::TransactionError as TxErr;
}

// ============================================================ setup & policy

#[test]
fn init_card_publishes_only_zeroed_private_accounts() {
    let card = Card::new();
    let binding: CardBinding = card.get(&card.binding);
    assert_eq!(binding.owner, card.owner.pubkey());
    assert_eq!(binding.policy, card.policy);
    let policy = card.policy();
    assert_eq!(policy.binding, card.binding);
    assert_eq!(policy.owner, card.owner.pubkey());
    // Everything private is zero in the base snapshot: exactly the wiped shape.
    assert_eq!(
        policy.try_to_vec_bytes(),
        card_policy::instructions::zeroed_policy(card.binding, card.owner.pubkey(), policy.bump)
            .try_to_vec_bytes()
    );
    assert_eq!(policy.budget_cents, 0);
    assert_eq!(policy.member_count, 0);
    let period = card.period();
    assert_eq!(period.period_index, 0);
    let commitment: CardCommitment = card.get(&card.commitment);
    assert_eq!(commitment.seq, 0);
    assert!(card.svm.get_account(&card.policy).unwrap().lamports >= MIN_PREFUND);
    // Published in contracts.md (changelog) for the SDK; changes with account sizes.
    assert_eq!(MIN_PREFUND, 2_959_104);
}

#[test]
fn init_card_rejects_low_prefund_and_reuse() {
    let mut card = Card::new();
    // Reusing the same card_id fails because the binding PDA exists.
    let ix = card.ix(
        accounts::InitCard {
            owner: card.owner.pubkey(),
            binding: card.binding,
            policy: card.policy,
            period: card.period,
            commitment: card.commitment,
            system_program: SYSTEM,
        },
        instruction::InitCard {
            card_id: [11u8; 32],
            issuer: ISSUER_CARD_SIM,
            issuer_card_ref_hash: [12u8; 32],
            prefund_lamports: MIN_PREFUND,
        },
    );
    assert!(card.send(ix, &[]).is_err_and(|c| c == 0)); // system "already in use"
    let card_id = [13u8; 32];
    let binding = pda(&[CARD_BINDING_SEED, card.owner.pubkey().as_ref(), &card_id]);
    let ix = card.ix(
        accounts::InitCard {
            owner: card.owner.pubkey(),
            binding,
            policy: pda(&[CARD_POLICY_SEED, binding.as_ref()]),
            period: pda(&[CARD_PERIOD_SEED, binding.as_ref()]),
            commitment: pda(&[CARD_COMMITMENT_SEED, binding.as_ref()]),
            system_program: SYSTEM,
        },
        instruction::InitCard {
            card_id,
            issuer: ISSUER_CARD_SIM,
            issuer_card_ref_hash: [0u8; 32],
            prefund_lamports: MIN_PREFUND - 1,
        },
    );
    assert_eq!(card.send(ix, &[]), Err(err_code("PrefundTooLow")));
}

#[test]
fn set_policy_requires_permissions_and_opens_period_one() {
    let mut card = Card::new();
    assert_eq!(
        card.set_policy(card.default_policy()),
        Err(err_code("PermissionNotInitialized"))
    );
    let ix = card.init_permission_ix(card.authorizer.pubkey());
    card.send_as(ix, "owner").unwrap();
    // Idempotent for the same authorizer.
    let ix = card.init_permission_ix(card.authorizer.pubkey());
    card.send_as(ix, "owner").unwrap();
    card.set_policy(card.default_policy()).unwrap();
    let policy = card.policy();
    assert_eq!(policy.policy_version, 1);
    assert_eq!(policy.authorizer, card.authorizer.pubkey());
    assert_eq!(policy.member_count, 2);
    assert_eq!(policy.members[0], card.owner.pubkey());
    let period = card.period();
    assert_eq!(period.period_index, 1);
    assert_eq!(period.period_start, NOW);
    assert_eq!(period.period_end, NOW + 30 * DAY);
    assert!(policy.ledger_seq >= 2);
}

// ===================================================== Owner authority (matrix)

#[test]
fn only_the_owner_changes_policy_limits_permissions_or_unfreezes() {
    let mut card = Card::ready();
    let mut raised = card.default_policy();
    raised.budget_cents = 500_000;
    raised.max_purchase_cents = 500_000;
    for who in ["authorizer", "stranger"] {
        assert_eq!(
            card.set_policy_as(raised.clone(), who),
            Err(err_code("Unauthorized")),
            "{who}"
        );
        assert_eq!(
            card.update_permission(
                PermissionOp::AddReader {
                    pubkey: Pubkey::new_unique()
                },
                who
            ),
            Err(err_code("Unauthorized"))
        );
        assert_eq!(card.unfreeze(who), Err(err_code("Unauthorized")));
        let ix = card.ix(
            card.owner_accounts(who),
            instruction::ResolveException {
                event_id_hash: hash("event", 1),
                resolution: 1,
            },
        );
        assert_eq!(card.send_as(ix, who), Err(err_code("Unauthorized")));
    }
    // The authorizer can freeze only in the fail-safe direction.
    assert_eq!(
        card.freeze("authorizer", FREEZE_OWNER),
        Err(err_code("Unauthorized"))
    );
    assert_eq!(
        card.freeze("stranger", FREEZE_OWNER),
        Err(err_code("Unauthorized"))
    );
    card.freeze("authorizer", FREEZE_AUTHORIZER_SAFETY).unwrap();
    assert_eq!(card.unfreeze("authorizer"), Err(err_code("Unauthorized")));
    // The agent/stranger cannot open intents or authorize.
    let ix = card.open_intent_ix(card.intent_args(1, 1, 100), card.stranger.pubkey());
    assert_eq!(card.send_as(ix, "stranger"), Err(err_code("Unauthorized")));
    card.unfreeze("owner").unwrap();
    assert_eq!(card.policy().budget_cents, 5_000);
}

#[test]
fn authorizer_rotation_requires_a_frozen_card() {
    let mut card = Card::ready();
    let mut rotated = card.default_policy();
    rotated.authorizer = Pubkey::new_unique();
    assert_eq!(
        card.set_policy(rotated.clone()),
        Err(err_code("AuthorizerChangeRequiresFreeze"))
    );
    card.freeze("owner", FREEZE_OWNER).unwrap();
    card.set_policy_cosigned(rotated.clone(), "authorizer")
        .unwrap();
    let policy = card.policy();
    assert_eq!(policy.authorizer, rotated.authorizer);
    assert_eq!(policy.members[1], rotated.authorizer);
    assert_eq!(policy.policy_version, 2);
}

#[test]
fn permission_members_add_remove_and_limits() {
    let mut card = Card::ready();
    let readers: Vec<Pubkey> = (0..4).map(|_| Pubkey::new_unique()).collect();
    for r in &readers {
        card.update_permission(PermissionOp::AddReader { pubkey: *r }, "owner")
            .unwrap();
    }
    assert_eq!(card.policy().member_count, 6);
    assert_eq!(
        card.update_permission(
            PermissionOp::AddReader {
                pubkey: Pubkey::new_unique()
            },
            "owner"
        ),
        Err(err_code("MemberLimit"))
    );
    assert_eq!(
        card.update_permission(PermissionOp::AddReader { pubkey: readers[0] }, "owner"),
        Err(err_code("InvalidPolicy"))
    );
    assert_eq!(
        card.update_permission(
            PermissionOp::RemoveReader {
                pubkey: card.owner.pubkey()
            },
            "owner"
        ),
        Err(err_code("Unauthorized"))
    );
    assert_eq!(
        card.update_permission(
            PermissionOp::RemoveReader {
                pubkey: card.authorizer.pubkey()
            },
            "owner"
        ),
        Err(err_code("Unauthorized"))
    );
    assert_eq!(
        card.update_permission(
            PermissionOp::RemoveReader {
                pubkey: Pubkey::new_unique()
            },
            "owner"
        ),
        Err(err_code("MemberNotFound"))
    );
    card.update_permission(PermissionOp::RemoveReader { pubkey: readers[1] }, "owner")
        .unwrap();
    let policy = card.policy();
    assert_eq!(policy.member_count, 5);
    assert_eq!(&policy.members[2..5], &[readers[0], readers[2], readers[3]]);
    assert_eq!(
        policy.policy_version, 1,
        "permission edits never bump the policy version"
    );
}

// ================================================================= authorize

#[test]
fn authorize_approves_twenty_and_declines_forty_on_a_fifty_budget() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    let r = card.reservation(1);
    assert_eq!(r.state, rs::RESERVED);
    assert_eq!(r.amount_reserved_cents, 2_000);
    assert_eq!(card.period().reserved_cents, 2_000);
    assert_eq!(card.period().purchases_count, 1);
    let intent: CheckoutIntent = card.get(&card.intent_key(1));
    assert_eq!(intent.state, INTENT_CONSUMED);
    assert_eq!(intent.reservation, card.reservation_key(1));

    // $40 exceeds the $30 max already at intent time ...
    assert_eq!(
        card.open_intent(2, 1, 4_000),
        Err(err_code("AmountExceedsMax"))
    );
    // ... and a $30 purchase exceeds the $30 remaining budget only by cents later.
    card.open_intent(3, 1, 3_000).unwrap();
    assert_eq!(
        card.authorize(3, 3, 3_001),
        Err(err_code("AmountExceedsIntent"))
    );
    card.buy(4, 4, 3_000).unwrap();
    assert_eq!(card.period().reserved_cents, 5_000);
    assert_eq!(card.open_intent(5, 1, 1), Err(err_code("BudgetExceeded")));
}

#[test]
fn concurrency_two_auths_for_the_last_ten_dollars_approve_once() {
    let mut card = Card::ready();
    card.buy(1, 1, 3_000).unwrap();
    card.buy(2, 2, 1_000).unwrap(); // $10 left
    card.open_intent(3, 1, 1_000).unwrap();
    card.open_intent(4, 1, 1_000).unwrap();
    // Both land in the same slot; the ER serializes writes to the policy account.
    let slot = card.svm.get_sysvar::<anchor_lang::prelude::Clock>().slot;
    let a = card.authorize(3, 3, 1_000);
    let b = card.authorize(4, 4, 1_000);
    assert_eq!(
        card.svm.get_sysvar::<anchor_lang::prelude::Clock>().slot,
        slot
    );
    assert_eq!(a, Ok(()));
    assert_eq!(b, Err(err_code("BudgetExceeded")));
    assert!(card.exists(&card.reservation_key(3)));
    assert!(!card.exists(&card.reservation_key(4)));
    assert_eq!(card.period().reserved_cents, 5_000);
}

#[test]
fn replay_duplicate_auth_or_capture_never_counts_twice() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    // Same issuer auth id again, even with a fresh valid intent.
    card.open_intent(2, 1, 2_000).unwrap();
    assert_eq!(
        card.authorize(1, 2, 2_000),
        Err(err_code("DuplicateAuthorization"))
    );
    // Replaying against the consumed intent is also a duplicate, not IntentInvalid.
    assert_eq!(
        card.authorize(1, 1, 2_000),
        Err(err_code("DuplicateAuthorization"))
    );
    assert_eq!(card.period().reserved_cents, 2_000);
    assert_eq!(card.period().purchases_count, 1);

    card.capture(1, 1_500, 10).unwrap();
    assert_eq!(
        card.capture(1, 1_500, 10),
        Err(err_code("DuplicateCapture"))
    );
    let period = card.period();
    assert_eq!(period.captured_cents, 1_500);
    assert_eq!(period.reserved_cents, 500);
    assert_eq!(card.policy().statement_outstanding_cents, 1_507); // + floor(7.5)
}

#[test]
fn merchant_and_currency_binding() {
    let mut card = Card::ready();
    card.open_intent(1, 1, 2_000).unwrap();
    let mut other_merchant = card.auth_args(1, 1, 1_000);
    other_merchant.merchant_id_hash = merchant(2); // allowed by policy, not by this intent
    assert_eq!(
        card.authorize_with(other_merchant),
        Err(err_code("MerchantMismatch"))
    );
    let mut eur = card.auth_args(1, 1, 1_000);
    eur.currency = *b"EUR";
    assert_eq!(card.authorize_with(eur), Err(err_code("CurrencyMismatch")));
    // Intent for a merchant the policy does not allow cannot even be opened.
    assert_eq!(
        card.open_intent(2, 9, 1_000),
        Err(err_code("MerchantNotAllowed"))
    );
    // No intent at all.
    assert_eq!(card.authorize(3, 42, 1_000), Err(err_code("IntentInvalid")));
    // Intent expired.
    card.set_clock(NOW + 601);
    assert_eq!(card.authorize(1, 1, 1_000), Err(err_code("IntentExpired")));
    // Policy changed after the intent was opened.
    card.set_clock(NOW);
    card.open_intent(4, 1, 1_000).unwrap();
    card.set_policy(card.default_policy()).unwrap();
    assert_eq!(card.authorize(4, 4, 1_000), Err(err_code("IntentStale")));
    assert_eq!(card.period().reserved_cents, 0);
}

#[test]
fn mcc_velocity_recurring_and_expiry_rules() {
    let mut card = Card::ready();
    let mut p = card.default_policy();
    p.mccs = vec![5734];
    p.max_purchases_per_period = 1;
    p.expires_at = NOW + DAY;
    card.set_policy_cosigned(p, "authorizer").unwrap();
    card.open_intent(1, 1, 1_000).unwrap();
    let mut bad_mcc = card.auth_args(1, 1, 1_000);
    bad_mcc.mcc = 7995;
    assert_eq!(card.authorize_with(bad_mcc), Err(err_code("MccNotAllowed")));
    let mut recurring = card.auth_args(1, 1, 1_000);
    recurring.merchant_initiated = true;
    assert_eq!(
        card.authorize_with(recurring),
        Err(err_code("RecurringNotAllowed"))
    );
    card.authorize(1, 1, 1_000).unwrap();
    card.open_intent(2, 1, 1_000).unwrap();
    assert_eq!(
        card.authorize(2, 2, 1_000),
        Err(err_code("VelocityExceeded"))
    );
    card.set_clock(NOW + DAY);
    assert_eq!(
        card.open_intent(3, 1, 1_000),
        Err(err_code("PolicyExpired"))
    );
}

#[test]
fn cancel_checkout_intent_by_owner_or_authorizer() {
    let mut card = Card::ready();
    card.open_intent(1, 1, 1_000).unwrap();
    let ix = card.ix(
        accounts::CancelCheckoutIntent {
            signer: card.stranger.pubkey(),
            policy: card.policy,
            intent: card.intent_key(1),
        },
        instruction::CancelCheckoutIntent {},
    );
    assert_eq!(card.send_as(ix, "stranger"), Err(err_code("Unauthorized")));
    let ix = card.ix(
        accounts::CancelCheckoutIntent {
            signer: card.owner.pubkey(),
            policy: card.policy,
            intent: card.intent_key(1),
        },
        instruction::CancelCheckoutIntent {},
    );
    card.send_as(ix, "owner").unwrap();
    assert_eq!(card.authorize(1, 1, 1_000), Err(err_code("IntentInvalid")));
}

// ==================================================================== freeze

#[test]
fn freeze_declines_new_auths_but_issuer_events_still_post() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    card.open_intent(2, 1, 1_000).unwrap();
    card.freeze("owner", FREEZE_OWNER).unwrap();
    assert!(card.policy().frozen);
    assert_eq!(card.authorize(2, 2, 1_000), Err(err_code("CardFrozen")));
    assert_eq!(card.open_intent(3, 1, 1_000), Err(err_code("CardFrozen")));
    // Clearing for an existing hold is issuer truth and still posts.
    card.capture(1, 2_000, 1).unwrap();
    assert_eq!(card.reservation(1).state, rs::CAPTURED);
    // A captured reservation cannot be adjusted.
    let ix = card.ix(
        card.res_accounts(1),
        instruction::AdjustReservation {
            new_amount_cents: 2_500,
        },
    );
    assert_eq!(
        card.send_as(ix, "authorizer"),
        Err(err_code("ReservationClosed"))
    );
    card.unfreeze("owner").unwrap();
    card.authorize(2, 2, 1_000).unwrap();
}

#[test]
fn adjust_reservation_increase_must_fit_and_never_while_frozen() {
    let mut card = Card::ready();
    // The intent allows more than the first hold, so increases test the budget.
    card.open_intent(1, 1, 3_000).unwrap();
    card.authorize(1, 1, 2_000).unwrap();
    let adjust = |card: &mut Card, amount: u64| {
        let ix = card.ix(
            card.res_accounts(1),
            instruction::AdjustReservation {
                new_amount_cents: amount,
            },
        );
        card.send_as(ix, "authorizer")
    };
    adjust(&mut card, 1_500).unwrap();
    assert_eq!(card.period().reserved_cents, 1_500);
    card.buy(2, 2, 3_000).unwrap(); // $5 left
    assert_eq!(adjust(&mut card, 2_001), Err(err_code("BudgetExceeded")));
    adjust(&mut card, 2_000).unwrap();
    assert_eq!(card.period().reserved_cents, 5_000);
    card.freeze("owner", FREEZE_OWNER).unwrap();
    assert_eq!(adjust(&mut card, 2_100), Err(err_code("CardFrozen")));
    adjust(&mut card, 0).unwrap(); // decreases always allowed
    assert_eq!(card.reservation(1).state, rs::REVERSED);
    assert_eq!(
        card.period().reserved_cents,
        3_000,
        "only reservation 2 holds now"
    );
}

// ======================================================= lifecycle (matrix)

#[test]
fn lifecycle_states_stay_distinct() {
    let mut card = Card::ready();
    let mut p = card.default_policy();
    p.budget_cents = 20_000;
    p.max_purchase_cents = 5_000;
    card.set_policy_cosigned(p, "authorizer").unwrap();

    // Partial capture, then the rest of the hold is voided.
    card.buy(1, 1, 3_000).unwrap();
    card.capture(1, 1_000, 1).unwrap();
    assert_eq!(card.reservation(1).state, rs::PARTIALLY_CAPTURED);
    assert_eq!(card.reservation(1).amount_reserved_cents, 2_000);
    card.reverse(1, 2_000, 0, 1).unwrap();
    let r1 = card.reservation(1);
    assert_eq!(
        (r1.state, r1.captured_cents, r1.reversed_cents),
        // Money was captured, so the hold ends CAPTURED (review F5).
        (rs::CAPTURED, 1_000, 2_000)
    );

    // A clearing above what the hold kept: counted, flagged, never re-reserved.
    card.capture(1, 500, 2).unwrap();
    let r1 = card.reservation(1);
    assert_eq!(r1.state, rs::CAPTURED);
    assert_ne!(r1.flags & FLAG_OVER_CAPTURE, 0);
    assert_eq!(r1.amount_reserved_cents, 0);
    assert_eq!(card.period().reserved_cents, 0);

    // Expiry reversal, then a late capture: counted, flagged, never re-reserved.
    card.buy(2, 2, 1_000).unwrap();
    card.reverse(2, 1_000, 1, 2).unwrap();
    assert_eq!(card.reservation(2).state, rs::EXPIRED);
    assert_eq!(card.reverse(2, 1, 0, 3), Err(err_code("ReservationClosed")));
    card.capture(2, 300, 20).unwrap();
    let r2 = card.reservation(2);
    assert_eq!(r2.state, rs::EXPIRED);
    assert_ne!(r2.flags & FLAG_LATE_CAPTURE, 0);
    assert_eq!(card.period().reserved_cents, 0);

    // Full capture, refund, dispute.
    card.buy(3, 3, 2_000).unwrap();
    card.capture(3, 2_000, 3).unwrap();
    assert_eq!(card.reservation(3).state, rs::CAPTURED);
    let before = card.policy().statement_outstanding_cents;
    card.refund(Some(3), 2_000, 4).unwrap();
    assert_eq!(card.reservation(3).refunded_cents, 2_000);
    assert_eq!(card.reservation(3).state, rs::CAPTURED);
    assert_eq!(card.policy().statement_outstanding_cents, before - 2_010);
    let ix = card.ix(
        card.res_accounts(3),
        instruction::RecordDispute {
            state: 1,
            event_id_hash: hash("event", 5),
        },
    );
    card.send_as(ix, "authorizer").unwrap();
    assert_eq!(card.reservation(3).dispute_state, 1);
    assert_eq!(card.reservation(3).state, rs::CAPTURED);

    // Single-message auth is captured at authorization.
    card.open_intent(4, 1, 700).unwrap();
    let mut sms = card.auth_args(4, 4, 700);
    sms.single_message = true;
    card.authorize_with(sms).unwrap();
    assert_eq!(card.reservation(4).state, rs::CAPTURED);
    assert_ne!(card.reservation(4).flags & FLAG_SINGLE_MESSAGE, 0);

    // Refund does not restore the purchase allowance.
    let period = card.period();
    assert_eq!(period.captured_cents, 1_000 + 500 + 300 + 2_000 + 700);
    assert_eq!(period.refunded_cents, 2_000);
    assert_eq!(period.reserved_cents, 0);
}

#[test]
fn forced_capture_and_over_capture_are_flagged_never_approved() {
    let mut card = Card::ready();
    card.buy(1, 1, 1_000).unwrap();
    // Over-capture: 1_200 against a 1_000 hold.
    card.capture(1, 1_200, 1).unwrap();
    let r = card.reservation(1);
    assert_eq!(r.state, rs::CAPTURED);
    assert_ne!(r.flags & FLAG_OVER_CAPTURE, 0);
    assert_eq!(card.period().exception_cents, 200);
    assert_eq!(card.policy().exceptions_open, 1);

    // Force post with no authorization at all.
    card.exception(None, EXC_FORCED_CAPTURE, 900, 2).unwrap();
    let period = card.period();
    assert_eq!(period.captured_cents, 2_100);
    assert_eq!(period.exception_cents, 1_100);
    assert_eq!(
        period.purchases_count, 1,
        "a force post is never an approved purchase"
    );
    assert_eq!(card.policy().exceptions_open, 2);
    assert_eq!(card.policy().statement_outstanding_cents, 1_206 + 904);

    // Over-hold needs a reservation; credits reduce exposure.
    assert_eq!(
        card.exception(None, EXC_OVER_HOLD, 10, 3),
        Err(err_code("InvalidAccount"))
    );
    assert_eq!(
        card.exception(None, 9, 10, 3),
        Err(err_code("InvalidPolicy"))
    );
    card.exception(None, EXC_CORRECTION_CREDIT, 100, 4).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 1_206 + 904 - 100);

    // Unfreeze stays blocked until the owner reviews every exception.
    card.freeze("owner", FREEZE_OWNER).unwrap();
    assert_eq!(card.unfreeze("owner"), Err(err_code("ExceptionsOpen")));
    for event in [1u64, 2, 4] {
        let ix = card.ix(
            card.owner_accounts("owner"),
            instruction::ResolveException {
                event_id_hash: hash("event", event),
                resolution: 1,
            },
        );
        card.send_as(ix, "owner").unwrap();
    }
    let ix = card.ix(
        card.owner_accounts("owner"),
        instruction::ResolveException {
            event_id_hash: hash("event", 9),
            resolution: 1,
        },
    );
    assert_eq!(card.send_as(ix, "owner"), Err(err_code("NoOpenExceptions")));
    card.unfreeze("owner").unwrap();
}

// ====================================================== billing (matrix)

#[test]
fn rollover_resets_allowance_but_keeps_debt_and_holds() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    card.capture(1, 2_000, 1).unwrap();
    card.buy(2, 2, 1_500).unwrap(); // open hold
    card.buy(3, 3, 1_000).unwrap(); // hold that will expire
    let outstanding = card.policy().statement_outstanding_cents;
    assert_eq!(outstanding, 2_010);

    assert_eq!(card.roll(&[]), Err(err_code("PeriodNotEnded")));
    card.set_clock(NOW + 30 * DAY);
    // Both holds are past their 7-day TTL; only the ones passed in are expired.
    card.roll(&[3]).unwrap();
    let period = card.period();
    assert_eq!(period.period_index, 2);
    assert_eq!(period.captured_cents, 0);
    assert_eq!(period.purchases_count, 0);
    assert_eq!(period.refunded_cents, 0);
    assert_eq!(period.reserved_cents, 1_500, "open holds carry over");
    assert_eq!(card.reservation(3).state, rs::EXPIRED);
    assert_eq!(card.reservation(2).state, rs::RESERVED);
    assert_eq!(
        card.policy().statement_outstanding_cents,
        outstanding,
        "debt carries over"
    );
    // The new period's allowance counts the carried hold.
    assert_eq!(card.open_intent(9, 1, 3_000), Ok(()));
    assert_eq!(card.authorize(9, 9, 3_000), Ok(()));
    assert_eq!(card.period().reserved_cents, 4_500);
    // A carried hold that clears later posts against the new period.
    card.capture(2, 1_500, 2).unwrap();
    assert_eq!(card.period().captured_cents, 1_500);
    assert_eq!(card.period().reserved_cents, 3_000);
}

#[test]
fn roll_period_rejects_foreign_reservations() {
    let mut card = Card::ready();
    card.set_clock(NOW + 30 * DAY);
    let mut ix = card.ix(
        accounts::RollPeriod {
            authorizer: card.authorizer.pubkey(),
            policy: card.policy,
            period: card.period,
        },
        instruction::RollPeriod {},
    );
    ix.accounts.push(AccountMeta::new(card.binding, false));
    assert!(card.send_as(ix, "authorizer").is_err());
}

#[test]
fn repayment_reduces_exposure_once_per_statement() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    card.capture(1, 2_000, 1).unwrap();
    card.repay_statement(1, cents_to_units(2_010)).unwrap();
    assert_eq!(
        card.record_repayment("authorizer", 1, 2_011),
        Err(err_code("RepaymentExceedsReceipt"))
    );
    card.record_repayment("authorizer", 1, 2_010).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 0);
    assert_eq!(
        card.record_repayment("authorizer", 1, 1),
        Err(err_code("DuplicateRepayment"))
    );
    card.repay_statement(2, cents_to_units(1)).unwrap();
    assert_eq!(
        card.record_repayment("owner", 2, 1),
        Err(err_code("Unauthorized"))
    );
}

// ===================================================== recovery (matrix)

#[test]
fn recovery_freeze_blocks_everything_until_restore_and_reconcile() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    card.open_intent(2, 1, 1_000).unwrap();
    let ix = card.ix(
        card.freeze_accounts("authorizer"),
        instruction::RecoveryFreeze { reason: 1 },
    );
    card.send_as(ix, "authorizer").unwrap();
    let policy = card.policy();
    assert!(policy.frozen);
    assert_eq!(policy.recovery_state, RECOVERY_FROZEN);
    assert_eq!(card.authorize(2, 2, 1_000), Err(err_code("CardFrozen")));
    assert_eq!(card.unfreeze("owner"), Err(err_code("RecoveryFrozen")));
    assert_eq!(
        card.set_policy(card.default_policy()),
        Err(err_code("RecoveryFrozen"))
    );

    let confirm = |card: &mut Card, digest: [u8; 32]| {
        let ix = card.ix(
            card.owner_accounts("owner"),
            instruction::ConfirmReconciled {
                recon_digest: digest,
            },
        );
        card.send_as(ix, "owner")
    };
    assert_eq!(
        confirm(&mut card, [1u8; 32]),
        Err(err_code("NotInRecovery"))
    );

    let restore_args = RestoreArgs {
        policy: card.default_policy(),
        period_index: 1,
        captured_cents: 0,
        reserved_cents: 2_000,
        refunded_cents: 0,
        purchases_count: 1,
        exception_cents: 0,
        statement_outstanding_cents: 0,
        ledger_head: [3u8; 32],
        ledger_seq: 7,
        recon_digest: [4u8; 32],
    };
    let restore_ix = |card: &Card, co_signer: Pubkey| {
        card.ix(
            accounts::RestoreCard {
                owner: card.owner.pubkey(),
                authorizer: co_signer,
                policy: card.policy,
                period: card.period,
            },
            instruction::Restore {
                args: restore_args.clone(),
            },
        )
    };
    // The owner alone cannot rewrite counters or debt: a stranger co-signer fails.
    let (owner, stranger, authorizer) = (
        card.owner.insecure_clone(),
        card.stranger.insecure_clone(),
        card.authorizer.insecure_clone(),
    );
    let ix = restore_ix(&card, stranger.pubkey());
    assert_eq!(
        card.send_signed(vec![ix], &[&owner, &stranger]),
        Err(err_code("Unauthorized"))
    );
    let ix = restore_ix(&card, authorizer.pubkey());
    card.send_signed(vec![ix], &[&owner, &authorizer]).unwrap();
    let policy = card.policy();
    assert_eq!(policy.recovery_state, RECOVERY_RESTORED_PENDING);
    assert!(policy.frozen, "restore never resumes spending");
    assert_eq!(policy.ledger_seq, 8);
    assert_eq!(
        card.period().reserved_cents,
        2_000,
        "counters come from the report, never zeroed"
    );
    assert_eq!(card.unfreeze("owner"), Err(err_code("RecoveryFrozen")));
    let ix = restore_ix(&card, authorizer.pubkey());
    assert_eq!(
        card.send_signed(vec![ix], &[&owner, &authorizer]),
        Err(err_code("NotInRecovery"))
    );

    assert_eq!(
        confirm(&mut card, [9u8; 32]),
        Err(err_code("ReconDigestMismatch"))
    );
    confirm(&mut card, [4u8; 32]).unwrap();
    assert_eq!(card.policy().recovery_state, RECOVERY_NORMAL);
    assert!(
        card.policy().frozen,
        "still frozen until the owner unfreezes"
    );
    assert_eq!(card.authorize(2, 2, 1_000), Err(err_code("CardFrozen")));
    card.unfreeze("owner").unwrap();
    // Restore bumped the policy version, so the pre-loss intent is stale.
    assert_eq!(card.authorize(2, 2, 1_000), Err(err_code("IntentStale")));
}

// ================================================ commitment & close

#[test]
fn checkpoint_sequence_is_monotonic_and_write_commitment_needs_the_escrow_signer() {
    let mut card = Card::ready();
    assert_eq!(card.checkpoint(2), Err(err_code("StaleCommitment")));
    card.checkpoint(1).unwrap();
    assert_eq!(card.policy().commit_seq, 1);
    assert_eq!(card.checkpoint(1), Err(err_code("StaleCommitment")));
    card.checkpoint(2).unwrap();

    // Direct base-layer call without the delegation program's escrow signature.
    let escrow = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(
        &card.policy,
        ACTION_ESCROW_INDEX,
    );
    let ix = card.ix(
        accounts::WriteCommitment {
            commitment: card.commitment,
            binding: card.binding,
            source_program: card_policy::ID,
            escrow_auth: card.policy,
            escrow,
        },
        instruction::WriteCommitment {
            root: [1u8; 32],
            seq: 99,
            policy_version: 1,
            period_index: 1,
        },
    );
    let mut ix = ix;
    for meta in ix.accounts.iter_mut().filter(|m| m.pubkey == escrow) {
        meta.is_signer = false; // nobody but the delegation program can sign for it
    }
    assert_eq!(card.send_as(ix, "stranger"), Err(err_code("Unauthorized")));
    let commitment: CardCommitment = card.get(&card.commitment);
    assert_eq!(commitment.seq, 0);
}

#[test]
fn wipe_requires_frozen_no_holds_no_debt_then_close() {
    let mut card = Card::ready();
    card.buy(1, 1, 1_000).unwrap();
    card.open_intent(2, 1, 500).unwrap();
    let wipe_ix = |card: &Card| {
        let mut ix = card.ix(
            accounts::WipeCard {
                owner: card.owner.pubkey(),
                policy: card.policy,
                period: card.period,
                policy_permission: permission(&card.policy),
                period_permission: permission(&card.period),
                vault: EPHEMERAL_VAULT_ID,
                magic_context: MAGIC_CONTEXT_ID,
                magic_program: SYSTEM,
                permission_program: PERMISSION_PROGRAM_ID,
            },
            instruction::WipeCard {},
        );
        for eph in [
            card.reservation_key(1),
            card.intent_key(1),
            card.intent_key(2),
        ] {
            ix.accounts.push(AccountMeta::new(eph, false));
            ix.accounts.push(AccountMeta::new(permission(&eph), false));
        }
        ix
    };
    let ix = wipe_ix(&card);
    assert_eq!(card.send_as(ix, "owner"), Err(err_code("CardFrozen")));
    card.freeze("owner", FREEZE_OWNER).unwrap();
    let ix = wipe_ix(&card);
    assert_eq!(card.send_as(ix, "owner"), Err(err_code("OpenReservations")));
    card.capture(1, 1_000, 1).unwrap();
    let ix = wipe_ix(&card);
    assert_eq!(
        card.send_as(ix, "owner"),
        Err(err_code("OutstandingBalance"))
    );
    card.repay_statement(1, cents_to_units(1_005)).unwrap();
    card.record_repayment("authorizer", 1, 1_005).unwrap();

    let close_ix = |card: &Card| {
        card.ix(
            accounts::CloseCard {
                owner: card.owner.pubkey(),
                binding: card.binding,
                policy: card.policy,
                period: card.period,
            },
            instruction::CloseCard {},
        )
    };
    let ix = close_ix(&card);
    assert_eq!(card.send_as(ix, "owner"), Err(err_code("NotWiped")));

    let ix = wipe_ix(&card);
    card.send_as(ix, "owner").unwrap();
    assert!(!card.exists(&card.reservation_key(1)));
    assert!(!card.exists(&card.intent_key(2)));
    let policy = card.policy();
    assert_eq!(policy.budget_cents, 0);
    assert_eq!(policy.authorizer, Pubkey::default());
    assert_eq!(policy.binding, card.binding);

    let ix = close_ix(&card);
    card.send_as(ix, "owner").unwrap();
    assert!(!card.exists(&card.policy));
    let binding: CardBinding = card.get(&card.binding);
    assert_eq!(binding.status, BINDING_CLOSED);
    assert!(
        card.exists(&card.commitment),
        "the commitment stays for audit"
    );
}

// ============================================================ privacy hygiene

#[test]
fn program_logs_never_carry_policy_values() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_345).unwrap();
    card.capture(1, 1_234, 1).unwrap();
    let _ = card.authorize(1, 1, 2_345); // duplicate -> error path logs
    card.open_intent(2, 1, 2_000).unwrap();
    let _ = card.authorize(2, 2, 2_222); // AmountExceedsIntent error path
    card.freeze("owner", FREEZE_OWNER).unwrap();
    let _ = card.authorize(2, 2, 1_000);
    let secrets = ["5000", "3000", "2345", "1234", "2222", "2000", "2593"];
    for line in card
        .logs
        .iter()
        .filter(|l| l.starts_with("Program log:") || l.starts_with("Program data:"))
    {
        for s in secrets {
            assert!(!line.contains(s), "log leaks a policy value: {line}");
        }
        if let Some(rest) = line.strip_prefix("Program log: ") {
            assert!(
                rest.starts_with("Instruction: ") || rest.starts_with("AnchorError"),
                "unexpected program log: {line}"
            );
        }
    }
}

// ======================================================= review fixes (1A)

#[test]
fn retried_issuer_events_never_apply_twice() {
    let mut card = Card::ready();
    let mut p = card.default_policy();
    p.budget_cents = 20_000;
    p.max_purchase_cents = 5_000;
    card.set_policy_cosigned(p, "authorizer").unwrap();
    card.buy(1, 1, 3_000).unwrap();
    card.capture(1, 2_000, 1).unwrap();

    card.refund(Some(1), 500, 10).unwrap();
    let outstanding = card.policy().statement_outstanding_cents;
    assert_eq!(
        card.refund(Some(1), 500, 10),
        Err(err_code("DuplicateEvent"))
    );
    assert_eq!(card.policy().statement_outstanding_cents, outstanding);
    assert_eq!(card.period().refunded_cents, 500);

    card.reverse(1, 400, 0, 11).unwrap();
    assert_eq!(card.reverse(1, 400, 0, 11), Err(err_code("DuplicateEvent")));
    assert_eq!(card.reservation(1).amount_reserved_cents, 600);

    card.exception(None, EXC_FORCED_CAPTURE, 300, 12).unwrap();
    assert_eq!(
        card.exception(None, EXC_FORCED_CAPTURE, 300, 12),
        Err(err_code("DuplicateEvent"))
    );
    assert_eq!(card.policy().exceptions_open, 1);

    // Resolving uses its own domain, so the exception's id is accepted once.
    let resolve = |card: &mut Card| {
        let ix = card.ix(
            card.owner_accounts("owner"),
            instruction::ResolveException {
                event_id_hash: hash("event", 12),
                resolution: 1,
            },
        );
        card.send_as(ix, "owner")
    };
    resolve(&mut card).unwrap();
    assert_eq!(resolve(&mut card), Err(err_code("DuplicateEvent")));
    assert_eq!(card.policy().exceptions_open, 0);
}

#[test]
fn adjust_increase_respects_max_purchase_and_expiry() {
    let mut card = Card::ready();
    let mut p = card.default_policy();
    p.expires_at = NOW + DAY;
    card.set_policy_cosigned(p, "authorizer").unwrap();
    card.open_intent(1, 1, 3_000).unwrap();
    card.authorize(1, 1, 1_000).unwrap();
    let adjust = |card: &mut Card, amount: u64| {
        let ix = card.ix(
            card.res_accounts(1),
            instruction::AdjustReservation {
                new_amount_cents: amount,
            },
        );
        card.send_as(ix, "authorizer")
    };
    // Max purchase is 3_000 even though 4_000 of budget is free.
    assert_eq!(adjust(&mut card, 3_001), Err(err_code("AmountExceedsMax")));
    adjust(&mut card, 3_000).unwrap();
    adjust(&mut card, 1_000).unwrap();
    card.set_clock(NOW + DAY);
    assert_eq!(adjust(&mut card, 1_500), Err(err_code("PolicyExpired")));
    adjust(&mut card, 500).unwrap(); // decreases always apply
}

#[test]
fn close_checkout_intent_reclaims_used_or_expired_intents_only() {
    let mut card = Card::ready();
    card.buy(1, 1, 1_000).unwrap();
    card.open_intent(2, 1, 1_000).unwrap();
    assert_eq!(card.policy().ephemeral_count, 3);
    let close = |card: &mut Card, id: u8, who: &str| {
        let intent = card.intent_key(id);
        let ix = card.ix(
            accounts::CloseCheckoutIntent {
                signer: card.signer(who).pubkey(),
                policy: card.policy,
                intent,
                intent_permission: permission(&intent),
                vault: EPHEMERAL_VAULT_ID,
                magic_program: SYSTEM,
                permission_program: PERMISSION_PROGRAM_ID,
            },
            instruction::CloseCheckoutIntent {},
        );
        card.send_as(ix, who)
    };
    assert_eq!(
        close(&mut card, 2, "authorizer"),
        Err(err_code("IntentInvalid"))
    );
    assert_eq!(
        close(&mut card, 1, "stranger"),
        Err(err_code("Unauthorized"))
    );
    close(&mut card, 1, "authorizer").unwrap();
    assert!(!card.exists(&card.intent_key(1)));
    assert!(
        card.exists(&card.reservation_key(1)),
        "the reservation stays"
    );
    card.set_clock(NOW + 601);
    close(&mut card, 2, "owner").unwrap();
    assert_eq!(card.policy().ephemeral_count, 1);
}

#[test]
fn wipe_refuses_to_strand_ephemeral_accounts() {
    let mut card = Card::ready();
    card.open_intent(1, 1, 500).unwrap();
    card.open_intent(2, 1, 500).unwrap();
    card.freeze("owner", FREEZE_OWNER).unwrap();
    let mut ix = card.ix(
        accounts::WipeCard {
            owner: card.owner.pubkey(),
            policy: card.policy,
            period: card.period,
            policy_permission: permission(&card.policy),
            period_permission: permission(&card.period),
            vault: EPHEMERAL_VAULT_ID,
            magic_context: MAGIC_CONTEXT_ID,
            magic_program: SYSTEM,
            permission_program: PERMISSION_PROGRAM_ID,
        },
        instruction::WipeCard {},
    );
    let only_one = card.intent_key(1);
    ix.accounts.push(AccountMeta::new(only_one, false));
    ix.accounts
        .push(AccountMeta::new(permission(&only_one), false));
    assert_eq!(
        card.send_as(ix, "owner"),
        Err(err_code("EphemeralAccountsOpen"))
    );
    assert!(card.exists(&card.intent_key(1)), "failed wipe rolls back");
}

#[test]
fn update_permission_resyncs_passed_ephemeral_accounts() {
    let mut card = Card::ready();
    let reader = Pubkey::new_unique();
    card.update_permission(PermissionOp::AddReader { pubkey: reader }, "owner")
        .unwrap();
    card.buy(1, 1, 1_000).unwrap();
    let res = card.reservation_key(1);
    let mut ix = card.ix(
        card.permissions_accounts(card.owner.pubkey()),
        instruction::UpdatePermission {
            op: PermissionOp::RemoveReader { pubkey: reader },
        },
    );
    ix.accounts.push(AccountMeta::new(res, false));
    ix.accounts.push(AccountMeta::new(permission(&res), false));
    card.send_as(ix, "owner").unwrap();
    assert_eq!(card.policy().member_count, 2);

    // A foreign account in the sync list is rejected.
    let mut ix = card.ix(
        card.permissions_accounts(card.owner.pubkey()),
        instruction::UpdatePermission {
            op: PermissionOp::AddReader { pubkey: reader },
        },
    );
    ix.accounts.push(AccountMeta::new(card.binding, false));
    ix.accounts
        .push(AccountMeta::new(permission(&card.binding), false));
    assert!(card.send_as(ix, "owner").is_err());
}

// ------------------------------------------------ capacity: close_reservation

fn dispute(card: &mut Card, auth: u64, state: u8, event: u64) -> Result<(), u32> {
    let ix = card.ix(
        card.res_accounts(auth),
        instruction::RecordDispute {
            state,
            event_id_hash: hash("event", event),
        },
    );
    card.send_as(ix, "authorizer")
}

#[test]
fn close_reservation_needs_a_final_hold_and_returns_the_rent() {
    let mut card = Card::ready();
    card.buy(1, 1, 1_000).unwrap();
    // Open, then partially captured: not final.
    assert_eq!(
        card.close_reservation(1),
        Err(err_code("ReservationNotFinal"))
    );
    card.capture(1, 400, 1).unwrap();
    assert_eq!(card.reservation(1).state, rs::PARTIALLY_CAPTURED);
    assert_eq!(
        card.close_reservation(1),
        Err(err_code("ReservationNotFinal"))
    );
    card.capture(1, 600, 2).unwrap();
    assert_eq!(card.reservation(1).state, rs::CAPTURED);
    // An open dispute keeps it.
    dispute(&mut card, 1, 1, 10).unwrap();
    assert_eq!(
        card.close_reservation(1),
        Err(err_code("ReservationNotFinal"))
    );
    dispute(&mut card, 1, 2, 11).unwrap();
    // Only the owner or the authorizer.
    assert_eq!(
        card.close_reservation_as(1, "stranger"),
        Err(err_code("Unauthorized"))
    );
    // Only a Reservation of this card: an intent in its place is refused.
    let guard = card.guard_key();
    let intent = card.intent_key(1);
    let ix = card.ix(
        accounts::CloseReservation {
            signer: card.authorizer.pubkey(),
            policy: card.policy,
            period: card.period,
            reservation: intent,
            reservation_permission: permission(&intent),
            auth_guard: guard,
            auth_guard_permission: permission(&guard),
            vault: EPHEMERAL_VAULT_ID,
            magic_program: SYSTEM,
            permission_program: PERMISSION_PROGRAM_ID,
        },
        instruction::CloseReservation {},
    );
    assert_eq!(
        card.send_as(ix, "authorizer"),
        Err(err_code("InvalidAccount"))
    );

    let ledger_before = card.policy().ledger_seq;
    let r1 = card.reservation(1);
    card.close_reservation(1).unwrap();
    assert!(!card.exists(&card.reservation_key(1)));
    let guard = card.guard();
    assert_eq!(guard.closed_count, 1);
    assert_eq!(guard.recent[0], hash("auth", 1));
    assert_eq!(
        guard.closed_head,
        card_policy::instructions::closed_head(&[0u8; 32], &r1)
    );
    assert_eq!(card.policy().ledger_seq, ledger_before + 1);
    // Reservation closed (-1), guard created (+1); intent 1 still open.
    assert_eq!(card.policy().ephemeral_count, 2);
    // Period totals are unchanged by a close.
    assert_eq!(card.period().captured_cents, 1_000);
    assert_eq!(card.period().reserved_cents, 0);

    // With the guard in place, a close returns exactly the reservation's rent.
    card.buy(2, 2, 700).unwrap();
    card.reverse(2, 700, 0, 20).unwrap();
    assert_eq!(card.reservation(2).state, rs::REVERSED);
    let rent = card.lamports(&card.reservation_key(2));
    let before = card.lamports(&card.policy);
    card.close_owner_closes(2);
    assert_eq!(card.lamports(&card.policy), before + rent);
    assert_eq!(card.guard().closed_count, 2);

    // Expired holds (roll_period) close too.
    card.buy(3, 3, 500).unwrap();
    card.set_clock(NOW + 31 * DAY);
    card.roll(&[3]).unwrap();
    assert_eq!(card.reservation(3).state, rs::EXPIRED);
    card.close_reservation(3).unwrap();
    assert_eq!(card.guard().closed_count, 3);
}

impl Card {
    /// The owner may close a final hold as well.
    fn close_owner_closes(&mut self, auth: u64) {
        self.close_reservation_as(auth, "owner").unwrap();
    }
}

#[test]
fn a_replayed_auth_id_never_reserves_again_after_close() {
    let mut card = Card::ready();
    card.buy(1, 1, 1_000).unwrap();
    card.capture(1, 1_000, 1).unwrap();
    card.close_reservation(1).unwrap();
    card.close_intent(1).unwrap();
    let period = card.period();

    // A fresh, matching intent is open, yet the same issuer auth id is refused.
    card.open_intent(9, 1, 1_000).unwrap();
    assert_eq!(
        card.authorize(1, 9, 1_000),
        Err(err_code("DuplicateAuthorization"))
    );
    assert!(!card.exists(&card.reservation_key(1)));
    assert_eq!(card.period().try_to_vec_bytes(), period.try_to_vec_bytes());
    let intent: CheckoutIntent = card.get(&card.intent_key(9));
    assert_eq!(intent.state, INTENT_OPEN, "the intent is not consumed");
    // A new auth id on the same intent still works.
    card.authorize(2, 9, 1_000).unwrap();
}

#[test]
fn replay_window_is_exactly_guard_ring_later_closes() {
    let mut card = Card::ready();
    let mut policy = card.default_policy();
    policy.budget_cents = 1_000_000;
    card.set_policy_cosigned(policy, "authorizer").unwrap();
    let cycle = |card: &mut Card, auth: u64| {
        card.buy(auth, 1, 1).unwrap();
        card.capture(auth, 1, auth).unwrap();
        card.close_reservation(auth).unwrap();
        card.close_intent(1).unwrap();
    };
    cycle(&mut card, 1);
    // GUARD_RING - 1 later closes: auth 1 is still in the ring.
    for auth in 2..(GUARD_RING as u64 + 1) {
        cycle(&mut card, auth);
    }
    card.open_intent(1, 1, 1).unwrap();
    assert_eq!(
        card.authorize(1, 1, 1),
        Err(err_code("DuplicateAuthorization"))
    );
    card.close_intent_open(1);
    // The GUARD_RING-th later close evicts it: from here Axum's durable
    // operation claim (`card-asa:v1:<token>`) is the only guard left.
    cycle(&mut card, GUARD_RING as u64 + 1);
    assert!(!card.guard().contains(&hash("auth", 1)));
    assert!(card.guard().contains(&hash("auth", 2)));
}

impl Card {
    /// Close an open (unconsumed) intent by expiring it first.
    fn close_intent_open(&mut self, id: u8) {
        let now = self.now();
        self.set_clock(now + 601);
        self.close_intent(id).unwrap();
        self.set_clock(now);
    }
}

/// The capacity soak: >1,000 authorizations on one card whose prefund covers
/// only a handful of open holds at a time. Without closes the same card runs
/// dry within that handful.
#[test]
fn soak_1100_authorizations_on_one_card_without_running_out() {
    let probe = Card::new();
    let rent = |len: usize| probe.svm.minimum_balance_for_rent_exemption(len);
    let res_len = card_policy::instructions::common::RESERVATION_LEN;
    let intent_len = card_policy::instructions::common::INTENT_LEN;
    let guard_len = card_policy::instructions::common::AUTH_GUARD_LEN;
    // Base-rent prefund for the guard plus 4 open (intent + reservation) pairs.
    let per_auth = rent(res_len) + rent(intent_len);
    let prefund = MIN_PREFUND.max(rent(guard_len) + 4 * per_auth + rent(guard_len) / 2);
    drop(probe);

    // Control: no closes. The card stops after a few authorizations.
    let mut control = Card::ready_with(Card::with_prefund(prefund));
    let mut approved = 0u64;
    for auth in 0..64u64 {
        let id = 1 + (auth % 200) as u8;
        if control.open_intent(id, 1, 1).is_err() || control.authorize(auth, id, 1).is_err() {
            break;
        }
        approved += 1;
    }
    // Every un-closed authorization keeps an intent + reservation funded, so the
    // control can never get past prefund / per-auth rent.
    assert!(
        approved <= prefund / per_auth && approved < 32,
        "control card approved {approved}"
    );
    println!("soak control: prefund {prefund} lamports, {approved} authorizations without closes");

    // With closes: 1,100 full cycles, all approved, prefund steady.
    let mut card = Card::ready_with(Card::with_prefund(prefund));
    let mut policy = card.default_policy();
    policy.budget_cents = 1_000_000;
    card.set_policy_cosigned(policy, "authorizer").unwrap();
    let mut steady = None;
    for auth in 0..1_100u64 {
        let id = 1 + (auth % 200) as u8;
        card.open_intent(id, 1, 1)
            .unwrap_or_else(|code| panic!("intent for {auth} failed with {code}"));
        card.authorize(auth, id, 1)
            .unwrap_or_else(|code| panic!("authorization {auth} failed with {code}"));
        card.close_intent(id).unwrap();
        card.capture(auth, 1, auth).unwrap();
        card.close_reservation(auth).unwrap();
        let lamports = card.lamports(&card.policy);
        match steady {
            None => steady = Some(lamports),
            Some(expected) => assert_eq!(lamports, expected, "prefund drifted at {auth}"),
        }
        // A replay of any auth id still in the window is refused.
        if auth % 97 == 0 && auth > 0 {
            card.open_intent(250, 1, 1).unwrap();
            assert_eq!(
                card.authorize(auth - 1, 250, 1),
                Err(err_code("DuplicateAuthorization"))
            );
            card.close_intent_open(250);
        }
    }
    assert_eq!(card.period().purchases_count, 1_100);
    assert_eq!(card.period().captured_cents, 1_100);
    assert_eq!(card.guard().closed_count, 1_100);
    assert_eq!(card.policy().ephemeral_count, 1, "only the guard stays");
    println!(
        "soak: 1100 authorizations approved and closed on one card, prefund steady at {} lamports",
        steady.unwrap()
    );
}

#[test]
fn wipe_closes_the_guard_with_the_other_ephemeral_accounts() {
    let mut card = Card::ready();
    card.buy(1, 1, 1_000).unwrap();
    card.reverse(1, 1_000, 0, 1).unwrap();
    card.close_reservation(1).unwrap();
    card.close_intent(1).unwrap();
    assert_eq!(card.policy().ephemeral_count, 1);
    card.freeze("owner", FREEZE_OWNER).unwrap();
    let mut ix = card.ix(
        accounts::WipeCard {
            owner: card.owner.pubkey(),
            policy: card.policy,
            period: card.period,
            policy_permission: permission(&card.policy),
            period_permission: permission(&card.period),
            vault: EPHEMERAL_VAULT_ID,
            magic_context: MAGIC_CONTEXT_ID,
            magic_program: SYSTEM,
            permission_program: PERMISSION_PROGRAM_ID,
        },
        instruction::WipeCard {},
    );
    let guard = card.guard_key();
    ix.accounts.push(AccountMeta::new(guard, false));
    ix.accounts
        .push(AccountMeta::new(permission(&guard), false));
    card.send_as(ix, "owner").unwrap();
    assert!(!card.exists(&guard));
}

#[test]
fn late_capture_after_close_counts_without_review_and_needs_no_reservation() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    card.reverse(1, 2_000, 1, 1).unwrap();
    card.close_reservation(1).unwrap();
    let exposure = card.policy().statement_outstanding_cents;
    card.exception(None, EXC_LATE_CAPTURE, 2_000, 2).unwrap();
    assert_eq!(card.period().captured_cents, 2_000);
    assert_eq!(card.period().exception_cents, 0);
    assert_eq!(card.policy().exceptions_open, 0, "no owner review");
    assert_eq!(
        card.policy().statement_outstanding_cents,
        exposure + 2_000 + 10,
        "spend plus the 0.5% fee"
    );
    // Retried: deduped like every issuer event.
    assert_eq!(
        card.exception(None, EXC_LATE_CAPTURE, 2_000, 2),
        Err(err_code("DuplicateEvent"))
    );
    // Never against a live Reservation (that takes `capture`).
    card.buy(3, 3, 500).unwrap();
    assert_eq!(
        card.exception(Some(3), EXC_LATE_CAPTURE, 500, 4),
        Err(err_code("InvalidAccount"))
    );
}

// ======================================================= review fixes (2026-10-04)

fn repay_as(card: &mut Card, who: &str, digest: u64, amount: u64) -> Result<(), u32> {
    card.repay_statement(digest, cents_to_units(amount))?;
    card.record_repayment(who, digest, amount)
}

/// Review F1 / X4: the owner alone can't install a second wallet as authorizer
/// (nor set its own fee or credit line) and then erase its debt.
#[test]
fn owner_alone_cannot_change_authorizer_fee_or_credit_terms() {
    let mut card = Card::ready();
    card.buy(1, 1, 3_000).unwrap();
    card.capture(1, 3_000, 1).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 3_015);
    card.freeze("owner", FREEZE_OWNER).unwrap();

    let base = card.default_policy();
    let mut rotated = base.clone();
    rotated.authorizer = card.stranger.pubkey(); // a second wallet the owner holds
    let mut zero_fee = base.clone();
    zero_fee.fee_bps = 0;
    let mut bigger = base.clone();
    bigger.budget_cents = MAX_BUDGET_CENTS;
    let mut faster = base.clone();
    faster.period_seconds = DAY as u32;
    for args in [&rotated, &zero_fee, &bigger, &faster] {
        assert_eq!(
            card.set_policy(args.clone()),
            Err(err_code("CoSignerRequired"))
        );
        // A co-signature from anyone but the current authorizer doesn't count.
        assert_eq!(
            card.set_policy_cosigned(args.clone(), "stranger"),
            Err(err_code("CoSignerRequired"))
        );
    }
    card.unfreeze("owner").unwrap();
    assert_eq!(card.policy().authorizer, card.authorizer.pubkey());
    assert_eq!(
        repay_as(&mut card, "stranger", 99, 3_015),
        Err(err_code("Unauthorized"))
    );
    assert_eq!(card.policy().statement_outstanding_cents, 3_015);

    // With ChainPay's current authorizer co-signing, the same changes apply.
    card.freeze("owner", FREEZE_OWNER).unwrap();
    card.set_policy_cosigned(rotated, "authorizer").unwrap();
    assert_eq!(card.policy().authorizer, card.stranger.pubkey());
}

/// Review F1: rules that only tighten (lower budget, smaller cap) stay
/// owner-only, but the budget never drops below what the period committed.
#[test]
fn owner_can_tighten_alone_but_not_below_committed_spend() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    card.capture(1, 1_500, 1).unwrap(); // 1500 captured, 500 held
    let mut lower = card.default_policy();
    lower.budget_cents = 1_999;
    lower.max_purchase_cents = 1_000;
    assert_eq!(
        card.set_policy(lower.clone()),
        Err(err_code("BudgetBelowCommitted"))
    );
    lower.budget_cents = 2_000;
    card.set_policy(lower).unwrap();
    assert_eq!(card.policy().budget_cents, 2_000);
}

/// Review F2 / X6: refunds are capped at captured - refunded per hold, and
/// split refunds never credit more than one refund of the same total.
#[test]
fn refunds_are_capped_per_hold_and_split_refunds_never_overcredit() {
    let mut card = Card::ready(); // fee_bps = 50
    card.buy(1, 1, 200).unwrap();
    card.capture(1, 200, 1).unwrap(); // 200 + floor(1.0) = 201
    card.buy(2, 2, 2_000).unwrap();
    card.capture(2, 2_000, 2).unwrap(); // 2000 + 10
    assert_eq!(card.policy().statement_outstanding_cents, 2_211);
    for i in 0..20u64 {
        card.refund(Some(1), 10, 10_000 + i).unwrap();
    }
    // One $2.00 refund would credit 201; twenty 10c pieces credit 200.
    assert_eq!(card.policy().statement_outstanding_cents, 2_011);
    assert_eq!(
        card.refund(Some(1), 1, 50_000),
        Err(err_code("RefundExceedsCapture"))
    );
    assert_eq!(
        card.refund(Some(2), 1_000_000, 50_001),
        Err(err_code("RefundExceedsCapture"))
    );
    card.refund(Some(2), 2_000, 50_002).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 1);
    assert_eq!(card.reservation(1).refunded_cents, 200);
}

/// Review F3: every capture id of a hold is kept, so a retry can't double
/// count; a capture past the ring is refused rather than evicting an id.
#[test]
fn capture_ids_are_never_evicted_so_a_retry_never_double_counts() {
    let mut card = Card::ready();
    card.buy(1, 1, 3_000).unwrap();
    for c in 1..=CAPTURE_RING as u64 {
        card.capture(1, 100, c).unwrap();
    }
    assert_eq!(
        card.capture(1, 100, CAPTURE_RING as u64 + 1),
        Err(err_code("CaptureLimit"))
    );
    assert_eq!(card.capture(1, 100, 1), Err(err_code("DuplicateCapture")));
    assert_eq!(card.period().captured_cents, 100 * CAPTURE_RING as u64);
}

/// Review F4: an incremental hold can't grow past the intent the agent was
/// approved for (Axum books the excess as `over_hold`).
#[test]
fn adjust_reservation_never_exceeds_the_checkout_intent() {
    let mut card = Card::ready();
    card.open_intent(1, 1, 1_000).unwrap();
    card.authorize(1, 1, 800).unwrap();
    assert_eq!(card.reservation(1).max_amount_cents, 1_000);
    let adjust = |card: &mut Card, amount: u64| {
        let ix = card.ix(
            card.res_accounts(1),
            instruction::AdjustReservation {
                new_amount_cents: amount,
            },
        );
        card.send_as(ix, "authorizer")
    };
    assert_eq!(adjust(&mut card, 3_000), Err(err_code("AmountExceedsMax")));
    adjust(&mut card, 1_000).unwrap();
    assert_eq!(card.reservation(1).amount_reserved_cents, 1_000);
}

/// Review F5: releasing the rest of a partly captured hold ends CAPTURED.
#[test]
fn reversing_the_rest_of_a_partly_captured_hold_ends_captured() {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    card.capture(1, 1_500, 1).unwrap();
    card.reverse(1, 500, 0, 1).unwrap();
    let r = card.reservation(1);
    assert_eq!(
        (r.state, r.captured_cents, r.reversed_cents),
        (rs::CAPTURED, 1_500, 500)
    );
    card.buy(2, 2, 1_000).unwrap();
    card.reverse(2, 1_000, 1, 2).unwrap();
    assert_eq!(card.reservation(2).state, rs::EXPIRED);
}

/// Review X1 / X4: issuer debits without a hold (forced, late, unpaired) are
/// billed only while they fit the budget, so the owner never owes more than
/// budget + fee(budget) per period, whoever signs as authorizer.
#[test]
fn debits_without_a_hold_never_push_billed_spend_past_the_budget() {
    let mut card = Card::ready(); // $50 budget, 50 bps
    card.buy(1, 1, 3_000).unwrap();
    card.capture(1, 3_000, 1).unwrap();
    card.exception(None, EXC_FORCED_CAPTURE, 2_000, 1).unwrap(); // fits exactly
    for (n, kind) in [
        EXC_FORCED_CAPTURE,
        EXC_UNPAIRED_CAPTURE,
        EXC_LATE_CAPTURE,
        EXC_CORRECTION_DEBIT,
        EXC_RETURN_REVERSAL,
    ]
    .into_iter()
    .enumerate()
    {
        assert_eq!(
            card.exception(None, kind, 3_000, 10 + n as u64),
            Err(err_code("BudgetExceeded")),
            "kind {kind}"
        );
    }
    assert_eq!(card.period().captured_cents, 5_000);
    let max_owed = 5_000 + 25; // budget + fee(budget)
    assert_eq!(card.policy().statement_outstanding_cents, max_owed);
    // A capture above its hold is held to the same ceiling.
    let mut card = Card::ready();
    card.buy(1, 1, 3_000).unwrap();
    assert_eq!(card.capture(1, 6_000, 1), Err(err_code("BudgetExceeded")));
    card.capture(1, 5_000, 1).unwrap(); // 2000 over the hold, still in budget
    assert!(card.policy().statement_outstanding_cents <= max_owed);
}

// ============================================ repayment through ChainPay (CPI)

const DECIMALS: u8 = 6;
const SPL_TOKEN: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const MINT_SPACE: u64 = 82;
const TOKEN_ACCOUNT_SPACE: u64 = 165;
/// 1,000 USDC in the owner's source account.
const SOURCE_BALANCE: u64 = 1_000_000_000;

fn cents_to_units(cents: u64) -> u64 {
    cents * 10u64.pow(DECIMALS as u32 - 2)
}

fn chainpay_so() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/chainpay/chainpay.so")
}

/// ChainPay as deployed on Devnet (`3H9TV…`, dumped by `make card-policy-test`).
/// It still writes the 282-byte v1 receipt; this checkout's build writes 371.
fn chainpay_devnet_so() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/chainpay-devnet/chainpay.so")
}

/// Both ChainPay binaries `repay_statement` may call, with the receipt size each creates.
fn chainpay_binaries() -> [(PathBuf, usize); 2] {
    [
        (chainpay_so(), CHAINPAY_RECEIPT_SPACE),
        (chainpay_devnet_so(), CHAINPAY_RECEIPT_SPACE_V1),
    ]
}

fn chainpay_ix<A: ToAccountMetas, D: InstructionData>(accounts: A, data: D) -> Instruction {
    Instruction {
        program_id: chainpay::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

fn system_create(
    from: &Pubkey,
    to: &Pubkey,
    lamports: u64,
    space: u64,
    owner: &Pubkey,
) -> Instruction {
    let mut data = 0u32.to_le_bytes().to_vec();
    data.extend_from_slice(&lamports.to_le_bytes());
    data.extend_from_slice(&space.to_le_bytes());
    data.extend_from_slice(owner.as_ref());
    Instruction {
        program_id: SYSTEM,
        accounts: vec![AccountMeta::new(*from, true), AccountMeta::new(*to, true)],
        data,
    }
}

fn token_ix(accounts: Vec<AccountMeta>, data: Vec<u8>) -> Instruction {
    Instruction {
        program_id: SPL_TOKEN,
        accounts,
        data,
    }
}

fn mandate_nonce(seq: u8) -> Pubkey {
    let mut bytes = [0u8; 32];
    bytes[..8].copy_from_slice(b"CPNONCE!");
    bytes[8] = seq;
    Pubkey::new_from_array(bytes)
}

fn token_amount(card: &Card, account: &Pubkey) -> u64 {
    let data = card.svm.get_account(account).unwrap().data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

impl Card {
    fn repay_agent(&self) -> Pubkey {
        card_policy::instructions::repay_agent_address(&self.binding).0
    }

    /// Creates a funded token account owned by `owner` for the test mint.
    fn token_account(&mut self, owner: &Pubkey) -> Pubkey {
        let account = Keypair::new();
        let mint = self.chainpay.as_ref().unwrap().mint;
        let rent = self
            .svm
            .minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_SPACE as usize);
        let mut init = vec![18u8];
        init.extend_from_slice(owner.as_ref());
        let payer = self.owner.insecure_clone();
        self.send_signed(
            vec![
                system_create(
                    &payer.pubkey(),
                    &account.pubkey(),
                    rent,
                    TOKEN_ACCOUNT_SPACE,
                    &SPL_TOKEN,
                ),
                token_ix(
                    vec![
                        AccountMeta::new(account.pubkey(), false),
                        AccountMeta::new_readonly(mint, false),
                    ],
                    init,
                ),
            ],
            &[&payer, &account],
        )
        .expect("token account");
        account.pubkey()
    }

    /// ChainPay config, a registered 6-decimal mint, the owner's funded source
    /// account, the partner's account and the repayment mandate.
    fn with_chainpay(&mut self) -> &Repay {
        if self.chainpay.is_some() {
            return self.chainpay.as_ref().unwrap();
        }
        let admin = Keypair::new();
        self.svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();
        let mint = Keypair::new();
        let rent = self
            .svm
            .minimum_balance_for_rent_exemption(MINT_SPACE as usize);
        let mut init_mint = vec![20u8, DECIMALS];
        init_mint.extend_from_slice(admin.pubkey().as_ref());
        init_mint.push(0);
        self.send_signed(
            vec![
                system_create(
                    &admin.pubkey(),
                    &mint.pubkey(),
                    rent,
                    MINT_SPACE,
                    &SPL_TOKEN,
                ),
                token_ix(vec![AccountMeta::new(mint.pubkey(), false)], init_mint),
            ],
            &[&admin, &mint],
        )
        .expect("mint");
        let config = Pubkey::find_program_address(&[b"config"], &chainpay::ID).0;
        let asset =
            Pubkey::find_program_address(&[b"asset", mint.pubkey().as_ref()], &chainpay::ID).0;
        self.chainpay = Some(Repay {
            mint: mint.pubkey(),
            source: Pubkey::default(),
            partner: Pubkey::default(),
            stranger_account: Pubkey::default(),
            config,
            asset,
            mandate: Pubkey::default(),
            nonce_seq: 0,
        });
        let owner = self.owner.pubkey();
        let source = self.token_account(&owner);
        let partner = self.token_account(&Pubkey::new_unique());
        let stranger = self.stranger.pubkey();
        let stranger_account = self.token_account(&stranger);
        let mut mint_to = vec![7u8];
        mint_to.extend_from_slice(&SOURCE_BALANCE.to_le_bytes());
        self.send_signed(
            vec![
                chainpay_ix(
                    chainpay::client::accounts::InitializeConfig {
                        config,
                        authority: admin.pubkey(),
                        system_program: SYSTEM,
                    },
                    chainpay::client::args::InitializeConfig {
                        supported_mints: [mint.pubkey(), Pubkey::default(), Pubkey::default()],
                    },
                ),
                chainpay_ix(
                    chainpay::client::accounts::RegisterAsset {
                        config,
                        asset,
                        authority: admin.pubkey(),
                        mint_account: mint.pubkey(),
                        token_program: SPL_TOKEN,
                        system_program: SYSTEM,
                    },
                    chainpay::client::args::RegisterAsset {
                        mint: mint.pubkey(),
                    },
                ),
                token_ix(
                    vec![
                        AccountMeta::new(mint.pubkey(), false),
                        AccountMeta::new(source, false),
                        AccountMeta::new_readonly(admin.pubkey(), true),
                    ],
                    mint_to,
                ),
            ],
            &[&admin],
        )
        .expect("chainpay config");
        {
            let repay = self.chainpay.as_mut().unwrap();
            repay.source = source;
            repay.partner = partner;
            repay.stranger_account = stranger_account;
        }
        let owner_kp = self.owner.insecure_clone();
        let agent = self.repay_agent();
        let mandate = self
            .create_mandate(&owner_kp, source, agent)
            .expect("mandate");
        self.chainpay.as_mut().unwrap().mandate = mandate;
        self.chainpay.as_ref().unwrap()
    }

    /// A ChainPay mandate over `source` (owned by `owner`) for `agent`, with the
    /// whole source balance approved to it.
    fn create_mandate(
        &mut self,
        owner: &Keypair,
        source: Pubkey,
        agent: Pubkey,
    ) -> Result<Pubkey, u32> {
        let (config, asset, mint, seq) = {
            let repay = self.chainpay.as_mut().unwrap();
            repay.nonce_seq += 1;
            (repay.config, repay.asset, repay.mint, repay.nonce_seq)
        };
        let nonce = mandate_nonce(seq);
        let mandate = Pubkey::find_program_address(
            &[
                b"mandate",
                owner.pubkey().as_ref(),
                mint.as_ref(),
                nonce.as_ref(),
            ],
            &chainpay::ID,
        )
        .0;
        let slot = self.svm.get_sysvar::<anchor_lang::prelude::Clock>().slot;
        let mut approve = vec![4u8];
        approve.extend_from_slice(&SOURCE_BALANCE.to_le_bytes());
        self.send_signed(
            vec![
                chainpay_ix(
                    chainpay::client::accounts::CreateMandate {
                        config,
                        asset_registry: asset,
                        mandate,
                        owner: owner.pubkey(),
                        allowed_mint: mint,
                        source_token_account: source,
                        token_program: SPL_TOKEN,
                        system_program: SYSTEM,
                    },
                    chainpay::client::args::CreateMandate {
                        params: chainpay::types::MandateParams {
                            approved_agent: agent,
                            source_token_account: source,
                            allowed_mint: mint,
                            max_per_payment: SOURCE_BALANCE,
                            total_limit: SOURCE_BALANCE,
                            expires_at_slot: slot + 1_000_000,
                            max_payment_count: 0,
                            cooldown_slots: 0,
                            mandate_nonce: nonce,
                        },
                    },
                ),
                token_ix(
                    vec![
                        AccountMeta::new(source, false),
                        AccountMeta::new_readonly(mandate, false),
                        AccountMeta::new_readonly(owner.pubkey(), true),
                    ],
                    approve,
                ),
            ],
            &[owner],
        )?;
        Ok(mandate)
    }

    fn receipt_key(&self, mandate: &Pubkey, digest: u64) -> Pubkey {
        Pubkey::find_program_address(
            &[b"receipt", mandate.as_ref(), &hash("stmt", digest)],
            &chainpay::ID,
        )
        .0
    }

    fn repay_statement_ix(
        &self,
        mandate: Pubkey,
        recipient: Pubkey,
        digest: u64,
        amount: u64,
    ) -> Instruction {
        let repay = self.chainpay.as_ref().unwrap();
        self.ix(
            accounts::RepayStatement {
                owner: self.owner.pubkey(),
                binding: self.binding,
                repay_agent: self.repay_agent(),
                chainpay_config: repay.config,
                asset_registry: repay.asset,
                mandate,
                receipt: self.receipt_key(&mandate, digest),
                allowed_mint: repay.mint,
                source_token_account: repay.source,
                recipient_token_account: recipient,
                token_program: SPL_TOKEN,
                system_program: SYSTEM,
                chainpay_program: chainpay::ID,
            },
            instruction::RepayStatement {
                statement_digest: hash("stmt", digest),
                amount,
            },
        )
    }

    /// Owner pays statement `digest` to the partner through the card's mandate.
    fn repay_statement(&mut self, digest: u64, amount: u64) -> Result<(), u32> {
        let (mandate, partner) = {
            let repay = self.with_chainpay();
            (repay.mandate, repay.partner)
        };
        let ix = self.repay_statement_ix(mandate, partner, digest, amount);
        self.send_as(ix, "owner")
    }

    fn record_repayment_with(
        &mut self,
        who: &str,
        digest: u64,
        amount_cents: u64,
        receipt: Pubkey,
        recipient: Pubkey,
    ) -> Result<(), u32> {
        let mint = self.with_chainpay().mint;
        let ix = self.ix(
            accounts::RecordRepayment {
                signer: self.signer(who).pubkey(),
                policy: self.policy,
                period: self.period,
                receipt,
                recipient_token_account: recipient,
                mint,
            },
            instruction::RecordRepayment {
                statement_digest: hash("stmt", digest),
                amount_cents,
            },
        );
        self.send_as(ix, who)
    }

    /// The authorizer records statement `digest` against its receipt.
    fn record_repayment(&mut self, who: &str, digest: u64, amount_cents: u64) -> Result<(), u32> {
        let (mandate, partner) = {
            let repay = self.with_chainpay();
            (repay.mandate, repay.partner)
        };
        let receipt = self.receipt_key(&mandate, digest);
        self.record_repayment_with(who, digest, amount_cents, receipt, partner)
    }
}

/// $20 purchase + 50 bps fee: $20.10 outstanding.
fn card_owing_2010() -> Card {
    let mut card = Card::ready();
    card.buy(1, 1, 2_000).unwrap();
    card.capture(1, 2_000, 1).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 2_010);
    card
}

fn card_owing_2010_on(chainpay: PathBuf) -> Card {
    let mut card = Card::ready_with(Card::with_programs(MOCK_PREFUND, chainpay));
    card.buy(1, 1, 2_000).unwrap();
    card.capture(1, 2_000, 1).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 2_010);
    card
}

/// Lane B (Devnet, 2026-10-06): against the deployed ChainPay, the first
/// repayment failed on rent (the agent was funded for a 371-byte receipt and
/// left holding a non-exempt remainder after a 282-byte one), and
/// `record_repayment` refused every 282-byte receipt. Both binaries must work.
#[test]
fn repayment_works_with_the_deployed_and_the_local_chainpay_receipt() {
    for (binary, receipt_len) in chainpay_binaries() {
        let mut card = card_owing_2010_on(binary.clone());
        let repay = card.with_chainpay();
        let (mandate, partner) = (repay.mandate, repay.partner);
        let agent = card.repay_agent();
        let owner = card.owner.pubkey();
        let owner_before = card.lamports(&owner);
        card.repay_statement(1, cents_to_units(2_010))
            .unwrap_or_else(|code| panic!("{binary:?}: repay_statement failed ({code})"));
        let receipt_key = card.receipt_key(&mandate, 1);
        let account = card.svm.get_account(&receipt_key).expect("receipt");
        assert_eq!(account.owner, chainpay::ID);
        assert_eq!(account.data.len(), receipt_len, "{binary:?}");
        assert_eq!(
            account.lamports,
            card.svm.minimum_balance_for_rent_exemption(receipt_len)
        );
        // The agent ends empty and the owner paid exactly this receipt's rent
        // plus the one-signature fee: the unused top-up came back.
        assert_eq!(card.lamports(&agent), 0, "{binary:?}");
        assert_eq!(
            owner_before - card.lamports(&owner),
            account.lamports + 5_000,
            "{binary:?}"
        );
        assert_eq!(token_amount(&card, &partner), cents_to_units(2_010));

        // Every record_repayment check still holds on this layout.
        let elsewhere = card.with_chainpay().stranger_account;
        assert_eq!(
            card.record_repayment_with("authorizer", 1, 2_010, receipt_key, elsewhere),
            Err(err_code("RepaymentRecipientMismatch"))
        );
        assert_eq!(
            card.record_repayment("authorizer", 1, 2_011),
            Err(err_code("RepaymentExceedsReceipt"))
        );
        assert_eq!(
            card.record_repayment("owner", 1, 2_010),
            Err(err_code("Unauthorized"))
        );
        // Same bytes under another owner, or resized by one byte, never count.
        let original = account.clone();
        let mut forged = original.clone();
        forged.owner = card_policy::ID;
        card.svm.set_account(receipt_key, forged).unwrap();
        assert_eq!(
            card.record_repayment("authorizer", 1, 2_010),
            Err(err_code("InvalidRepaymentReceipt"))
        );
        for len in [receipt_len - 1, receipt_len + 1] {
            let mut resized = original.clone();
            resized.data.resize(len, 0);
            card.svm.set_account(receipt_key, resized).unwrap();
            assert_eq!(
                card.record_repayment("authorizer", 1, 2_010),
                Err(err_code("InvalidRepaymentReceipt")),
                "{binary:?} len {len}"
            );
        }
        card.svm.set_account(receipt_key, original).unwrap();
        card.record_repayment("authorizer", 1, 2_010)
            .unwrap_or_else(|code| panic!("{binary:?}: record_repayment failed ({code})"));
        assert_eq!(card.policy().statement_outstanding_cents, 0);
        assert_eq!(
            card.record_repayment("authorizer", 1, 2_010),
            Err(err_code("DuplicateRepayment"))
        );
    }
}

/// A repay agent that already holds lamports ends rent-exempt, and the owner
/// tops up only what the receipt's rent needs beyond them.
#[test]
fn a_prefunded_repay_agent_stays_rent_exempt_with_either_chainpay() {
    for (binary, receipt_len) in chainpay_binaries() {
        let mut card = card_owing_2010_on(binary.clone());
        card.with_chainpay();
        let agent = card.repay_agent();
        let held = card.svm.minimum_balance_for_rent_exemption(0) + 12_345;
        card.svm.airdrop(&agent, held).unwrap();
        let owner = card.owner.pubkey();
        let owner_before = card.lamports(&owner);
        card.repay_statement(1, cents_to_units(1_000))
            .unwrap_or_else(|code| panic!("{binary:?}: repay_statement failed ({code})"));
        let left = card.lamports(&agent);
        assert!(
            left >= card.svm.minimum_balance_for_rent_exemption(0) && left <= held,
            "{binary:?}: agent left with {left}"
        );
        let rent = card.svm.minimum_balance_for_rent_exemption(receipt_len);
        // Owner top-up plus what the agent spent pays exactly the receipt rent.
        assert_eq!(
            owner_before - card.lamports(&owner) + (held - left),
            rent + 5_000,
            "{binary:?}"
        );
    }
}

/// Another program's receipt-sized account with the right discriminator, or a
/// receipt from an ordinary mandate, never clears the statement on v1 either.
#[test]
fn a_foreign_v1_receipt_never_clears_the_statement() {
    let mut card = card_owing_2010_on(chainpay_devnet_so());
    let repay = card.with_chainpay();
    let (source, partner, mint, config, asset) = (
        repay.source,
        repay.partner,
        repay.mint,
        repay.config,
        repay.asset,
    );
    let owner = card.owner.insecure_clone();
    let ordinary = card.create_mandate(&owner, source, owner.pubkey()).unwrap();
    let receipt = card.receipt_key(&ordinary, 1);
    let ix = chainpay_ix(
        chainpay::client::accounts::ExecutePayment {
            config,
            asset_registry: asset,
            mandate: ordinary,
            receipt,
            agent: owner.pubkey(),
            allowed_mint: mint,
            source_token_account: source,
            recipient_token_account: partner,
            token_program: SPL_TOKEN,
            system_program: SYSTEM,
        },
        chainpay::client::args::ExecutePayment {
            params: chainpay::types::PaymentParams {
                invoice_hash: hash("stmt", 1),
                payment_id: [1; 32],
                signature_reference: [2; 32],
                amount: cents_to_units(2_010),
            },
        },
    );
    card.send_as(ix, "owner").unwrap();
    assert_eq!(
        card.svm.get_account(&receipt).unwrap().data.len(),
        CHAINPAY_RECEIPT_SPACE_V1
    );
    assert_eq!(
        card.record_repayment_with("authorizer", 1, 2_010, receipt, partner),
        Err(err_code("InvalidRepaymentReceipt"))
    );
    assert_eq!(card.policy().statement_outstanding_cents, 2_010);
}

#[test]
fn repay_statement_pays_through_chainpay_and_clears_the_statement() {
    let mut card = card_owing_2010();
    let repay = card.with_chainpay();
    let (mandate, partner, source) = (repay.mandate, repay.partner, repay.source);
    let agent = card.repay_agent();
    let owner_before = card.lamports(&card.owner.pubkey());

    card.repay_statement(1, cents_to_units(2_010)).unwrap();

    // ChainPay moved the tokens, enforced the mandate and wrote the receipt.
    assert_eq!(token_amount(&card, &partner), cents_to_units(2_010));
    assert_eq!(
        token_amount(&card, &source),
        SOURCE_BALANCE - cents_to_units(2_010)
    );
    let receipt_key = card.receipt_key(&mandate, 1);
    let account = card.svm.get_account(&receipt_key).expect("receipt");
    assert_eq!(account.owner, chainpay::ID);
    assert_eq!(account.data.len(), CHAINPAY_RECEIPT_SPACE);
    let receipt: chainpay::accounts::PaymentReceipt = card.get(&receipt_key);
    assert_eq!(receipt.mandate, mandate);
    assert_eq!(receipt.invoice_hash, hash("stmt", 1));
    assert_eq!(receipt.agent, agent);
    assert_eq!(receipt.recipient_token_account, partner);
    assert_eq!(receipt.amount, cents_to_units(2_010));
    let (payment_id, signature_reference) =
        card_policy::instructions::repayment_references(&card.binding, &hash("stmt", 1));
    assert_eq!(receipt.payment_id, payment_id);
    assert_eq!(receipt.signature_reference, signature_reference);
    let m: chainpay::accounts::PaymentMandate = card.get(&mandate);
    assert_eq!(
        (m.amount_spent, m.payment_count),
        (cents_to_units(2_010), 1)
    );
    // The owner paid the receipt rent through the repay agent, which ends empty.
    assert_eq!(card.lamports(&agent), 0);
    assert!(owner_before - card.lamports(&card.owner.pubkey()) >= account.lamports);

    // Nothing private changed on the base payment.
    assert_eq!(card.policy().statement_outstanding_cents, 2_010);
    let head = card.policy().ledger_head;
    card.record_repayment("authorizer", 1, 2_010).unwrap();
    let policy = card.policy();
    assert_eq!(policy.statement_outstanding_cents, 0);
    assert!(policy.repayment_digests.contains(&hash("stmt", 1)));
    assert_ne!(policy.ledger_head, head);
}

#[test]
fn repay_statement_needs_the_owners_mandate_for_this_cards_repay_agent() {
    let mut card = card_owing_2010();
    let repay = card.with_chainpay();
    let (source, partner) = (repay.source, repay.partner);
    let owner = card.owner.insecure_clone();
    // The owner's mandate for an ordinary agent (here: the owner's own key).
    let ordinary = card.create_mandate(&owner, source, owner.pubkey()).unwrap();
    let ix = card.repay_statement_ix(ordinary, partner, 1, cents_to_units(2_010));
    assert_eq!(
        card.send_as(ix, "owner"),
        Err(err_code("InvalidRepaymentMandate"))
    );
    // Someone else's mandate naming this card's repay agent.
    let stranger = card.stranger.insecure_clone();
    let stranger_source = card.with_chainpay().stranger_account;
    let agent = card.repay_agent();
    let foreign = card
        .create_mandate(&stranger, stranger_source, agent)
        .unwrap();
    let ix = card.repay_statement_ix(foreign, partner, 1, cents_to_units(2_010));
    assert_eq!(
        card.send_as(ix, "owner"),
        Err(err_code("InvalidRepaymentMandate"))
    );
    // Only the card's owner can start a repayment.
    let mandate = card.with_chainpay().mandate;
    let mut ix = card.repay_statement_ix(mandate, partner, 1, cents_to_units(2_010));
    ix.accounts[0].pubkey = card.stranger.pubkey();
    assert!(card.send_as(ix, "stranger").is_err());
    assert_eq!(token_amount(&card, &partner), 0);

    // A receipt from an ordinary mandate (not this card's repay agent) for the
    // same digest never clears the statement.
    let receipt = card.receipt_key(&ordinary, 1);
    let mint = card.with_chainpay().mint;
    let (config, asset) = (card.with_chainpay().config, card.with_chainpay().asset);
    let ix = chainpay_ix(
        chainpay::client::accounts::ExecutePayment {
            config,
            asset_registry: asset,
            mandate: ordinary,
            receipt,
            agent: owner.pubkey(),
            allowed_mint: mint,
            source_token_account: source,
            recipient_token_account: partner,
            token_program: SPL_TOKEN,
            system_program: SYSTEM,
        },
        chainpay::client::args::ExecutePayment {
            params: chainpay::types::PaymentParams {
                invoice_hash: hash("stmt", 1),
                payment_id: [1; 32],
                signature_reference: [2; 32],
                amount: cents_to_units(2_010),
            },
        },
    );
    card.send_as(ix, "owner").unwrap();
    assert_eq!(
        card.record_repayment_with("authorizer", 1, 2_010, receipt, partner),
        Err(err_code("InvalidRepaymentReceipt"))
    );
    assert_eq!(card.policy().statement_outstanding_cents, 2_010);
}

#[test]
fn a_repayment_to_another_account_never_clears_the_statement() {
    let mut card = card_owing_2010();
    let repay = card.with_chainpay();
    let (mandate, partner, elsewhere) = (repay.mandate, repay.partner, repay.stranger_account);
    let ix = card.repay_statement_ix(mandate, elsewhere, 1, cents_to_units(2_010));
    card.send_as(ix, "owner").unwrap();
    let receipt = card.receipt_key(&mandate, 1);
    assert_eq!(
        card.record_repayment_with("authorizer", 1, 2_010, receipt, partner),
        Err(err_code("RepaymentRecipientMismatch"))
    );
    // Naming the receipt's recipient instead isn't enough: it must be a token
    // account of the receipt's mint (here: not a token account at all).
    assert_eq!(
        card.record_repayment_with("authorizer", 1, 2_010, receipt, card.policy),
        Err(err_code("RepaymentRecipientMismatch"))
    );
    assert_eq!(card.policy().statement_outstanding_cents, 2_010);
}

#[test]
fn a_statement_digest_pays_and_records_once() {
    let mut card = card_owing_2010();
    card.repay_statement(1, cents_to_units(1_000)).unwrap();
    // ChainPay refuses a second receipt for the same mandate and digest.
    assert!(card.repay_statement(1, cents_to_units(1_000)).is_err());
    card.record_repayment("authorizer", 1, 1_000).unwrap();
    assert_eq!(
        card.record_repayment("authorizer", 1, 1_000),
        Err(err_code("DuplicateRepayment"))
    );
    // A second mandate can make a second receipt for the digest; the ring
    // still refuses to record it.
    let repay = card.with_chainpay();
    let (source, partner) = (repay.source, repay.partner);
    let owner = card.owner.insecure_clone();
    let agent = card.repay_agent();
    let second = card.create_mandate(&owner, source, agent).unwrap();
    let ix = card.repay_statement_ix(second, partner, 1, cents_to_units(1_000));
    card.send_as(ix, "owner").unwrap();
    let receipt = card.receipt_key(&second, 1);
    assert_eq!(
        card.record_repayment_with("authorizer", 1, 1_000, receipt, partner),
        Err(err_code("DuplicateRepayment"))
    );
    assert_eq!(card.policy().statement_outstanding_cents, 1_010);
}

#[test]
fn a_repayment_never_records_more_than_outstanding_or_paid() {
    let mut card = card_owing_2010();
    card.repay_statement(1, cents_to_units(3_000)).unwrap();
    assert_eq!(
        card.record_repayment("authorizer", 1, 2_011),
        Err(err_code("RepaymentExceedsOutstanding"))
    );
    card.repay_statement(2, cents_to_units(500) + 9_999)
        .unwrap(); // $5.009999
    assert_eq!(
        card.record_repayment("authorizer", 2, 501),
        Err(err_code("RepaymentExceedsReceipt"))
    );
    card.record_repayment("authorizer", 2, 500).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 1_510);
    assert_eq!(
        card.record_repayment("authorizer", 3, 0),
        Err(err_code("InvalidRepaymentReceipt"))
    );
}

#[test]
fn a_receipt_owned_by_another_program_is_refused() {
    let mut card = card_owing_2010();
    card.repay_statement(1, cents_to_units(2_010)).unwrap();
    let mandate = card.with_chainpay().mandate;
    let receipt = card.receipt_key(&mandate, 1);
    let mut account = card.svm.get_account(&receipt).unwrap();
    // Same bytes at the same address, owned by card_policy (or anyone else).
    for owner in [card_policy::ID, SYSTEM, Pubkey::new_unique()] {
        account.owner = owner;
        card.svm.set_account(receipt, account.clone()).unwrap();
        assert_eq!(
            card.record_repayment("authorizer", 1, 2_010),
            Err(err_code("InvalidRepaymentReceipt"))
        );
    }
    // A ChainPay-owned copy at an address that isn't the receipt PDA.
    account.owner = chainpay::ID;
    let fake = Pubkey::new_unique();
    card.svm.set_account(fake, account).unwrap();
    let partner = card.with_chainpay().partner;
    assert_eq!(
        card.record_repayment_with("authorizer", 1, 2_010, fake, partner),
        Err(err_code("InvalidRepaymentReceipt"))
    );
    assert_eq!(card.policy().statement_outstanding_cents, 2_010);
}

#[test]
fn private_repayment_is_authorizer_attested_and_shares_the_digest_ring() {
    let mut card = card_owing_2010();
    let private = |card: &mut Card, who: &str, digest: u64, amount: u64| {
        let ix = card.ix(
            card.freeze_accounts(who),
            instruction::RecordPrivateRepayment {
                statement_digest: hash("stmt", digest),
                amount_cents: amount,
            },
        );
        card.send_as(ix, who)
    };
    assert_eq!(
        private(&mut card, "owner", 1, 10),
        Err(err_code("Unauthorized"))
    );
    assert_eq!(
        private(&mut card, "authorizer", 1, 2_011),
        Err(err_code("RepaymentExceedsOutstanding"))
    );
    private(&mut card, "authorizer", 1, 1_010).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 1_000);
    // One digest, one repayment, whichever path recorded it.
    card.repay_statement(1, cents_to_units(1_000)).unwrap();
    assert_eq!(
        card.record_repayment("authorizer", 1, 1_000),
        Err(err_code("DuplicateRepayment"))
    );
}

// ============================== owner can't edit card permissions directly

const PERMISSION_CREATE: u64 = 0;
const PERMISSION_UPDATE: u64 = 1;

fn permission_program_so() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/permission/permission.so")
}

fn members_args(members: &[(u8, Pubkey)]) -> Vec<u8> {
    let mut out = vec![1u8];
    out.extend_from_slice(&(members.len() as u32).to_le_bytes());
    for (flags, key) in members {
        out.push(*flags);
        out.extend_from_slice(key.as_ref());
    }
    out
}

fn permission_ix(tag: u64, accounts: Vec<AccountMeta>, members: &[(u8, Pubkey)]) -> Instruction {
    let mut data = tag.to_le_bytes().to_vec();
    data.extend_from_slice(&members_args(members));
    Instruction {
        program_id: PERMISSION_PROGRAM_ID,
        accounts,
        data,
    }
}

/// Runs MagicBlock's permission program (dumped from Devnet) on a permission
/// with the exact member flags `init_permission` writes. Its base-layer
/// Create/UpdatePermission share the authority rule with the ephemeral ones the
/// rollup uses: a member may rewrite the list only with `AUTHORITY_FLAG`.
#[test]
fn owner_cannot_rewrite_card_permission_members() {
    use card_policy::er::{AUTHORIZER_FLAGS, OWNER_FLAGS, READER_FLAGS};
    use ephemeral_rollups_sdk::access_control::structs::AUTHORITY_FLAG;

    // What the program stores and passes to the permission program.
    let card = Card::ready();
    let policy = card.policy();
    assert_eq!(policy.members[0], card.owner.pubkey());
    assert_eq!(policy.member_flags[0], OWNER_FLAGS);
    assert_eq!(policy.member_flags[1], AUTHORIZER_FLAGS);
    assert!(policy.member_flags.iter().all(|f| f & AUTHORITY_FLAG == 0));

    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PERMISSION_PROGRAM_ID, permission_program_so())
        .expect("dump the permission program first: solana program dump -u devnet ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1 target/permission/permission.so");
    let (owner, authorizer, payer) = (Keypair::new(), Keypair::new(), Keypair::new());
    for k in [&owner, &payer] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }
    let send = |svm: &mut LiteSVM, ix: Instruction, signers: &[&Keypair]| {
        svm.expire_blockhash();
        let msg = Message::new(&[ix], Some(&signers[0].pubkey()));
        svm.send_transaction(Transaction::new(signers, msg, svm.latest_blockhash()))
            .is_ok()
    };
    // `owner_flags` = what the owner holds on a card permission.
    let mut attempt = |owner_flags: u8| -> (bool, bool) {
        let permissioned = Keypair::new(); // stands in for the card PDA
        let permission = permission(&permissioned.pubkey());
        let members = [
            (owner_flags, owner.pubkey()),
            (AUTHORIZER_FLAGS, authorizer.pubkey()),
        ];
        let created = send(
            &mut svm,
            permission_ix(
                PERMISSION_CREATE,
                vec![
                    AccountMeta::new_readonly(permissioned.pubkey(), true),
                    AccountMeta::new(permission, false),
                    AccountMeta::new(payer.pubkey(), true),
                    AccountMeta::new_readonly(SYSTEM, false),
                ],
                &members,
            ),
            &[&payer, &permissioned],
        );
        assert!(created, "create permission");
        // The owner alone drops the authorizer and adds a reader of its choice.
        let rewritten = [
            (owner_flags, owner.pubkey()),
            (READER_FLAGS, Pubkey::new_unique()),
        ];
        let by_owner = send(
            &mut svm,
            permission_ix(
                PERMISSION_UPDATE,
                vec![
                    AccountMeta::new_readonly(owner.pubkey(), true),
                    AccountMeta::new_readonly(permissioned.pubkey(), false),
                    AccountMeta::new(permission, false),
                ],
                &rewritten,
            ),
            &[&owner],
        );
        // The permissioned account (the card PDA, signing by seeds in the
        // program) can still update it: that's the program's own path.
        let by_card = send(
            &mut svm,
            permission_ix(
                PERMISSION_UPDATE,
                vec![
                    AccountMeta::new_readonly(permissioned.pubkey(), true),
                    AccountMeta::new_readonly(permissioned.pubkey(), true),
                    AccountMeta::new(permission, false),
                ],
                &members,
            ),
            &[&payer, &permissioned],
        );
        (by_owner, by_card)
    };
    assert_eq!(attempt(OWNER_FLAGS), (false, true));
    // Control: with the old flags the owner could rewrite the list.
    assert_eq!(attempt(OWNER_FLAGS | AUTHORITY_FLAG), (true, true));
}
