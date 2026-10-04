//! Statement repayment through the ChainPay program (contracts.md §4.2, §7.2).
//!
//! 1. `repay_statement` (base layer, owner-signed): this card's repay agent PDA
//!    signs ChainPay `execute_payment` by CPI, as the `approved_agent` of a
//!    normal mandate the owner created. ChainPay enforces the mandate's limits,
//!    moves the tokens and creates the receipt PDA
//!    `["receipt", mandate, statement_digest]`. Nothing delegated is written:
//!    only the binding (never delegated) is read.
//! 2. `record_repayment` (PER, authorizer-signed): takes that receipt read-only
//!    (the rollup clones undelegated accounts) and lowers the outstanding
//!    balance only when the receipt proves the payment.
//!
//! `record_private_repayment` is the opt-in MagicBlock private payment path.
//! Its settlement has no ChainPay receipt (the vault hides the payer by
//! design), so it stays authorizer-attested and is marked as such in the ledger.

use crate::{
    chainpay::{
        self,
        accounts::{PaymentMandate, PaymentReceipt},
        program::Chainpay,
        types::PaymentParams,
    },
    constants::*,
    errors::CardPolicyError,
    hashes::{append_ledger, LedgerEvent},
    instructions::{common::*, FreezeCard},
    policy::sub,
    state::{CardBinding, CardPeriod, CardPolicy},
};
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use solana_sha256_hasher::hashv;

const SPL_TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

pub fn repay_agent_address(binding: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[REPAY_AGENT_SEED, binding.as_ref()], &crate::ID)
}

/// Deterministic per card + statement, so a retried repayment carries the same
/// receipt fields.
pub fn repayment_references(binding: &Pubkey, digest: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    (
        hashv(&[REPAY_PAYMENT_ID_DOMAIN, binding.as_ref(), digest]).to_bytes(),
        hashv(&[REPAY_SIGNATURE_REF_DOMAIN, binding.as_ref(), digest]).to_bytes(),
    )
}

// ---------------------------------------------------------- repay_statement

#[derive(Accounts)]
pub struct RepayStatement<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        has_one = owner @ CardPolicyError::Unauthorized,
        seeds = [CARD_BINDING_SEED, owner.key().as_ref(), binding.card_id.as_ref()],
        bump = binding.bump,
    )]
    pub binding: Box<Account<'info, CardBinding>>,
    /// Lamport-only, system-owned. Pays the receipt rent the owner hands it in
    /// this instruction and ends the instruction empty.
    #[account(mut, seeds = [REPAY_AGENT_SEED, binding.key().as_ref()], bump)]
    pub repay_agent: SystemAccount<'info>,
    /// CHECK: ChainPay config PDA; ChainPay checks it.
    pub chainpay_config: UncheckedAccount<'info>,
    /// CHECK: ChainPay asset registry PDA; ChainPay checks it.
    pub asset_registry: UncheckedAccount<'info>,
    /// The owner's ChainPay mandate whose approved agent is this card's repay
    /// agent. ChainPay re-checks and updates it; this program never writes it.
    #[account(
        mut,
        constraint = mandate.owner == binding.owner @ CardPolicyError::InvalidRepaymentMandate,
        constraint = mandate.approved_agent == repay_agent.key() @ CardPolicyError::InvalidRepaymentMandate,
    )]
    pub mandate: Box<Account<'info, PaymentMandate>>,
    /// CHECK: receipt PDA `["receipt", mandate, statement_digest]`, created by ChainPay.
    #[account(mut)]
    pub receipt: UncheckedAccount<'info>,
    /// CHECK: the mandate's mint; ChainPay checks it.
    pub allowed_mint: UncheckedAccount<'info>,
    /// CHECK: the mandate's source token account; ChainPay checks it.
    #[account(mut)]
    pub source_token_account: UncheckedAccount<'info>,
    /// CHECK: the partner's token account. ChainPay checks the mint; the
    /// authorizer's `record_repayment` checks it is the partner's.
    #[account(mut)]
    pub recipient_token_account: UncheckedAccount<'info>,
    /// CHECK: SPL Token or Token-2022; ChainPay checks it against the asset.
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    pub chainpay_program: Program<'info, Chainpay>,
}

