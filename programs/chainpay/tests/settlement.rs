use anchor_lang::solana_program::{pubkey::Pubkey, system_program};
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use chainpay::instructions::create_mandate::MandateParams;
use chainpay::instructions::execute_payment::PaymentParams;
use chainpay::state::{PaymentMandate, PaymentReceipt};
use chainpay::{accounts, instruction};
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_system_interface::instruction::create_account;
use solana_transaction::Transaction;
use spl_token_2022_interface as token_2022;
use spl_token_interface as token;
use std::path::PathBuf;

const DECIMALS: u8 = 6;
const MINT_SPACE: usize = 82;
const TOKEN_ACCOUNT_SPACE: usize = 165;
const INITIAL_BALANCE: u64 = 1_000;
const PAYMENT_AMOUNT: u64 = 250;

#[derive(Clone, Copy)]
enum TokenKind {
    Spl,
    Token2022,
}

impl TokenKind {
    fn program_id(self) -> Pubkey {
        match self {
            Self::Spl => token::ID,
            Self::Token2022 => token_2022::ID,
        }
    }

    fn initialize_mint(self, mint: &Pubkey, authority: &Pubkey) -> solana_instruction::Instruction {
        match self {
            Self::Spl => {
                token::instruction::initialize_mint2(&token::ID, mint, authority, None, DECIMALS)
                    .unwrap()
            }
            Self::Token2022 => token_2022::instruction::initialize_mint2(
                &token_2022::ID,
                mint,
                authority,
                None,
                DECIMALS,
            )
            .unwrap(),
        }
    }

    fn initialize_account(
        self,
        account: &Pubkey,
        mint: &Pubkey,
        owner: &Pubkey,
    ) -> solana_instruction::Instruction {
        match self {
            Self::Spl => {
                token::instruction::initialize_account3(&token::ID, account, mint, owner).unwrap()
            }
            Self::Token2022 => {
                token_2022::instruction::initialize_account3(&token_2022::ID, account, mint, owner)
                    .unwrap()
            }
        }
    }

    fn mint_to(
        self,
        mint: &Pubkey,
        destination: &Pubkey,
        authority: &Pubkey,
        amount: u64,
    ) -> solana_instruction::Instruction {
        match self {
            Self::Spl => {
                token::instruction::mint_to(&token::ID, mint, destination, authority, &[], amount)
                    .unwrap()
            }
            Self::Token2022 => token_2022::instruction::mint_to(
                &token_2022::ID,
                mint,
                destination,
                authority,
                &[],
                amount,
            )
            .unwrap(),
        }
    }

    fn approve(
        self,
        source: &Pubkey,
        delegate: &Pubkey,
        owner: &Pubkey,
        amount: u64,
    ) -> solana_instruction::Instruction {
        match self {
            Self::Spl => {
                token::instruction::approve(&token::ID, source, delegate, owner, &[], amount)
                    .unwrap()
            }
            Self::Token2022 => token_2022::instruction::approve(
                &token_2022::ID,
                source,
                delegate,
                owner,
                &[],
                amount,
            )
            .unwrap(),
        }
    }
}

fn submit(
    svm: &mut LiteSVM,
    instructions: Vec<solana_instruction::Instruction>,
    signers: &[&Keypair],
) {
    let payer = signers[0].pubkey();
    let message = Message::new(&instructions, Some(&payer));
    let transaction = Transaction::new(signers, message, svm.latest_blockhash());
    svm.send_transaction(transaction).unwrap();
}

fn chainpay_instruction<I: InstructionData>(
    accounts: impl ToAccountMetas,
    data: I,
) -> solana_instruction::Instruction {
    solana_instruction::Instruction {
        program_id: chainpay::ID,
        accounts: accounts.to_account_metas(None),
        data: data.data(),
    }
}

fn token_balance(svm: &LiteSVM, address: &Pubkey) -> u64 {
    let account = svm.get_account(address).expect("token account exists");
    u64::from_le_bytes(account.data[64..72].try_into().unwrap())
}

fn program_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/deploy/chainpay.so")
}

