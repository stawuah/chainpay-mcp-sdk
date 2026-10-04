//! Adversarial tests for the support splitter. Build the test program first:
//!   cargo build-sbf --manifest-path programs/support-splitter/Cargo.toml --features test-config
//! then run:
//!   cargo test -p support-splitter --features splitter-tests --test splitter

use anchor_lang::solana_program::{pubkey::Pubkey, system_program};
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::LiteSVM;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_system_interface::instruction as system_ix;
use solana_transaction::Transaction;
use spl_associated_token_account_interface::address::get_associated_token_address;
use spl_associated_token_account_interface::instruction::create_associated_token_account_idempotent;
use spl_token_interface as token;
use std::path::PathBuf;
use support_splitter::constants::{RECIPIENT_A, RECIPIENT_B, USDC_MINT, VAULT_SEED};
use support_splitter::{accounts, instruction, Ledger, Side, Vault};

const DECIMALS: u8 = 6;
const MINT_SPACE: usize = 82;
const TOKEN_ACCOUNT_SPACE: usize = 165;
const SOL: u64 = 1_000_000_000;

fn side_a() -> Keypair {
    Keypair::new_from_array([11; 32])
}
fn side_b() -> Keypair {
    Keypair::new_from_array([22; 32])
}
fn usdc_mint_keypair() -> Keypair {
    Keypair::new_from_array([33; 32])
}

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/support_splitter.so")
}

fn vault_pda() -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED], &support_splitter::ID).0
}

fn vault_usdc() -> Pubkey {
    get_associated_token_address(&vault_pda(), &USDC_MINT)
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    a: Keypair,
    b: Keypair,
    mint_authority: Keypair,
    freeze_authority: Keypair,
}

type TxResult = Result<(), String>;

impl Env {
    /// Program loaded, USDC mint created at the pinned test address, wallets
    /// funded. The vault is NOT initialized yet.
    fn bare() -> Self {
        let mut svm = LiteSVM::new();
        svm.add_program_from_file(support_splitter::ID, program_path())
            .expect("build the program with --features test-config first");
        let env = Env {
            svm,
            payer: Keypair::new(),
            a: side_a(),
            b: side_b(),
            mint_authority: Keypair::new(),
            freeze_authority: Keypair::new(),
        };
        assert_eq!(env.a.pubkey(), RECIPIENT_A);
        assert_eq!(env.b.pubkey(), RECIPIENT_B);
        let mut env = env;
        for k in [
            env.payer.pubkey(),
            env.a.pubkey(),
            env.b.pubkey(),
            env.mint_authority.pubkey(),
        ] {
            env.svm.airdrop(&k, 100 * SOL).unwrap();
        }
        let mint = usdc_mint_keypair();
        assert_eq!(mint.pubkey(), USDC_MINT);
        env.create_mint(&mint, Some(env.freeze_authority.pubkey()));
        env
    }

    fn ready() -> Self {
        let mut env = Env::bare();
        env.initialize().expect("initialize");
        env
    }

    fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        self.svm.expire_blockhash();
        let payer = signers[0].pubkey();
        let tx = Transaction::new(
            signers,
            Message::new(ixs, Some(&payer)),
            self.svm.latest_blockhash(),
        );
        self.svm
            .send_transaction(tx)
            .map(|_| ())
            .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
    }

    fn create_mint(&mut self, mint: &Keypair, freeze: Option<Pubkey>) {
        let rent = self.svm.minimum_balance_for_rent_exemption(MINT_SPACE);
        let ixs = [
            system_ix::create_account(
                &self.payer.pubkey(),
                &mint.pubkey(),
                rent,
                MINT_SPACE as u64,
                &token::ID,
            ),
            token::instruction::initialize_mint2(
                &token::ID,
                &mint.pubkey(),
                &self.mint_authority.pubkey(),
                freeze.as_ref(),
                DECIMALS,
            )
            .unwrap(),
        ];
        let payer = self.payer.insecure_clone();
        self.send(&ixs, &[&payer, mint]).unwrap();
    }

    /// A plain (non-ATA) token account owned by `owner`.
    fn token_account(&mut self, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
        let account = Keypair::new();
        let rent = self
            .svm
            .minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_SPACE);
        let ixs = [
            system_ix::create_account(
                &self.payer.pubkey(),
                &account.pubkey(),
                rent,
                TOKEN_ACCOUNT_SPACE as u64,
                &token::ID,
            ),
            token::instruction::initialize_account3(&token::ID, &account.pubkey(), mint, owner)
                .unwrap(),
        ];
        let payer = self.payer.insecure_clone();
        self.send(&ixs, &[&payer, &account]).unwrap();
        account.pubkey()
    }

    fn ata(&mut self, owner: &Pubkey) -> Pubkey {
        let ix = create_associated_token_account_idempotent(
            &self.payer.pubkey(),
            owner,
            &USDC_MINT,
            &token::ID,
        );
        let payer = self.payer.insecure_clone();
        self.send(&[ix], &[&payer]).unwrap();
        get_associated_token_address(owner, &USDC_MINT)
    }

    fn mint_usdc(&mut self, to: &Pubkey, amount: u64) {
        let ix = token::instruction::mint_to(
            &token::ID,
            &USDC_MINT,
            to,
            &self.mint_authority.pubkey(),
            &[],
            amount,
        )
        .unwrap();
        let auth = self.mint_authority.insecure_clone();
        self.send(&[ix], &[&auth]).unwrap();
    }

    /// A stranger donates SOL straight to the vault, the way any wallet would.
    fn donate_sol(&mut self, lamports: u64) {
        let donor = Keypair::new();
        self.svm.airdrop(&donor.pubkey(), lamports + SOL).unwrap();
        let ix = system_ix::transfer(&donor.pubkey(), &vault_pda(), lamports);
        self.send(&[ix], &[&donor]).unwrap();
    }

    fn donate_usdc(&mut self, amount: u64) {
        self.mint_usdc(&vault_usdc(), amount);
    }

    fn initialize_ix(&self, a: Pubkey, b: Pubkey, payer: Pubkey) -> Instruction {
        Instruction {
            program_id: support_splitter::ID,
            accounts: accounts::Initialize {
                recipient_a: a,
                recipient_b: b,
                payer,
                vault: vault_pda(),
                vault_usdc: vault_usdc(),
                usdc_mint: USDC_MINT,
                token_program: token::ID,
                associated_token_program: spl_associated_token_account_interface::program::ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::Initialize {}.data(),
        }
    }

    fn initialize(&mut self) -> TxResult {
        let ix = self.initialize_ix(RECIPIENT_A, RECIPIENT_B, self.payer.pubkey());
        let (payer, a, b) = (
            self.payer.insecure_clone(),
            self.a.insecure_clone(),
            self.b.insecure_clone(),
        );
        self.send(&[ix], &[&payer, &a, &b])
    }

    fn allocate_sol_ix(&self) -> Instruction {
        Instruction {
            program_id: support_splitter::ID,
            accounts: accounts::AllocateSol { vault: vault_pda() }.to_account_metas(None),
            data: instruction::AllocateSol {}.data(),
        }
    }

    fn allocate_usdc_ix(&self) -> Instruction {
        Instruction {
            program_id: support_splitter::ID,
            accounts: accounts::AllocateUsdc {
                vault: vault_pda(),
                vault_usdc: vault_usdc(),
                usdc_mint: USDC_MINT,
                token_program: token::ID,
            }
            .to_account_metas(None),
            data: instruction::AllocateUsdc {}.data(),
        }
    }

    fn pay_sol_ix(&self, side: Side, recipient: Pubkey) -> Instruction {
        Instruction {
            program_id: support_splitter::ID,
            accounts: accounts::PaySol {
                vault: vault_pda(),
                recipient,
            }
            .to_account_metas(None),
            data: instruction::PaySol { side }.data(),
        }
    }

    fn pay_usdc_ix(&self, side: Side, destination: Pubkey) -> Instruction {
        Instruction {
            program_id: support_splitter::ID,
            accounts: accounts::PayUsdc {
                vault: vault_pda(),
                vault_usdc: vault_usdc(),
                destination,
                usdc_mint: USDC_MINT,
                token_program: token::ID,
            }
            .to_account_metas(None),
            data: instruction::PayUsdc { side }.data(),
        }
    }

    fn rotate_ix(&self, current: Pubkey, side: Side, new_recipient: Pubkey) -> Instruction {
        Instruction {
            program_id: support_splitter::ID,
            accounts: accounts::RotateRecipient {
                current,
                vault: vault_pda(),
                vault_usdc: vault_usdc(),
            }
            .to_account_metas(None),
            data: instruction::RotateRecipient {
                side,
                new_recipient,
            }
            .data(),
        }
    }

    /// Anyone can crank: a fresh stranger pays the fee and gets nothing back.
    fn crank(&mut self, ix: Instruction) -> TxResult {
        let stranger = Keypair::new();
        self.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
        self.send(&[ix], &[&stranger])
    }

    fn vault(&self) -> Vault {
        let account = self.svm.get_account(&vault_pda()).expect("vault exists");
        Vault::try_deserialize(&mut &account.data[..]).unwrap()
    }

    fn lamports(&self, address: &Pubkey) -> u64 {
        self.svm
            .get_account(address)
            .map(|a| a.lamports)
            .unwrap_or(0)
    }

    fn token_balance(&self, address: &Pubkey) -> u64 {
        let account = self.svm.get_account(address).expect("token account exists");
        u64::from_le_bytes(account.data[64..72].try_into().unwrap())
    }

    fn vault_rent(&self) -> u64 {
        let len = self.svm.get_account(&vault_pda()).unwrap().data.len();
        self.svm.minimum_balance_for_rent_exemption(len)
    }

    /// Conservation for both assets: balance = reserved + owed_a + owed_b + unallocated,
    /// and both sides have always been allocated the same total.
    fn assert_conserved(&self) {
        let v = self.vault();
        let sol_balance = self.lamports(&vault_pda());
        assert!(sol_balance >= self.vault_rent() + v.sol.owed[0] + v.sol.owed[1]);
        let usdc_balance = self.token_balance(&vault_usdc());
        assert!(usdc_balance >= v.usdc.owed[0] + v.usdc.owed[1]);
        for ledger in [v.sol, v.usdc] {
            assert_eq!(ledger.owed[0] + ledger.paid[0], ledger.allocated_each);
            assert_eq!(ledger.owed[1] + ledger.paid[1], ledger.allocated_each);
        }
    }

    fn sol_unallocated(&self) -> u64 {
        let v = self.vault();
        self.lamports(&vault_pda()) - self.vault_rent() - v.sol.owed[0] - v.sol.owed[1]
    }

    fn usdc_unallocated(&self) -> u64 {
        let v = self.vault();
        self.token_balance(&vault_usdc()) - v.usdc.owed[0] - v.usdc.owed[1]
    }
}

