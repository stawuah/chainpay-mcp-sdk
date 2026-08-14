use crate::state::PaymentMandate;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct MandateUpdate {
    pub approved_agent: Pubkey,
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
}
