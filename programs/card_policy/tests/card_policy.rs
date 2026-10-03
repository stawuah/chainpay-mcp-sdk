//! LiteSVM tests for every program/state row of the PLAN test matrix.
//!
//! The MagicBlock magic program and permission program only exist inside the
//! ER validator, so these tests load a binary built with `--features
//! litesvm-mock` (see `er.rs`): ephemeral accounts become ordinary
//! program-owned PDAs and permission/Magic Action CPIs become no-ops. The
//! policy logic, account checks and state transitions are the deployed ones.
//! Privacy itself is proven live on Devnet (scripts/per-integration.ts).
//!
//! Build first: `cargo build-sbf --features litesvm-mock --sbf-out-dir target/mock`

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use card_policy::constants::*;
use card_policy::instructions::common::MIN_PREFUND;
use card_policy::instructions::{PermissionOp, RestoreArgs};
use card_policy::policy::{AuthorizeArgs, IntentArgs, PolicyArgs};
use card_policy::state::{
    reservation_state as rs, CardBinding, CardCommitment, CardPeriod, CardPolicy, CheckoutIntent,
    Reservation,
};
use card_policy::{accounts, instruction};
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
}

fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &card_policy::ID).0
}

fn permission(account: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PERMISSION_SEED, account.as_ref()], &PERMISSION_PROGRAM_ID).0
}

impl Card {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/mock/card_policy.so");
        svm.add_program_from_file(card_policy::ID, &so)
            .expect("build the mock binary first: cargo build-sbf --features litesvm-mock --sbf-out-dir target/mock");
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
                prefund_lamports: MOCK_PREFUND,
            },
        );
        card.send(ix, &[]).expect("init_card");
        card
    }

    /// A card with permissions and the default policy ($50 budget, $30 max).
    fn ready() -> Self {
        let mut card = Self::new();
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
                    other => panic!("unexpected failure: {other:?}"),
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
    assert_eq!(MIN_PREFUND, 2_665_408);
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
    card.set_policy(rotated.clone()).unwrap();
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
    assert_eq!(card.policy().statement_outstanding_cents, 1_508); // + ceil(7.5)
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
    card.set_policy(p).unwrap();
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
    card.buy(1, 1, 2_000).unwrap();
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
    card.set_policy(p).unwrap();

    // Partial capture, then the rest of the hold is voided.
    card.buy(1, 1, 3_000).unwrap();
    card.capture(1, 1_000, 1).unwrap();
    assert_eq!(card.reservation(1).state, rs::PARTIALLY_CAPTURED);
    assert_eq!(card.reservation(1).amount_reserved_cents, 2_000);
    card.reverse(1, 2_000, 0, 1).unwrap();
    let r1 = card.reservation(1);
    assert_eq!(
        (r1.state, r1.captured_cents, r1.reversed_cents),
        (rs::REVERSED, 1_000, 2_000)
    );

    // Late capture after reversal: counted, flagged, never re-reserved.
    card.capture(1, 500, 2).unwrap();
    let r1 = card.reservation(1);
    assert_eq!(r1.state, rs::REVERSED);
    assert_ne!(r1.flags & FLAG_LATE_CAPTURE, 0);
    assert_eq!(r1.amount_reserved_cents, 0);
    assert_eq!(card.period().reserved_cents, 0);

    // Expiry reversal.
    card.buy(2, 2, 1_000).unwrap();
    card.reverse(2, 1_000, 1, 2).unwrap();
    assert_eq!(card.reservation(2).state, rs::EXPIRED);
    assert_eq!(card.reverse(2, 1, 0, 3), Err(err_code("ReservationClosed")));

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
    assert_eq!(period.captured_cents, 1_000 + 500 + 2_000 + 700);
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
    assert_eq!(card.policy().statement_outstanding_cents, 1_206 + 905);

    // Over-hold needs a reservation; credits reduce exposure.
    assert_eq!(
        card.exception(None, EXC_OVER_HOLD, 10, 3),
        Err(err_code("InvalidAccount"))
    );
    assert_eq!(
        card.exception(None, 8, 10, 3),
        Err(err_code("InvalidPolicy"))
    );
    card.exception(None, EXC_CORRECTION_CREDIT, 100, 4).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 1_206 + 905 - 101);

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
    let repay = |card: &mut Card, digest: u64, amount: u64| {
        let ix = card.ix(
            card.freeze_accounts("authorizer"),
            instruction::RecordRepayment {
                statement_digest: hash("stmt", digest),
                amount_cents: amount,
            },
        );
        card.send_as(ix, "authorizer")
    };
    assert_eq!(
        repay(&mut card, 1, 2_011),
        Err(err_code("RepaymentExceedsOutstanding"))
    );
    repay(&mut card, 1, 2_010).unwrap();
    assert_eq!(card.policy().statement_outstanding_cents, 0);
    assert_eq!(repay(&mut card, 1, 1), Err(err_code("DuplicateRepayment")));
    let ix = card.ix(
        card.freeze_accounts("owner"),
        instruction::RecordRepayment {
            statement_digest: hash("stmt", 2),
            amount_cents: 1,
        },
    );
    assert_eq!(card.send_as(ix, "owner"), Err(err_code("Unauthorized")));
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
    let ix = card.ix(
        card.freeze_accounts("authorizer"),
        instruction::RecordRepayment {
            statement_digest: hash("stmt", 1),
            amount_cents: 1_005,
        },
    );
    card.send_as(ix, "authorizer").unwrap();

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
    card.set_policy(p).unwrap();
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
    card.set_policy(p).unwrap();
    card.buy(1, 1, 1_000).unwrap();
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