fn mandate_nonce() -> Pubkey {
    let mut bytes = [0u8; 32];
    bytes[..8].copy_from_slice(b"CPNONCE!");
    bytes[8] = 1;
    Pubkey::new_from_array(bytes)
}

struct Fixture {
    svm: LiteSVM,
    owner: Keypair,
    agent: Keypair,
    source: Keypair,
    recipient: Keypair,
    mint: Keypair,
    token_program: Pubkey,
    config: Pubkey,
    asset: Pubkey,
    mandate: Pubkey,
    expiration: u64,
}

impl Fixture {
    fn payment(
        &self,
        invoice_hash: [u8; 32],
        payment_seed: u8,
        amount: u64,
    ) -> (solana_instruction::Instruction, Pubkey) {
        let (receipt, _) = Pubkey::find_program_address(
            &[b"receipt", self.mandate.as_ref(), invoice_hash.as_ref()],
            &chainpay::ID,
        );
        let instruction = chainpay_instruction(
            accounts::ExecutePayment {
                config: self.config,
                asset_registry: self.asset,
                mandate: self.mandate,
                receipt,
                agent: self.agent.pubkey(),
                allowed_mint: self.mint.pubkey(),
                source_token_account: self.source.pubkey(),
                recipient_token_account: self.recipient.pubkey(),
                token_program: self.token_program,
                system_program: system_program::ID,
            },
            instruction::ExecutePayment {
                params: PaymentParams {
                    invoice_hash,
                    payment_id: [payment_seed; 32],
                    signature_reference: [payment_seed.wrapping_add(1); 32],
                    amount,
                },
            },
        );
        (instruction, receipt)
    }

    fn mandate_state(&self) -> PaymentMandate {
        let account = self.svm.get_account(&self.mandate).expect("mandate exists");
        PaymentMandate::try_deserialize(&mut account.data.as_slice()).unwrap()
    }

    fn receipt_state(&self, receipt: &Pubkey) -> PaymentReceipt {
        let account = self.svm.get_account(receipt).expect("receipt exists");
        assert_eq!(account.data.len(), 8 + PaymentReceipt::LEN);
        PaymentReceipt::try_deserialize(&mut account.data.as_slice()).unwrap()
    }
}

/// Asserts that a receipt's policy snapshot matches the mandate as it stood
/// immediately after the payment that created the receipt.
fn assert_snapshot_matches(receipt: &PaymentReceipt, mandate: &PaymentMandate) {
    assert_eq!(receipt.snapshot_version, chainpay::RECEIPT_SNAPSHOT_VERSION);
    assert_eq!(receipt.policy_max_per_payment, mandate.max_per_payment);
    assert_eq!(receipt.policy_total_limit, mandate.total_limit);
    assert_eq!(receipt.policy_amount_spent_after, mandate.amount_spent);
    assert_eq!(receipt.policy_payment_count_after, mandate.payment_count);
    assert_eq!(receipt.policy_max_payment_count, mandate.max_payment_count);
    assert_eq!(receipt.policy_expires_at_slot, mandate.expires_at_slot);
    assert_eq!(receipt.policy_cooldown_slots, mandate.cooldown_slots);
    assert_eq!(receipt.reserved, [0u8; 32]);
}

