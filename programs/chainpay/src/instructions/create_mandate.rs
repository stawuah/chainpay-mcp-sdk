use crate::{
    errors::ChainPayError,
    state::{PaymentMandate, ProtocolConfig, SupportedAsset},
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MandateParams {
    pub approved_agent: Pubkey,
    pub source_token_account: Pubkey,
    pub allowed_mint: Pubkey,
    pub max_per_payment: u64,
    pub total_limit: u64,
    pub expires_at_slot: u64,
    pub max_payment_count: u64,
    pub cooldown_slots: u64,
    /// Unique per policy. It is also stored in the reserved compatibility
    /// field so execute_payment can reproduce the PDA signer seeds without
    /// changing the account size of existing mandates.
    pub mandate_nonce: Pubkey,
}

#[derive(Accounts)]
#[instruction(params: MandateParams)]
pub struct CreateMandate<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [b"asset", params.allowed_mint.as_ref()],
        bump = asset_registry.bump,
        constraint = asset_registry.enabled @ ChainPayError::AssetNotEnabled,
        constraint = asset_registry.mint == params.allowed_mint @ ChainPayError::InvalidMint,
        constraint = asset_registry.token_program == token_program.key()
            @ ChainPayError::InvalidTokenProgram,
    )]
    pub asset_registry: Box<Account<'info, SupportedAsset>>,
    #[account(
        init,
        payer = owner,
        space = 8 + PaymentMandate::LEN,
        // New mandates are scoped to the wallet, asset, and a unique nonce.
        // This allows multiple independent policies for the same token while
        // preserving the legacy and mint-scoped accounts already on Devnet.
        seeds = [
            b"mandate",
            owner.key().as_ref(),
            params.allowed_mint.as_ref(),
            params.mandate_nonce.as_ref(),
        ],
        bump
    )]
    pub mandate: Box<Account<'info, PaymentMandate>>,
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
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
