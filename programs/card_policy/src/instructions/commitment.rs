use crate::{
    constants::*,
    er::{self, ActionAccounts, MAGIC_PROGRAM_ADDR},
    errors::CardPolicyError,
    hashes::commitment_root,
    instructions::common::*,
    state::{CardBinding, CardCommitment, CardPeriod, CardPolicy},
};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::consts::MAGIC_CONTEXT_ID;

#[derive(Accounts)]
pub struct Checkpoint<'info> {
    #[account(mut)]
    pub authorizer: Signer<'info>,
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
    /// CHECK: base-layer binding (never delegated); referenced by the action.
    #[account(address = policy.binding)]
    pub binding: UncheckedAccount<'info>,
    /// CHECK: base-layer CardCommitment PDA; written by the scheduled action only.
    #[account(seeds = [CARD_COMMITMENT_SEED, policy.binding.as_ref()], bump)]
    pub commitment: UncheckedAccount<'info>,
    /// CHECK: magic context.
    #[account(mut, address = MAGIC_CONTEXT_ID)]
    pub magic_context: UncheckedAccount<'info>,
    /// CHECK: magic program.
    #[account(address = MAGIC_PROGRAM_ADDR)]
    pub magic_program: UncheckedAccount<'info>,
}

/// Runs on PER. Computes the salted root from private state and schedules a
/// standalone base-layer action that writes only the root. No private account
/// is committed (CD-2, CD-3). `master_salt` is a private instruction argument.
pub fn checkpoint(ctx: Context<Checkpoint>, master_salt: [u8; 32], seq: u64) -> Result<()> {
    let a = &ctx.accounts;
    require_authorizer(&a.policy, &a.authorizer.key())?;
    let expected_seq = a
        .policy
        .commit_seq
        .checked_add(1)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    require!(seq == expected_seq, CardPolicyError::StaleCommitment);
    require!(master_salt != [0u8; 32], CardPolicyError::InvalidEventId);

    let root = commitment_root(&a.policy, &a.period, &master_salt);
    let data = anchor_lang::InstructionData::data(&crate::instruction::WriteCommitment {
        root,
        seq,
        policy_version: a.policy.policy_version,
        period_index: a.period.period_index,
    });
    let binding = a.policy.binding;
    let policy_bump = [a.policy.bump];
    let policy_seeds: [&[u8]; 3] = [CARD_POLICY_SEED, binding.as_ref(), &policy_bump];
    er::schedule_standalone_action(
        ActionAccounts {
            payer: &a.authorizer.to_account_info(),
            magic_context: &a.magic_context.to_account_info(),
            magic_program: &a.magic_program.to_account_info(),
            // The card's own escrow: ["balance", policy_pda, 255] on the
            // delegation program, topped up by the owner on base.
            escrow_authority: &a.policy.to_account_info(),
        },
        &[(a.commitment.key(), true), (a.binding.key(), false)],
        data,
        &[&policy_seeds],
    )?;
    ctx.accounts.policy.commit_seq = seq;
    Ok(())
}

/// Base-layer Magic Action handler. Only reachable through the delegation
/// program, which signs for the card's escrow PDA. The account order after
/// `binding` is what the delegation program appends:
/// `source_program`, `escrow_auth`, `escrow` (spikes/EVIDENCE.md §3).
#[derive(Accounts)]
pub struct WriteCommitment<'info> {
    #[account(
        mut,
        seeds = [CARD_COMMITMENT_SEED, binding.key().as_ref()],
        bump = commitment.bump,
        constraint = commitment.binding == binding.key() @ CardPolicyError::InvalidAccount,
    )]
    pub commitment: Box<Account<'info, CardCommitment>>,
    #[account(
        seeds = [CARD_BINDING_SEED, binding.owner.as_ref(), binding.card_id.as_ref()],
        bump = binding.bump,
    )]
    pub binding: Box<Account<'info, CardBinding>>,
    /// CHECK: program that scheduled the action (inserted by the delegation program).
    #[account(address = crate::ID @ CardPolicyError::Unauthorized)]
    pub source_program: UncheckedAccount<'info>,
    /// CHECK: must be this card's policy PDA, the escrow authority.
    #[account(address = binding.policy @ CardPolicyError::Unauthorized)]
    pub escrow_auth: UncheckedAccount<'info>,
    /// CHECK: only the delegation program can sign for this PDA.
    #[account(
        signer @ CardPolicyError::Unauthorized,
        address = ephemeral_rollups_sdk::pda::ephemeral_balance_pda_from_payer(
            &escrow_auth.key(), ACTION_ESCROW_INDEX) @ CardPolicyError::Unauthorized
    )]
    pub escrow: UncheckedAccount<'info>,
}

pub fn write_commitment(
    ctx: Context<WriteCommitment>,
    root: [u8; 32],
    seq: u64,
    policy_version: u32,
    period_index: u32,
) -> Result<()> {
    let commitment = &mut ctx.accounts.commitment;
    require!(seq > commitment.seq, CardPolicyError::StaleCommitment);
    commitment.seq = seq;
    commitment.root = root;
    commitment.policy_version = policy_version;
    commitment.period_index = period_index;
    commitment.written_slot = Clock::get()?.slot;
    Ok(())
}
