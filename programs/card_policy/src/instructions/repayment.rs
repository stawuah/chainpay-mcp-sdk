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
    // either empty or rent-exempt. Which receipt ChainPay creates depends on
    // the deployed ChainPay (v1: 282 bytes, v2: 371), so fund the larger one
    // and hand back whatever the CPI did not spend (below).
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
    let funded = held.saturating_add(top_up);
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

    // Return the part of this instruction's top-up the receipt did not use, so
    // the agent ends as it started (empty, or at its prior rent-exempt
    // balance) and the owner pays exactly the rent of the receipt created.
    let spent = funded.saturating_sub(a.repay_agent.lamports());
    let refund = top_up.saturating_sub(spent);
    if refund > 0 {
        transfer(
            CpiContext::new_with_signer(
                a.system_program.key(),
                Transfer {
                    from: a.repay_agent.to_account_info(),
                    to: a.owner.to_account_info(),
                },
                &signer,
            ),
            refund,
        )?;
    }
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

/// The ChainPay receipt fields `record_repayment` checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainpayReceiptFields {
    pub mandate: Pubkey,
    pub invoice_hash: [u8; 32],
    pub mint: Pubkey,
    pub recipient_token_account: Pubkey,
    pub amount: u64,
    pub agent: Pubkey,
    pub status: u8,
    pub bump: u8,
}

/// Decode a ChainPay `PaymentReceipt` in either layout ChainPay has written:
/// v1 (282 bytes, deployed on Devnet) or v2 (371 bytes: v1 plus the policy
/// snapshot after `bump`). Only those two exact sizes with the
/// `PaymentReceipt` discriminator are accepted. Every field read here has the
/// same offset in both layouts.
pub fn decode_chainpay_receipt(data: &[u8]) -> Result<ChainpayReceiptFields> {
    require!(
        (data.len() == CHAINPAY_RECEIPT_SPACE_V1 || data.len() == CHAINPAY_RECEIPT_SPACE)
            && data.starts_with(PaymentReceipt::DISCRIMINATOR),
        CardPolicyError::InvalidRepaymentReceipt
    );
    if data.len() == CHAINPAY_RECEIPT_SPACE {
        // The full v2 account must also decode as the current IDL's receipt.
        PaymentReceipt::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CardPolicyError::InvalidRepaymentReceipt))?;
    }
    let bytes32 = |at: usize| -> [u8; 32] { data[at..at + 32].try_into().unwrap() };
    // 8 discriminator | mandate 8 | invoice_hash 40 | payment_id 72 | mint 104
    // | source 136 | recipient 168 | amount 200 | agent 208 | executed_at_slot 240
    // | signature_reference 248 | status 280 | bump 281
    Ok(ChainpayReceiptFields {
        mandate: Pubkey::new_from_array(bytes32(8)),
        invoice_hash: bytes32(40),
        mint: Pubkey::new_from_array(bytes32(104)),
        recipient_token_account: Pubkey::new_from_array(bytes32(168)),
        amount: u64::from_le_bytes(data[200..208].try_into().unwrap()),
        agent: Pubkey::new_from_array(bytes32(208)),
        status: data[280],
        bump: data[281],
    })
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
        decode_chainpay_receipt(&data)?
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

#[cfg(test)]
mod tests {
    use super::*;

    fn v2_receipt() -> PaymentReceipt {
        PaymentReceipt {
            mandate: Pubkey::new_from_array([1; 32]),
            invoice_hash: [2; 32],
            payment_id: [3; 32],
            mint: Pubkey::new_from_array([4; 32]),
            source_token_account: Pubkey::new_from_array([5; 32]),
            recipient_token_account: Pubkey::new_from_array([6; 32]),
            amount: 5_020_000,
            agent: Pubkey::new_from_array([7; 32]),
            executed_at_slot: 508_105_839,
            signature_reference: [8; 32],
            status: CHAINPAY_RECEIPT_SETTLED,
            bump: 254,
            snapshot_version: 1,
            policy_max_per_payment: 9,
            policy_total_limit: 10,
            policy_amount_spent_after: 11,
            policy_payment_count_after: 12,
            policy_max_payment_count: 13,
            policy_expires_at_slot: 14,
            policy_cooldown_slots: 15,
            reserved: [0; 32],
        }
    }

    fn encode(receipt: &PaymentReceipt) -> Vec<u8> {
        let mut data = Vec::new();
        receipt.try_serialize(&mut data).unwrap();
        data
    }

    #[test]
    fn both_receipt_layouts_decode_to_the_same_fields() {
        let receipt = v2_receipt();
        let v2 = encode(&receipt);
        assert_eq!(v2.len(), CHAINPAY_RECEIPT_SPACE);
        // v1 is v2 without the snapshot appended after `bump`.
        let v1 = v2[..CHAINPAY_RECEIPT_SPACE_V1].to_vec();
        assert_eq!(v1.len(), 282);
        let expected = ChainpayReceiptFields {
            mandate: receipt.mandate,
            invoice_hash: receipt.invoice_hash,
            mint: receipt.mint,
            recipient_token_account: receipt.recipient_token_account,
            amount: receipt.amount,
            agent: receipt.agent,
            status: receipt.status,
            bump: receipt.bump,
        };
        assert_eq!(decode_chainpay_receipt(&v2).unwrap(), expected);
        assert_eq!(decode_chainpay_receipt(&v1).unwrap(), expected);
    }

    #[test]
    fn other_sizes_and_discriminators_are_refused() {
        let v2 = encode(&v2_receipt());
        for len in [0, 8, 281, 283, 300, 370, 372] {
            let mut data = v2.clone();
            data.resize(len, 0);
            assert!(decode_chainpay_receipt(&data).is_err(), "len {len}");
        }
        for len in [CHAINPAY_RECEIPT_SPACE_V1, CHAINPAY_RECEIPT_SPACE] {
            let mut data = v2[..len].to_vec();
            data[0] ^= 1;
            assert!(decode_chainpay_receipt(&data).is_err(), "len {len}");
        }
    }
}
