use crate::{
    errors::ChainPayError,
    state::{ProtocolConfig, SupportedAsset},
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

#[derive(Accounts)]
#[instruction(mint: Pubkey)]
pub struct RegisterAsset<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ ChainPayError::InvalidConfigAuthority,
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        init,
        payer = authority,
        space = 8 + SupportedAsset::LEN,
        seeds = [b"asset", mint.as_ref()],
        bump,
    )]
    pub asset: Account<'info, SupportedAsset>,
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(address = mint @ ChainPayError::InvalidMint)]
    pub mint_account: InterfaceAccount<'info, Mint>,
    #[account(
        constraint = *mint_account.to_account_info().owner == token_program.key()
            @ ChainPayError::InvalidTokenProgram,
    )]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetAssetStatus<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ ChainPayError::InvalidConfigAuthority,
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        mut,
        seeds = [b"asset", asset.mint.as_ref()],
        bump = asset.bump,
        has_one = authority @ ChainPayError::InvalidAssetAuthority,
    )]
    pub asset: Account<'info, SupportedAsset>,
    pub authority: Signer<'info>,
}