fn expect_err(result: TxResult, needle: &str) {
    match result {
        Ok(()) => panic!("expected failure containing {needle:?}, but it succeeded"),
        Err(e) => assert!(e.contains(needle), "expected {needle:?} in:\n{e}"),
    }
}

// ---------- initialization ----------

#[test]
fn initialize_records_pinned_recipients() {
    let env = Env::ready();
    let v = env.vault();
    assert_eq!(v.recipients, [RECIPIENT_A, RECIPIENT_B]);
    assert_eq!(v.sol, Ledger::default());
    assert_eq!(v.usdc, Ledger::default());
    assert_eq!(env.lamports(&vault_pda()), env.vault_rent());
    env.assert_conserved();
}

#[test]
fn stranger_cannot_claim_the_vault_with_their_own_wallets() {
    let mut env = Env::bare();
    let (x, y) = (Keypair::new(), Keypair::new());
    env.svm.airdrop(&x.pubkey(), SOL).unwrap();
    let ix = env.initialize_ix(x.pubkey(), y.pubkey(), x.pubkey());
    expect_err(env.send(&[ix], &[&x, &y]), "UnauthorizedInitializer");
    assert!(env.svm.get_account(&vault_pda()).is_none());
}

#[test]
fn one_pinned_recipient_alone_cannot_initialize() {
    let mut env = Env::bare();
    let mut ix = env.initialize_ix(RECIPIENT_A, RECIPIENT_B, RECIPIENT_A);
    // B listed but not signing.
    ix.accounts[1] = AccountMeta::new_readonly(RECIPIENT_B, false);
    let a = env.a.insecure_clone();
    assert!(env.send(&[ix], &[&a]).is_err());

    // Attacker puts their own key in B's slot.
    let attacker = Keypair::new();
    let ix = env.initialize_ix(RECIPIENT_A, attacker.pubkey(), RECIPIENT_A);
    expect_err(env.send(&[ix], &[&a, &attacker]), "UnauthorizedInitializer");
}

