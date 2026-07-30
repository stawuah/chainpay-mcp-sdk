use crate::state::PaymentMandate;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct PauseMandate<'info> {
    #[account(
        mut,
        seeds = [b"mandate", mandate.owner.as_ref()],
        bump = mandate.bump,
        has_one = owner,
    )]
    pub mandate: Account<'info, PaymentMandate>,
    pub owner: Signer<'info>,
}