/// Creates config, asset registry, a nonce-scoped mandate, and the token
/// delegation, leaving the mandate ready for its first payment.
fn setup(kind: TokenKind) -> Fixture {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(chainpay::ID, program_path())
        .unwrap();

    let owner = Keypair::new();
    let agent = Keypair::new(); // agent  should not have an account if and agent should have an account/address it should be newly created for the purpose of sendfing or something
    let source = Keypair::new();
    let recipient = Keypair::new();
    let mint = Keypair::new();
    let merchant_owner = Pubkey::new_unique();
    let token_program = kind.program_id();
    let mandate_nonce = mandate_nonce();
    let (config, _) = Pubkey::find_program_address(&[b"config"], &chainpay::ID);
    let (asset, _) =
        Pubkey::find_program_address(&[b"asset", mint.pubkey().as_ref()], &chainpay::ID);
    let (mandate, _) = Pubkey::find_program_address(
        &[
            b"mandate",
            owner.pubkey().as_ref(),
            mint.pubkey().as_ref(),
            mandate_nonce.as_ref(),
        ],
        &chainpay::ID,
    );

    svm.airdrop(&owner.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&agent.pubkey(), 10_000_000_000).unwrap();

    let mint_rent = svm.minimum_balance_for_rent_exemption(MINT_SPACE);
    let account_rent = svm.minimum_balance_for_rent_exemption(TOKEN_ACCOUNT_SPACE);
    submit(
        &mut svm,
        vec![
            create_account(
                &owner.pubkey(),
                &mint.pubkey(),
                mint_rent,
                MINT_SPACE as u64,
                &token_program,
            ),
            kind.initialize_mint(&mint.pubkey(), &owner.pubkey()),
        ],
        &[&owner, &mint],
    );
    submit(
        &mut svm,
        vec![
            create_account(
                &owner.pubkey(),
                &source.pubkey(),
                account_rent,
                TOKEN_ACCOUNT_SPACE as u64,
                &token_program,
            ),
            kind.initialize_account(&source.pubkey(), &mint.pubkey(), &owner.pubkey()),
            create_account(
                &owner.pubkey(),
                &recipient.pubkey(),
                account_rent,
                TOKEN_ACCOUNT_SPACE as u64,
                &token_program,
            ),
            kind.initialize_account(&recipient.pubkey(), &mint.pubkey(), &merchant_owner),
            kind.mint_to(
                &mint.pubkey(),
                &source.pubkey(),
                &owner.pubkey(),
                INITIAL_BALANCE,
            ),
        ],
        &[&owner, &source, &recipient],
    );

    let expiration = svm
        .get_sysvar::<anchor_lang::solana_program::clock::Clock>()
        .slot
        + 1_000;
    submit(
        &mut svm,
        vec![chainpay_instruction(
            accounts::InitializeConfig {
                config,
                authority: owner.pubkey(),
                system_program: system_program::ID,
            },
            instruction::InitializeConfig {
                // This legacy bootstrap list deliberately excludes the payment
                // mint. SupportedAsset is the sole scalable authorization gate.
                supported_mints: [Pubkey::new_unique(), Pubkey::default(), Pubkey::default()],
            },
        )],
        &[&owner],
    );
    submit(
        &mut svm,
        vec![chainpay_instruction(
            accounts::RegisterAsset {
                config,
                asset,
                authority: owner.pubkey(),
                mint_account: mint.pubkey(),
                token_program,
                system_program: system_program::ID,
            },
            instruction::RegisterAsset {
                mint: mint.pubkey(),
            },
        )],
        &[&owner],
    );
    submit(
        &mut svm,
        vec![chainpay_instruction(
            accounts::CreateMandate {
                config,
                asset_registry: asset,
                mandate,
                owner: owner.pubkey(),
                allowed_mint: mint.pubkey(),
                source_token_account: source.pubkey(),
                token_program,
                system_program: system_program::ID,
            },
            instruction::CreateMandate {
                params: MandateParams {
                    approved_agent: agent.pubkey(),
                    source_token_account: source.pubkey(),
                    allowed_mint: mint.pubkey(),
                    max_per_payment: PAYMENT_AMOUNT,
                    total_limit: INITIAL_BALANCE,
                    expires_at_slot: expiration,
                    max_payment_count: 0,
                    cooldown_slots: 0,
                    mandate_nonce,
                },
            },
        )],
        &[&owner],
    );
    submit(
        &mut svm,
        vec![kind.approve(&source.pubkey(), &mandate, &owner.pubkey(), INITIAL_BALANCE)],
        &[&owner],
    );

    Fixture {
        svm,
        owner,
        agent,
        source,
        recipient,
        mint,
        token_program,
        config,
        asset,
        mandate,
        expiration,
    }
}