#[test]
fn reinitialize_is_rejected() {
    let mut env = Env::ready();
    env.donate_sol(3 * SOL);
    env.crank(env.allocate_sol_ix()).unwrap();
    let before = env.vault();
    assert!(env.initialize().is_err());
    assert_eq!(
        env.vault().sol,
        before.sol,
        "ledger untouched by the failed re-init"
    );
}

#[test]
fn initialize_works_when_strangers_prefunded_the_vault_and_its_usdc_account() {
    let mut env = Env::bare();
    // SOL sent to the future vault PDA and USDC sent to its future ATA.
    env.donate_sol(2 * SOL + 1);
    let ata = env.ata(&vault_pda());
    assert_eq!(ata, vault_usdc());
    env.mint_usdc(&ata, 5_000_001);

    env.initialize()
        .expect("initialize over prefunded accounts");
    // Anchor only tops the PDA up to rent-exempt, so part of the stranger's SOL
    // became the vault's rent. Everything above rent is allocatable as usual.
    let prefund_after_rent = 2 * SOL + 1 - env.vault_rent();
    assert_eq!(env.sol_unallocated(), prefund_after_rent);
    assert_eq!(env.usdc_unallocated(), 5_000_001);

    env.crank(env.allocate_sol_ix()).unwrap();
    env.crank(env.allocate_usdc_ix()).unwrap();
    let v = env.vault();
    assert_eq!(v.sol.owed, [prefund_after_rent / 2, prefund_after_rent / 2]);
    assert_eq!(v.usdc.owed, [2_500_000, 2_500_000]);
    assert_eq!(env.sol_unallocated(), prefund_after_rent % 2);
    assert_eq!(env.usdc_unallocated(), 1);
    env.assert_conserved();
}

#[test]
fn initialize_rejects_wrong_mint_and_wrong_vault_token_account() {
    let mut env = Env::bare();
    let fake_mint = Keypair::new();
    env.create_mint(&fake_mint, None);

    let mut ix = env.initialize_ix(RECIPIENT_A, RECIPIENT_B, env.payer.pubkey());
    ix.accounts[5] = AccountMeta::new_readonly(fake_mint.pubkey(), false);
    let (payer, a, b) = (
        env.payer.insecure_clone(),
        env.a.insecure_clone(),
        env.b.insecure_clone(),
    );
    expect_err(env.send(&[ix], &[&payer, &a, &b]), "WrongMint");

    let mut ix = env.initialize_ix(RECIPIENT_A, RECIPIENT_B, env.payer.pubkey());
    ix.accounts[4] = AccountMeta::new(
        get_associated_token_address(&vault_pda(), &fake_mint.pubkey()),
        false,
    );
    expect_err(
        env.send(&[ix], &[&payer, &a, &b]),
        "InvalidVaultTokenAccount",
    );
}

// ---------- allocation and payout amounts ----------

#[test]
fn sol_splits_exactly_and_odd_lamport_waits() {
    let mut env = Env::ready();
    env.donate_sol(1_000_000_001);
    env.crank(env.allocate_sol_ix()).unwrap();
    assert_eq!(env.vault().sol.owed, [500_000_000, 500_000_000]);
    assert_eq!(env.sol_unallocated(), 1);

    let (a0, b0) = (env.lamports(&RECIPIENT_A), env.lamports(&RECIPIENT_B));
    env.crank(env.pay_sol_ix(Side::A, RECIPIENT_A)).unwrap();
    env.crank(env.pay_sol_ix(Side::B, RECIPIENT_B)).unwrap();
    assert_eq!(env.lamports(&RECIPIENT_A) - a0, 500_000_000);
    assert_eq!(env.lamports(&RECIPIENT_B) - b0, 500_000_000);
    assert_eq!(
        env.lamports(&vault_pda()),
        env.vault_rent() + 1,
        "rent and the odd lamport stay"
    );

    // The odd lamport pairs with the next donation's odd lamport.
    env.donate_sol(3);
    env.crank(env.allocate_sol_ix()).unwrap();
    assert_eq!(env.vault().sol.owed, [2, 2]);
    assert_eq!(env.sol_unallocated(), 0);
    env.assert_conserved();
}

