use crate::{
    errors::ChainPayError,
    state::{PaymentMandate, ProtocolConfig},
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MandateParams {
    pub approved_agent: Pubkey,
    pub source_token_account: Pubkey,
    pub allowed_mint: Pubkey,
    pub allowed_recipient: Pubkey,
    pub max_per_payment: u64,
    pub total_limit: u64,
    pub expires_at_slot: u64,
}

#[derive(Accounts)]
#[instruction(params: MandateParams)]
pub struct CreateMandate<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        constraint = config.supported_mints.contains(&params.allowed_mint) @ ChainPayError::UnsupportedMint,
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        init,
        payer = owner,
        space = 8 + PaymentMandate::LEN,
        seeds = [b"mandate", owner.key().as_ref()],
        bump
    )]
    pub mandate: Account<'info, PaymentMandate>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        address = params.allowed_mint @ ChainPayError::InvalidMint,
        constraint = *allowed_mint.to_account_info().owner == token_program.key() @ ChainPayError::InvalidTokenProgram,
    )]
    pub allowed_mint: InterfaceAccount<'info, Mint>,
    #[account(
        constraint = source_token_account.key() == params.source_token_account @ ChainPayError::InvalidSourceTokenAccount,
        constraint = source_token_account.owner == owner.key() @ ChainPayError::InvalidSourceTokenAccount,
        constraint = source_token_account.mint == params.allowed_mint @ ChainPayError::InvalidSourceMint,
        constraint = *source_token_account.to_account_info().owner == token_program.key() @ ChainPayError::InvalidTokenProgram,
    )]
    pub source_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(
        constraint = recipient_token_account.key() == params.allowed_recipient @ ChainPayError::InvalidRecipient,
        constraint = recipient_token_account.mint == params.allowed_mint @ ChainPayError::InvalidRecipientMint,
        constraint = *recipient_token_account.to_account_info().owner == token_program.key() @ ChainPayError::InvalidTokenProgram,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