fn run_settlement(label: &str, kind: TokenKind) {
    let fixture = setup(kind);
    let Fixture {
        mut svm,
        owner,
        agent,
        source,
        recipient,
        mint,
        token_program,
        config,
        asset,
        mandate,
        expiration,
    } = fixture;
    let invoice_hash = [11u8; 32];
    let payment_id = [12u8; 32];
    let signature_reference = [13u8; 32];
    let (receipt, _) = Pubkey::find_program_address(
        &[b"receipt", mandate.as_ref(), invoice_hash.as_ref()],
        &chainpay::ID,
    );

    submit(
        &mut svm,
        vec![chainpay_instruction(
            accounts::ExecutePayment {
                config,
                asset_registry: asset,
                mandate,
                receipt,
                agent: agent.pubkey(),
                allowed_mint: mint.pubkey(),
                source_token_account: source.pubkey(),
                recipient_token_account: recipient.pubkey(),
                token_program,
                system_program: system_program::ID,
            },
            instruction::ExecutePayment {
                params: PaymentParams {
                    invoice_hash,
                    payment_id,
                    signature_reference,
                    amount: PAYMENT_AMOUNT,
                },
            },
        )],
        &[&agent],
    );

    assert_eq!(
        token_balance(&svm, &recipient.pubkey()),
        PAYMENT_AMOUNT,
        "{label} recipient balance did not increase"
    );
    assert!(
        svm.get_account(&receipt).is_some(),
        "{label} receipt was not created"
    );
    let receipt_account = svm.get_account(&receipt).unwrap();
    assert_eq!(receipt_account.data.len(), 8 + PaymentReceipt::LEN);
    let receipt_state = PaymentReceipt::try_deserialize(&mut receipt_account.data.as_slice())
        .expect("receipt decodes");
    let mandate_state =
        PaymentMandate::try_deserialize(&mut svm.get_account(&mandate).unwrap().data.as_slice())
            .expect("mandate decodes");
    assert_eq!(mandate_state.amount_spent, PAYMENT_AMOUNT);
    assert_eq!(mandate_state.payment_count, 1);
    assert_snapshot_matches(&receipt_state, &mandate_state);
    assert_eq!(receipt_state.policy_max_per_payment, PAYMENT_AMOUNT);
    assert_eq!(receipt_state.policy_total_limit, INITIAL_BALANCE);
    assert_eq!(receipt_state.policy_expires_at_slot, expiration);

    let duplicate = chainpay_instruction(
        accounts::ExecutePayment {
            config,
            asset_registry: asset,
            mandate,
            receipt,
            agent: agent.pubkey(),
            allowed_mint: mint.pubkey(),
            source_token_account: source.pubkey(),
            recipient_token_account: recipient.pubkey(),
            token_program,
            system_program: system_program::ID,
        },
        instruction::ExecutePayment {
            params: PaymentParams {
                invoice_hash,
                payment_id: [14u8; 32],
                signature_reference: [15u8; 32],
                amount: PAYMENT_AMOUNT,
            },
        },
    );
    let duplicate_transaction = Transaction::new(
        &[&agent],
        Message::new(&[duplicate], Some(&agent.pubkey())),
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(duplicate_transaction).is_err());
    assert_eq!(token_balance(&svm, &recipient.pubkey()), PAYMENT_AMOUNT);

    let invalid_invoice_hash = [21u8; 32];
    let (invalid_receipt, _) = Pubkey::find_program_address(
        &[b"receipt", mandate.as_ref(), invalid_invoice_hash.as_ref()],
        &chainpay::ID,
    );
    let invalid_amount = chainpay_instruction(
        accounts::ExecutePayment {
            config,
            asset_registry: asset,
            mandate,
            receipt: invalid_receipt,
            agent: agent.pubkey(),
            allowed_mint: mint.pubkey(),
            source_token_account: source.pubkey(),
            recipient_token_account: recipient.pubkey(),
            token_program,
            system_program: system_program::ID,
        },
        instruction::ExecutePayment {
            params: PaymentParams {
                invoice_hash: invalid_invoice_hash,
                payment_id: [22u8; 32],
                signature_reference: [23u8; 32],
                amount: PAYMENT_AMOUNT + 1,
            },
        },
    );
    let invalid_transaction = Transaction::new(
        &[&agent],
        Message::new(&[invalid_amount], Some(&agent.pubkey())),
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(invalid_transaction).is_err());
    assert!(svm.get_account(&invalid_receipt).is_none());
    assert_eq!(token_balance(&svm, &recipient.pubkey()), PAYMENT_AMOUNT);

    // A second policy for the same owner and mint must get its own PDA.
    let mut second_nonce_bytes = [0u8; 32];
    second_nonce_bytes[..8].copy_from_slice(b"CPNONCE!");
    second_nonce_bytes[8] = 2;
    let second_nonce = Pubkey::new_from_array(second_nonce_bytes);
    let (second_mandate, _) = Pubkey::find_program_address(
        &[
            b"mandate",
            owner.pubkey().as_ref(),
            mint.pubkey().as_ref(),
            second_nonce.as_ref(),
        ],
        &chainpay::ID,
    );
    assert_ne!(mandate, second_mandate);
    submit(
        &mut svm,
        vec![chainpay_instruction(
            accounts::CreateMandate {
                config,
                asset_registry: asset,
                mandate: second_mandate,
                owner: owner.pubkey(),
                allowed_mint: mint.pubkey(),
                source_token_account: source.pubkey(),
                token_program,
                system_program: system_program::ID,
            },
            instruction::CreateMandate {
                params: MandateParams {
                    approved_agent: agent.pubkey(),
                    source_token_account: source.pubkey(),
                    allowed_mint: mint.pubkey(),
                    max_per_payment: PAYMENT_AMOUNT,
                    total_limit: INITIAL_BALANCE,
                    expires_at_slot: expiration,
                    max_payment_count: 0,
                    cooldown_slots: 0,
                    mandate_nonce: second_nonce,
                },
            },
        )],
        &[&owner],
    );
    submit(
        &mut svm,
        vec![kind.approve(
            &source.pubkey(),
            &second_mandate,
            &owner.pubkey(),
            INITIAL_BALANCE,
        )],
        &[&owner],
    );
    assert!(svm.get_account(&second_mandate).is_some());

    // Disabling the registry entry must stop settlement even though the legacy
    // config, mandate, delegation, mint, and token accounts remain valid.
    submit(
        &mut svm,
        vec![chainpay_instruction(
            accounts::SetAssetStatus {
                config,
                asset,
                authority: owner.pubkey(),
            },
            instruction::SetAssetStatus { enabled: false },
        )],
        &[&owner],
    );
    let disabled_invoice_hash = [31u8; 32];
    let (disabled_receipt, _) = Pubkey::find_program_address(
        &[
            b"receipt",
            second_mandate.as_ref(),
            disabled_invoice_hash.as_ref(),
        ],
        &chainpay::ID,
    );
    let disabled_payment = chainpay_instruction(
        accounts::ExecutePayment {
            config,
            asset_registry: asset,
            mandate: second_mandate,
            receipt: disabled_receipt,
            agent: agent.pubkey(),
            allowed_mint: mint.pubkey(),
            source_token_account: source.pubkey(),
            recipient_token_account: recipient.pubkey(),
            token_program,
            system_program: system_program::ID,
        },
        instruction::ExecutePayment {
            params: PaymentParams {
                invoice_hash: disabled_invoice_hash,
                payment_id: [32u8; 32],
                signature_reference: [33u8; 32],
                amount: PAYMENT_AMOUNT,
            },
        },
    );
    let disabled_transaction = Transaction::new(
        &[&agent],
        Message::new(&[disabled_payment], Some(&agent.pubkey())),
        svm.latest_blockhash(),
    );
    assert!(svm.send_transaction(disabled_transaction).is_err());
    assert!(svm.get_account(&disabled_receipt).is_none());
    assert_eq!(token_balance(&svm, &recipient.pubkey()), PAYMENT_AMOUNT);
}