#[test]
fn usdc_splits_exactly() {
    let mut env = Env::ready();
    let (a_ata, b_ata) = (env.ata(&RECIPIENT_A), env.ata(&RECIPIENT_B));
    env.donate_usdc(12_345_679);
    env.crank(env.allocate_usdc_ix()).unwrap();
    env.crank(env.pay_usdc_ix(Side::A, a_ata)).unwrap();
    env.crank(env.pay_usdc_ix(Side::B, b_ata)).unwrap();
    assert_eq!(env.token_balance(&a_ata), 6_172_839);
    assert_eq!(env.token_balance(&b_ata), 6_172_839);
    assert_eq!(env.token_balance(&vault_usdc()), 1);
    env.assert_conserved();
}

#[test]
fn zero_and_one_unit_are_harmless_no_ops() {
    let mut env = Env::ready();
    let a_ata = env.ata(&RECIPIENT_A);
    // Nothing to allocate or pay.
    env.crank(env.allocate_sol_ix()).unwrap();
    env.crank(env.allocate_usdc_ix()).unwrap();
    env.crank(env.pay_sol_ix(Side::A, RECIPIENT_A)).unwrap();
    env.crank(env.pay_usdc_ix(Side::A, a_ata)).unwrap();
    assert_eq!(env.vault().sol, Ledger::default());

    env.donate_sol(1);
    env.donate_usdc(1);
    env.crank(env.allocate_sol_ix()).unwrap();
    env.crank(env.allocate_usdc_ix()).unwrap();
    assert_eq!(env.vault().sol.owed, [0, 0]);
    assert_eq!(env.vault().usdc.owed, [0, 0]);
    env.assert_conserved();
}

#[test]
fn repeated_allocation_does_not_double_count() {
    let mut env = Env::ready();
    env.donate_sol(10 * SOL);
    for _ in 0..3 {
        env.crank(env.allocate_sol_ix()).unwrap();
    }
    assert_eq!(env.vault().sol.owed, [5 * SOL, 5 * SOL]);
    assert_eq!(env.vault().sol.allocated_each, 5 * SOL);
    env.assert_conserved();
}

#[test]
fn paying_one_side_early_never_changes_the_other_side() {
    let mut env = Env::ready();
    env.donate_sol(4 * SOL);
    env.crank(env.allocate_sol_ix()).unwrap();
    env.crank(env.pay_sol_ix(Side::A, RECIPIENT_A)).unwrap();
    env.donate_sol(2 * SOL);
    env.crank(env.allocate_sol_ix()).unwrap();
    let v = env.vault();
    assert_eq!(v.sol.owed, [SOL, 3 * SOL]);
    assert_eq!(v.sol.paid, [2 * SOL, 0]);
    assert_eq!(v.sol.allocated_each, 3 * SOL);
    env.assert_conserved();
}

#[test]
fn cranker_receives_nothing() {
    let mut env = Env::ready();
    env.donate_sol(4 * SOL);
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    let ixs = [
        env.allocate_sol_ix(),
        env.pay_sol_ix(Side::A, RECIPIENT_A),
        env.pay_sol_ix(Side::B, RECIPIENT_B),
    ];
    env.send(&ixs, &[&stranger]).unwrap();
    assert!(env.lamports(&stranger.pubkey()) < SOL, "only fees moved");
}

// ---------- substituted and aliased accounts ----------

