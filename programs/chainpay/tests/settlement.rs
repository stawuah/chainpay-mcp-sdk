use anchor_lang::solana_program::{pubkey::Pubkey, system_program};
use anchor_lang::{InstructionData, ToAccountMetas};
use chainpay::instructions::create_mandate::MandateParams;
use chainpay::instructions::execute_payment::PaymentParams;
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

fn run_settlement(kind: TokenKind) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(chainpay::ID, program_path())
        .unwrap();

    let owner = Keypair::new();
    let agent = Keypair::new();// agent  should not have an account if and agent should have an account/address it should be newly created for the purpose of sendfing or something 
    let source = Keypair::new();
    let recipient = Keypair::new();
    let mint = Keypair::new();
    let merchant_owner = Pubkey::new_unique();
    let token_program = kind.program_id();
    let (config, _) = Pubkey::find_program_address(&[b"config"], &chainpay::ID);
    let (asset, _) =
        Pubkey::find_program_address(&[b"asset", mint.pubkey().as_ref()], &chainpay::ID);
    let (mandate, _) = Pubkey::find_program_address(
        &[
            b"mandate",
            owner.pubkey().as_ref(),
            mint.pubkey().as_ref(),
        ],
        &chainpay::ID,
    );
    let invoice_hash = [11u8; 32];
    let payment_id = [12u8; 32];
    let signature_reference = [13u8; 32];
    let (receipt, _) = Pubkey::find_program_address(
        &[b"receipt", mandate.as_ref(), invoice_hash.as_ref()],
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
                supported_mints: [mint.pubkey(), Pubkey::default(), Pubkey::default()],
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

    assert_eq!(token_balance(&svm, &recipient.pubkey()), PAYMENT_AMOUNT);
    assert!(svm.get_account(&receipt).is_some());

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
}

#[test]
fn settles_through_classic_spl_token_and_rejects_replay() {
    run_settlement(TokenKind::Spl);
}

#[test]
fn settles_through_token_2022_and_rejects_replay() {
    run_settlement(TokenKind::Token2022);
}