pub fn repay_statement(
    ctx: Context<RepayStatement>,
    statement_digest: [u8; 32],
    amount: u64,
) -> Result<()> {
    require!(amount > 0, CardPolicyError::InvalidAmount);
    require_event_id(&statement_digest)?;
    let a = &ctx.accounts;
    let binding_key = a.binding.key();
    let (receipt, _) = Pubkey::find_program_address(
        &[
            CHAINPAY_RECEIPT_SEED,
            a.mandate.key().as_ref(),
            &statement_digest,
        ],
        &chainpay::ID,
    );
    require_keys_eq!(
        receipt,
        a.receipt.key(),
        CardPolicyError::InvalidRepaymentReceipt
    );

    // The repay agent is the receipt's rent payer. It must end the instruction
    // either empty or rent-exempt, so top it up to exactly that.
    let rent = Rent::get()?;
    let receipt_rent = rent.minimum_balance(CHAINPAY_RECEIPT_SPACE);
    let held = a.repay_agent.lamports();
    let top_up = if held == 0 {
        receipt_rent
    } else {
        receipt_rent
            .saturating_add(rent.minimum_balance(0))
            .saturating_sub(held)
    };
    if top_up > 0 {
        transfer(
            CpiContext::new(
                a.system_program.key(),
                Transfer {
                    from: a.owner.to_account_info(),
                    to: a.repay_agent.to_account_info(),
                },
            ),
            top_up,
        )?;
    }

    let (payment_id, signature_reference) = repayment_references(&binding_key, &statement_digest);
    let bump = [ctx.bumps.repay_agent];
    let seeds: [&[u8]; 3] = [REPAY_AGENT_SEED, binding_key.as_ref(), &bump];
    let signer = [&seeds[..]];
    chainpay::cpi::execute_payment(
        CpiContext::new_with_signer(
            a.chainpay_program.key(),
            chainpay::cpi::accounts::ExecutePayment {
                config: a.chainpay_config.to_account_info(),
                asset_registry: a.asset_registry.to_account_info(),
                mandate: a.mandate.to_account_info(),
                receipt: a.receipt.to_account_info(),
                agent: a.repay_agent.to_account_info(),
                allowed_mint: a.allowed_mint.to_account_info(),
                source_token_account: a.source_token_account.to_account_info(),
                recipient_token_account: a.recipient_token_account.to_account_info(),
                token_program: a.token_program.to_account_info(),
                system_program: a.system_program.to_account_info(),
            },
            &signer,
        ),
        PaymentParams {
            invoice_hash: statement_digest,
            payment_id,
            signature_reference,
            amount,
        },
    )?;
    Ok(())
}

// --------------------------------------------------------- record_repayment

#[derive(Accounts)]
pub struct RecordRepayment<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [CARD_POLICY_SEED, policy.binding.as_ref()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, CardPolicy>>,
    #[account(
        seeds = [CARD_PERIOD_SEED, policy.binding.as_ref()],
        bump = period.bump,
        constraint = period.policy == policy.key() @ CardPolicyError::InvalidAccount,
    )]
    pub period: Box<Account<'info, CardPeriod>>,
    /// CHECK: ChainPay receipt (base layer, read-only clone on the rollup);
    /// owner, seeds and fields are verified in the handler.
    pub receipt: UncheckedAccount<'info>,
    /// CHECK: the partner token account the authorizer expects the payment
    /// in; must be the receipt's recipient, a token account of the receipt's mint.
    pub recipient_token_account: UncheckedAccount<'info>,
    /// CHECK: the receipt's mint (for its decimals); verified in the handler.
    pub mint: UncheckedAccount<'info>,
}

/// What a verified receipt proves, in cents of the card's USD currency.
pub struct VerifiedReceipt {
    pub paid_cents: u64,
}