#[test]
fn sol_payout_cannot_be_redirected() {
    let mut env = Env::ready();
    env.donate_sol(2 * SOL);
    env.crank(env.allocate_sol_ix()).unwrap();
    let thief = Keypair::new().pubkey();
    expect_err(
        env.crank(env.pay_sol_ix(Side::A, thief)),
        "WrongDestination",
    );
    expect_err(
        env.crank(env.pay_sol_ix(Side::A, RECIPIENT_B)),
        "WrongDestination",
    );
    expect_err(
        env.crank(env.pay_sol_ix(Side::A, vault_pda())),
        "WrongDestination",
    );
    assert_eq!(env.vault().sol.owed, [SOL, SOL]);
}

#[test]
fn usdc_payout_cannot_be_redirected() {
    let mut env = Env::ready();
    let b_ata = env.ata(&RECIPIENT_B);
    let thief_ata = env.ata(&Keypair::new().pubkey());
    env.donate_usdc(2_000_000);
    env.crank(env.allocate_usdc_ix()).unwrap();
    expect_err(
        env.crank(env.pay_usdc_ix(Side::A, thief_ata)),
        "WrongDestination",
    );
    expect_err(
        env.crank(env.pay_usdc_ix(Side::A, b_ata)),
        "WrongDestination",
    );
    assert!(
        env.crank(env.pay_usdc_ix(Side::A, vault_usdc())).is_err(),
        "source/destination alias"
    );
    assert_eq!(env.vault().usdc.owed, [1_000_000, 1_000_000]);
}

#[test]
fn fake_vault_wrong_mint_and_wrong_token_program_are_rejected() {
    let mut env = Env::ready();
    let a_ata = env.ata(&RECIPIENT_A);
    env.donate_usdc(2_000_000);
    env.crank(env.allocate_usdc_ix()).unwrap();

    // A look-alike vault account the program does not own.
    let fake_vault = Keypair::new().pubkey();
    let mut ix = env.pay_usdc_ix(Side::A, a_ata);
    ix.accounts[0] = AccountMeta::new(fake_vault, false);
    assert!(env.crank(ix).is_err());

    // A different mint, with a recipient-owned account for it.
    let other = Keypair::new();
    env.create_mint(&other, None);
    let other_dest = env.token_account(&other.pubkey(), &RECIPIENT_A);
    let mut ix = env.pay_usdc_ix(Side::A, other_dest);
    ix.accounts[3] = AccountMeta::new_readonly(other.pubkey(), false);
    assert!(env.crank(ix).is_err());

    // Token-2022 in place of the classic token program.
    let mut ix = env.pay_usdc_ix(Side::A, a_ata);
    ix.accounts[4] = AccountMeta::new_readonly(spl_token_2022_id(), false);
    assert!(env.crank(ix).is_err());

    // The vault's own token account passed as both source and destination slot.
    let mut ix = env.pay_usdc_ix(Side::A, a_ata);
    ix.accounts[1] = AccountMeta::new(a_ata, false);
    assert!(env.crank(ix).is_err());

    assert_eq!(env.vault().usdc.owed, [1_000_000, 1_000_000]);
    env.assert_conserved();
}

fn spl_token_2022_id() -> Pubkey {
    Pubkey::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
}

// ---------- one broken side never blocks the other ----------

#[test]
fn frozen_destination_blocks_only_that_side() {
    let mut env = Env::ready();
    let (a_ata, b_ata) = (env.ata(&RECIPIENT_A), env.ata(&RECIPIENT_B));
    let freeze = token::instruction::freeze_account(
        &token::ID,
        &a_ata,
        &USDC_MINT,
        &env.freeze_authority.pubkey(),
        &[],
    )
    .unwrap();
    let (payer, fa) = (
        env.payer.insecure_clone(),
        env.freeze_authority.insecure_clone(),
    );
    env.send(&[freeze], &[&payer, &fa]).unwrap();

    env.donate_usdc(4_000_000);
    env.crank(env.allocate_usdc_ix()).unwrap();
    assert!(env.crank(env.pay_usdc_ix(Side::A, a_ata)).is_err());
    env.crank(env.pay_usdc_ix(Side::B, b_ata)).unwrap();
    assert_eq!(env.token_balance(&b_ata), 2_000_000);
    assert_eq!(
        env.vault().usdc.owed,
        [2_000_000, 0],
        "A's half is still owed"
    );

    // A uses another account it owns.
    let a_other = env.token_account(&USDC_MINT, &RECIPIENT_A);
    env.crank(env.pay_usdc_ix(Side::A, a_other)).unwrap();
    assert_eq!(env.token_balance(&a_other), 2_000_000);
    env.assert_conserved();
}

