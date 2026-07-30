use crate::{errors::ChainPayError, state::ProtocolConfig};
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + ProtocolConfig::LEN,
        seeds = [b"config"],
        bump,
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump,
        has_one = authority @ ChainPayError::InvalidConfigAuthority,
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
}
