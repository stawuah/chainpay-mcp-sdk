use crate::{
    errors::ChainPayError,
    state::{PaymentMandate, PaymentReceipt, ProtocolConfig, SupportedAsset},
};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PaymentParams {
    pub invoice_hash: [u8; 32],
    pub payment_id: [u8; 32],
    pub signature_reference: [u8; 32],
    pub amount: u64,
}

#[derive(Accounts)]
#[instruction(params: PaymentParams)]
pub struct ExecutePayment<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [b"asset", mandate.allowed_mint.as_ref()],
        bump = asset_registry.bump,
        constraint = asset_registry.enabled @ ChainPayError::AssetNotEnabled,
        constraint = asset_registry.mint == mandate.allowed_mint @ ChainPayError::InvalidMint,
        constraint = asset_registry.token_program == token_program.key()
            @ ChainPayError::InvalidTokenProgram,
    )]
    pub asset_registry: Box<Account<'info, SupportedAsset>>,
    #[account(
        mut,
        seeds = [b"mandate", mandate.owner.as_ref()],
        bump = mandate.bump,
    )]
    pub mandate: Box<Account<'info, PaymentMandate>>,
    #[account(
        init,
        payer = agent,
        space = 8 + PaymentReceipt::LEN,
        seeds = [b"receipt", mandate.key().as_ref(), params.invoice_hash.as_ref()],
        bump
    )]
    pub receipt: Box<Account<'info, PaymentReceipt>>,
    #[account(mut, address = mandate.approved_agent)]
    pub agent: Signer<'info>,
    #[account(
        address = mandate.allowed_mint @ ChainPayError::InvalidMint,
        constraint = *allowed_mint.to_account_info().owner == token_program.key() @ ChainPayError::InvalidTokenProgram,
    )]
    pub allowed_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        address = mandate.source_token_account,
        constraint = source_token_account.owner == mandate.owner @ ChainPayError::InvalidSourceTokenAccount,
        constraint = source_token_account.mint == mandate.allowed_mint @ ChainPayError::InvalidSourceMint,
        constraint = source_token_account.delegate == COption::Some(mandate.key()) @ ChainPayError::InvalidSourceTokenAccount,
        constraint = source_token_account.delegated_amount >= params.amount @ ChainPayError::InvalidSourceTokenAccount,
        constraint = *source_token_account.to_account_info().owner == token_program.key() @ ChainPayError::InvalidTokenProgram,
    )]
    pub source_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = mandate.legacy_allowed_recipient == Pubkey::default()
            || recipient_token_account.key() == mandate.legacy_allowed_recipient
            @ ChainPayError::InvalidRecipient,
        constraint = recipient_token_account.mint == mandate.allowed_mint @ ChainPayError::InvalidRecipientMint,
        constraint = *recipient_token_account.to_account_info().owner == token_program.key() @ ChainPayError::InvalidTokenProgram,
    )]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