#[test]
fn reassigned_destination_blocks_only_that_side() {
    let mut env = Env::ready();
    let (a_ata, b_ata) = (env.ata(&RECIPIENT_A), env.ata(&RECIPIENT_B));
    let elsewhere = Keypair::new().pubkey();
    let set_owner = token::instruction::set_authority(
        &token::ID,
        &a_ata,
        Some(&elsewhere),
        token::instruction::AuthorityType::AccountOwner,
        &RECIPIENT_A,
        &[],
    )
    .unwrap();
    let a = env.a.insecure_clone();
    env.send(&[set_owner], &[&a]).unwrap();

    env.donate_usdc(4_000_000);
    env.crank(env.allocate_usdc_ix()).unwrap();
    expect_err(
        env.crank(env.pay_usdc_ix(Side::A, a_ata)),
        "WrongDestination",
    );
    env.crank(env.pay_usdc_ix(Side::B, b_ata)).unwrap();
    assert_eq!(env.vault().usdc.owed, [2_000_000, 0]);

    let a_other = env.token_account(&USDC_MINT, &RECIPIENT_A);
    env.crank(env.pay_usdc_ix(Side::A, a_other)).unwrap();
    env.assert_conserved();
}

#[test]
fn closed_destination_blocks_only_that_side() {
    let mut env = Env::ready();
    let (a_ata, b_ata) = (env.ata(&RECIPIENT_A), env.ata(&RECIPIENT_B));
    let close =
        token::instruction::close_account(&token::ID, &a_ata, &RECIPIENT_A, &RECIPIENT_A, &[])
            .unwrap();
    let a = env.a.insecure_clone();
    env.send(&[close], &[&a]).unwrap();

    env.donate_usdc(4_000_000);
    env.crank(env.allocate_usdc_ix()).unwrap();
    assert!(env.crank(env.pay_usdc_ix(Side::A, a_ata)).is_err());
    env.crank(env.pay_usdc_ix(Side::B, b_ata)).unwrap();
    assert_eq!(env.vault().usdc.owed, [2_000_000, 0]);
    env.assert_conserved();
}

// SOL payouts are isolated per side the same way USDC payouts are: pay_sol(A)
// and pay_sol(B) are separate instructions. The one SOL-side failure mode that
// matters on mainnet, a payout too small to make an empty wallet rent-exempt,
// isn't enforced by LiteSVM, so it's covered by the devnet rehearsal (gate 2 in
// DEPLOY.md) instead of here.

// ---------- rotation ----------

#[test]
fn only_the_current_side_key_can_rotate_and_owed_balance_follows() {
    let mut env = Env::ready();
    env.donate_sol(2 * SOL);
    env.crank(env.allocate_sol_ix()).unwrap();

    let new_a = Keypair::new();
    let (a, b) = (env.a.insecure_clone(), env.b.insecure_clone());
    // B can't move A's side; a stranger can't either.
    expect_err(
        env.send(&[env.rotate_ix(RECIPIENT_B, Side::A, RECIPIENT_B)], &[&b]),
        "Unauthorized",
    );
    let stranger = Keypair::new();
    env.svm.airdrop(&stranger.pubkey(), SOL).unwrap();
    expect_err(
        env.send(
            &[env.rotate_ix(stranger.pubkey(), Side::A, stranger.pubkey())],
            &[&stranger],
        ),
        "Unauthorized",
    );

    // Bad targets.
    expect_err(
        env.send(&[env.rotate_ix(RECIPIENT_A, Side::A, RECIPIENT_B)], &[&a]),
        "DuplicateRecipient",
    );
    expect_err(
        env.send(&[env.rotate_ix(RECIPIENT_A, Side::A, vault_pda())], &[&a]),
        "InvalidRecipient",
    );
    expect_err(
        env.send(&[env.rotate_ix(RECIPIENT_A, Side::A, vault_usdc())], &[&a]),
        "InvalidRecipient",
    );
    expect_err(
        env.send(
            &[env.rotate_ix(RECIPIENT_A, Side::A, Pubkey::default())],
            &[&a],
        ),
        "InvalidRecipient",
    );
    expect_err(
        env.send(&[env.rotate_ix(RECIPIENT_A, Side::A, RECIPIENT_A)], &[&a]),
        "SameRecipient",
    );

    env.send(
        &[env.rotate_ix(RECIPIENT_A, Side::A, new_a.pubkey())],
        &[&a],
    )
    .unwrap();
    let v = env.vault();
    assert_eq!(v.recipients, [new_a.pubkey(), RECIPIENT_B]);
    assert_eq!(
        v.sol.owed,
        [SOL, SOL],
        "owed balances unchanged by rotation"
    );

    // Old key is powerless now; payouts go to the new key.
    expect_err(
        env.send(&[env.rotate_ix(RECIPIENT_A, Side::A, RECIPIENT_A)], &[&a]),
        "Unauthorized",
    );
    expect_err(
        env.crank(env.pay_sol_ix(Side::A, RECIPIENT_A)),
        "WrongDestination",
    );
    env.crank(env.pay_sol_ix(Side::A, new_a.pubkey())).unwrap();
    assert_eq!(env.lamports(&new_a.pubkey()), SOL);
    env.assert_conserved();
}

