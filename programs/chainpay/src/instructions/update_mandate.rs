use crate::{errors::ChainPayError, state::PaymentMandate};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{TokenAccount, TokenInterface};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MandateUpdate {
    pub approved_agent: Pubkey,
    pub allowed_recipient: Pubkey,
    pub max_per_payment: u64,
    pub total_limit: u64,
    pub expires_at_slot: u64,
    pub max_payment_count: u64,
    pub cooldown_slots: u64,
    pub paused: bool,
}

#[derive(Accounts)]
#[instruction(params: MandateUpdate)]
pub struct UpdateMandate<'info> {
    #[account(
        mut,
        seeds = [b"mandate", mandate.owner.as_ref()],
        bump = mandate.bump,
        has_one = owner,
    )]
    pub mandate: Account<'info, PaymentMandate>,
    pub owner: Signer<'info>,
    #[account(
        address = params.allowed_recipient @ ChainPayError::InvalidRecipient,
        constraint = recipient_token_account.mint == mandate.allowed_mint @ ChainPayError::InvalidRecipientMint,
        constraint = *recipient_token_account.to_account_info().owner == token_program.key() @ ChainPayError::InvalidTokenProgram,
    )]
    pub recipient_token_account: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}