#[test]
fn settles_usdc_through_classic_spl_token_and_rejects_replay() {
    run_settlement("USDC", TokenKind::Spl);
}

#[test]
fn settles_eurc_through_classic_spl_token_and_rejects_replay() {
    run_settlement("EURC", TokenKind::Spl);
}

#[test]
fn settles_pyusd_through_token_2022_and_rejects_replay() {
    run_settlement("PYUSD", TokenKind::Token2022);
}

#[test]
fn settles_usdg_through_token_2022_and_rejects_replay() {
    run_settlement("USDG", TokenKind::Token2022);
}

#[test]
fn receipt_snapshots_cumulative_policy_state_across_payments() {
    for kind in [TokenKind::Spl, TokenKind::Token2022] {
        let mut fixture = setup(kind);

        let (first, first_receipt) = fixture.payment([41u8; 32], 42, PAYMENT_AMOUNT);
        submit(&mut fixture.svm, vec![first], &[&fixture.agent]);
        let first_state = fixture.receipt_state(&first_receipt);
        assert_snapshot_matches(&first_state, &fixture.mandate_state());
        assert_eq!(first_state.policy_amount_spent_after, PAYMENT_AMOUNT);
        assert_eq!(first_state.policy_payment_count_after, 1);

        // A smaller second payment shows the snapshot records the running
        // total, not just this payment's amount.
        let second_amount = PAYMENT_AMOUNT - 100;
        let (second, second_receipt) = fixture.payment([43u8; 32], 44, second_amount);
        submit(&mut fixture.svm, vec![second], &[&fixture.agent]);
        let second_state = fixture.receipt_state(&second_receipt);
        assert_snapshot_matches(&second_state, &fixture.mandate_state());
        assert_eq!(second_state.amount, second_amount);
        assert_eq!(
            second_state.policy_amount_spent_after,
            PAYMENT_AMOUNT + second_amount
        );
        assert_eq!(second_state.policy_payment_count_after, 2);

        // The first receipt keeps the state at its own payment.
        let first_again = fixture.receipt_state(&first_receipt);
        assert_eq!(first_again.policy_amount_spent_after, PAYMENT_AMOUNT);
        assert_eq!(first_again.policy_payment_count_after, 1);

        assert_eq!(
            token_balance(&fixture.svm, &fixture.recipient.pubkey()),
            PAYMENT_AMOUNT + second_amount
        );
    }
}