/// Every check `record_repayment` makes on the ChainPay receipt.
pub fn verify_repayment_receipt(
    binding: &Pubkey,
    statement_digest: &[u8; 32],
    receipt: &AccountInfo,
    recipient_token_account: &AccountInfo,
    mint: &AccountInfo,
) -> Result<VerifiedReceipt> {
    require_keys_eq!(
        *receipt.owner,
        chainpay::ID,
        CardPolicyError::InvalidRepaymentReceipt
    );
    let r = {
        let data = receipt.try_borrow_data()?;
        PaymentReceipt::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CardPolicyError::InvalidRepaymentReceipt))?
    };
    let expected = Pubkey::create_program_address(
        &[
            CHAINPAY_RECEIPT_SEED,
            r.mandate.as_ref(),
            statement_digest,
            &[r.bump],
        ],
        &chainpay::ID,
    )
    .map_err(|_| error!(CardPolicyError::InvalidRepaymentReceipt))?;
    require!(
        expected == *receipt.key
            && r.invoice_hash == *statement_digest
            && r.status == CHAINPAY_RECEIPT_SETTLED
            && r.agent == repay_agent_address(binding).0,
        CardPolicyError::InvalidRepaymentReceipt
    );

    require!(
        r.recipient_token_account == *recipient_token_account.key,
        CardPolicyError::RepaymentRecipientMismatch
    );
    let token_program = *recipient_token_account.owner;
    require!(
        token_program == SPL_TOKEN || token_program == TOKEN_2022,
        CardPolicyError::RepaymentRecipientMismatch
    );
    {
        let data = recipient_token_account.try_borrow_data()?;
        require!(
            data.len() >= 165 && data[..32] == r.mint.to_bytes(),
            CardPolicyError::RepaymentRecipientMismatch
        );
    }

    require!(
        *mint.key == r.mint && *mint.owner == token_program,
        CardPolicyError::InvalidRepaymentReceipt
    );
    let decimals = {
        let data = mint.try_borrow_data()?;
        require!(data.len() >= 82, CardPolicyError::InvalidRepaymentReceipt);
        data[44]
    };
    // USD stablecoin base units per cent: 10^(decimals - 2). A payment that
    // isn't a whole number of cents rounds down (never credits more).
    require!(decimals >= 2, CardPolicyError::InvalidRepaymentReceipt);
    let per_cent = 10u64
        .checked_pow((decimals - 2) as u32)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    Ok(VerifiedReceipt {
        paid_cents: r.amount / per_cent,
    })
}

/// Authorizer only, after the statement is `partner_confirmed` off-chain
/// (contracts.md §4.2). Lowers the outstanding balance by `amount_cents` only
/// when `receipt` is the ChainPay receipt of this card's `repay_statement` for
/// this digest, it paid the partner's account, and it covers the amount. The
/// digest can be used once.
pub fn record_repayment(
    ctx: Context<RecordRepayment>,
    statement_digest: [u8; 32],
    amount_cents: u64,
) -> Result<()> {
    let a = ctx.accounts;
    require_authorizer(&a.policy, &a.signer.key())?;
    let verified = verify_repayment_receipt(
        &a.policy.binding,
        &statement_digest,
        &a.receipt.to_account_info(),
        &a.recipient_token_account.to_account_info(),
        &a.mint.to_account_info(),
    )?;
    require!(
        amount_cents <= verified.paid_cents,
        CardPolicyError::RepaymentExceedsReceipt
    );
    apply_repayment(
        &mut a.policy,
        a.period.period_index,
        statement_digest,
        amount_cents,
        REPAYMENT_CHAINPAY_RECEIPT,
    )
}

/// Authorizer only. The opt-in MagicBlock private payment path (contracts.md
/// §7.3): its settlement leaves no ChainPay receipt, so this stays an
/// authorizer attestation, recorded with `REPAYMENT_PRIVATE_ATTESTED` in the
/// ledger event so it can never pass for a receipt-proven repayment.
pub fn record_private_repayment(
    ctx: Context<FreezeCard>,
    statement_digest: [u8; 32],
    amount_cents: u64,
) -> Result<()> {
    let a = ctx.accounts;
    require_authorizer(&a.policy, &a.signer.key())?;
    apply_repayment(
        &mut a.policy,
        a.period.period_index,
        statement_digest,
        amount_cents,
        REPAYMENT_PRIVATE_ATTESTED,
    )
}

fn apply_repayment(
    policy: &mut CardPolicy,
    period_index: u32,
    statement_digest: [u8; 32],
    amount_cents: u64,
    method: u8,
) -> Result<()> {
    let now = now()?;
    require!(amount_cents > 0, CardPolicyError::InvalidAmount);
    require_event_id(&statement_digest)?;
    require!(
        !policy.repayment_digests.contains(&statement_digest),
        CardPolicyError::DuplicateRepayment
    );
    require!(
        amount_cents <= policy.statement_outstanding_cents,
        CardPolicyError::RepaymentExceedsOutstanding
    );
    policy.statement_outstanding_cents = sub(policy.statement_outstanding_cents, amount_cents)?;
    let slot = (policy.repayment_count as usize) % REPAYMENT_RING;
    policy.repayment_digests[slot] = statement_digest;
    policy.repayment_count = policy.repayment_count.wrapping_add(1);

    let mut event = LedgerEvent::new(EV_REPAYMENT);
    event.event_id_hash = statement_digest;
    event.amount_cents = amount_cents;
    event.state_after = method;
    append_ledger(policy, event, period_index, now)
}
