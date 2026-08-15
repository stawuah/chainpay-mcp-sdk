use crate::state::PaymentMandate;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct RevokeMandate<'info> {
    #[account(
        mut,
        has_one = owner,
    )]
    pub mandate: Account<'info, PaymentMandate>,
    pub owner: Signer<'info>,
}