#[test]
fn payment_count_overflow_is_reported_as_a_count_limit() {
    let mut fixture = setup(TokenKind::Spl);

    // No real mandate can reach u64::MAX payments, so write the counter
    // directly. max_payment_count stays 0 (unlimited), so only the overflow
    // can stop this payment.
    let mut mandate_state = fixture.mandate_state();
    assert_eq!(mandate_state.max_payment_count, 0);
    mandate_state.payment_count = u64::MAX;
    let mut mandate_account = fixture.svm.get_account(&fixture.mandate).unwrap();
    let mut data = Vec::with_capacity(mandate_account.data.len());
    mandate_state.try_serialize(&mut data).unwrap();
    data.resize(mandate_account.data.len(), 0);
    mandate_account.data = data;
    fixture
        .svm
        .set_account(fixture.mandate, mandate_account)
        .unwrap();

    let (payment, receipt) = fixture.payment([51u8; 32], 52, PAYMENT_AMOUNT);
    let transaction = Transaction::new(
        &[&fixture.agent],
        Message::new(&[payment], Some(&fixture.agent.pubkey())),
        fixture.svm.latest_blockhash(),
    );
    let failure = fixture.svm.send_transaction(transaction).unwrap_err();
    let code = u32::from(chainpay::errors::ChainPayError::PaymentCountExceeded);
    assert!(
        format!("{:?}", failure.err).contains(&format!("Custom({code})")),
        "expected PaymentCountExceeded ({code}), got {:?}: {:?}",
        failure.err,
        failure.meta.logs
    );
    assert!(fixture.svm.get_account(&receipt).is_none());
    assert_eq!(token_balance(&fixture.svm, &fixture.recipient.pubkey()), 0);
}