// ---------- randomized sequence ----------

/// Small deterministic PRNG so the test needs no extra crates and is reproducible.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
}

#[test]
fn randomized_operations_conserve_funds_and_stay_equal() {
    let mut env = Env::ready();
    let (a_ata, b_ata) = (env.ata(&RECIPIENT_A), env.ata(&RECIPIENT_B));
    let mut rng = Lcg(0xC0FFEE);
    let (mut sol_in, mut usdc_in) = (0u64, 0u64);
    let (a_sol0, b_sol0) = (env.lamports(&RECIPIENT_A), env.lamports(&RECIPIENT_B));

    for _ in 0..150 {
        match rng.next() % 6 {
            0 => {
                let amt = 1 + rng.next() % (3 * SOL);
                env.donate_sol(amt);
                sol_in += amt;
            }
            1 => {
                let amt = 1 + rng.next() % 50_000_000;
                env.donate_usdc(amt);
                usdc_in += amt;
            }
            2 => env.crank(env.allocate_sol_ix()).unwrap(),
            3 => env.crank(env.allocate_usdc_ix()).unwrap(),
            4 => {
                let (side, to) = if rng.next().is_multiple_of(2) {
                    (Side::A, RECIPIENT_A)
                } else {
                    (Side::B, RECIPIENT_B)
                };
                env.crank(env.pay_sol_ix(side, to)).unwrap();
            }
            _ => {
                let (side, to) = if rng.next().is_multiple_of(2) {
                    (Side::A, a_ata)
                } else {
                    (Side::B, b_ata)
                };
                env.crank(env.pay_usdc_ix(side, to)).unwrap();
            }
        }
        env.assert_conserved();
    }

    // Drain everything and check every unit is accounted for.
    for ix in [env.allocate_sol_ix(), env.allocate_usdc_ix()] {
        env.crank(ix).unwrap();
    }
    for ix in [
        env.pay_sol_ix(Side::A, RECIPIENT_A),
        env.pay_sol_ix(Side::B, RECIPIENT_B),
        env.pay_usdc_ix(Side::A, a_ata),
        env.pay_usdc_ix(Side::B, b_ata),
    ] {
        env.crank(ix).unwrap();
    }
    let a_sol = env.lamports(&RECIPIENT_A) - a_sol0;
    let b_sol = env.lamports(&RECIPIENT_B) - b_sol0;
    assert_eq!(a_sol, b_sol);
    assert_eq!(a_sol + b_sol + env.sol_unallocated(), sol_in);
    assert!(env.sol_unallocated() <= 1);
    let (a_usdc, b_usdc) = (env.token_balance(&a_ata), env.token_balance(&b_ata));
    assert_eq!(a_usdc, b_usdc);
    assert_eq!(a_usdc + b_usdc + env.usdc_unallocated(), usdc_in);
    assert!(env.usdc_unallocated() <= 1);
}
