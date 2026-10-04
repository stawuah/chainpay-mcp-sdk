use crate::{
    constants::*,
    er::{self, PermissionAccounts, MAGIC_PROGRAM_ADDR},
    errors::CardPolicyError,
    instructions::common::*,
    policy::{validate_open_intent, IntentArgs},
    state::{CardPeriod, CardPolicy, CheckoutIntent},
};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::{
    access_control::structs::PERMISSION_SEED,
    consts::{EPHEMERAL_VAULT_ID, PERMISSION_PROGRAM_ID},
};

#[derive(Accounts)]
#[instruction(args: IntentArgs)]
pub struct OpenCheckoutIntent<'info> {
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
    /// CHECK: ephemeral CheckoutIntent PDA, created in the handler.
    #[account(mut, seeds = [INTENT_SEED, policy.key().as_ref(), args.intent_id.as_ref()], bump)]
    pub intent: UncheckedAccount<'info>,
    /// CHECK: intent permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, intent.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub intent_permission: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: magic program.
    #[account(address = MAGIC_PROGRAM_ADDR)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

pub fn open_checkout_intent(ctx: Context<OpenCheckoutIntent>, args: IntentArgs) -> Result<()> {
    let accounts = &ctx.accounts;
    let policy = &accounts.policy;
    require_authorizer(policy, &accounts.authorizer.key())?;
    let now = now()?;
    validate_open_intent(policy, &accounts.period, &args, now)?;
    require!(
        accounts.intent.data_is_empty(),
        CardPolicyError::IntentInvalid
    );

    let policy_key = policy.key();
    let binding = policy.binding;
    let policy_bump = [policy.bump];
    let policy_seeds: [&[u8]; 3] = [CARD_POLICY_SEED, binding.as_ref(), &policy_bump];
    let intent_bump = [ctx.bumps.intent];
    let intent_seeds: [&[u8]; 4] = [
        INTENT_SEED,
        policy_key.as_ref(),
        &args.intent_id,
        &intent_bump,
    ];
    let policy_info = policy.to_account_info();
    let intent_info = accounts.intent.to_account_info();
    let vault = accounts.vault.to_account_info();

    er::create_ephemeral(
        &policy_info,
        &intent_info,
        &vault,
        &policy_seeds,
        &intent_seeds,
        INTENT_LEN as u32,
    )?;
    let intent = CheckoutIntent {
        policy: policy_key,
        intent_id: args.intent_id,
        agent: args.agent,
        merchant_id_hash: args.merchant_id_hash,
        mcc: args.mcc,
        max_amount_cents: args.max_amount_cents,
        currency: args.currency,
        policy_version: policy.policy_version,
        expires_at: args.expires_at,
        state: INTENT_OPEN,
        reservation: Pubkey::default(),
        bump: ctx.bumps.intent,
    };
    {
        let mut data = intent_info.try_borrow_mut_data()?;
        intent.try_serialize(&mut &mut data[..])?;
    }

    let count = policy.member_count as usize;
    er::create_permission(
        PermissionAccounts {
            payer: &policy_info,
            permissioned: &intent_info,
            permission: &accounts.intent_permission.to_account_info(),
            vault: &vault,
            magic_program: &accounts.magic_program.to_account_info(),
            permission_program: &accounts.permission_program.to_account_info(),
        },
        er::private_members(&policy.members[..count], &policy.member_flags[..count])?,
        &[&policy_seeds, &intent_seeds],
    )?;
    ephemeral_created(&mut ctx.accounts.policy)
}

#[derive(Accounts)]
pub struct CancelCheckoutIntent<'info> {
    pub signer: Signer<'info>,
    #[account(
        seeds = [CARD_POLICY_SEED, policy.binding.as_ref()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, CardPolicy>>,
    #[account(
        mut,
        seeds = [INTENT_SEED, policy.key().as_ref(), intent.intent_id.as_ref()],
        bump = intent.bump,
        constraint = intent.policy == policy.key() @ CardPolicyError::InvalidAccount,
    )]
    pub intent: Box<Account<'info, CheckoutIntent>>,
}

pub fn cancel_checkout_intent(ctx: Context<CancelCheckoutIntent>) -> Result<()> {
    require_owner_or_authorizer(&ctx.accounts.policy, &ctx.accounts.signer.key())?;
    let intent = &mut ctx.accounts.intent;
    require!(intent.state == INTENT_OPEN, CardPolicyError::IntentInvalid);
    intent.state = INTENT_CANCELLED;
    Ok(())
}

#[derive(Accounts)]
pub struct CloseCheckoutIntent<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [CARD_POLICY_SEED, policy.binding.as_ref()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, CardPolicy>>,
    /// CHECK: CheckoutIntent of this card; verified in the handler.
    #[account(mut, owner = crate::ID @ CardPolicyError::InvalidAccount)]
    pub intent: UncheckedAccount<'info>,
    /// CHECK: intent permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, intent.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub intent_permission: UncheckedAccount<'info>,
    /// CHECK: ephemeral rent vault.
    #[account(mut, address = EPHEMERAL_VAULT_ID)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: magic program.
    #[account(address = MAGIC_PROGRAM_ADDR)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: permission program.
    #[account(address = PERMISSION_PROGRAM_ID)]
    pub permission_program: UncheckedAccount<'info>,
}

/// Returns a used, cancelled or expired intent's ER rent to the card's prefund.
/// The Reservation keeps the consumed intent's key, so nothing is lost.
pub fn close_checkout_intent(ctx: Context<CloseCheckoutIntent>) -> Result<()> {
    let now = now()?;
    let accounts = &ctx.accounts;
    let policy = &accounts.policy;
    require_owner_or_authorizer(policy, &accounts.signer.key())?;
    let policy_key = policy.key();
    let intent_info = accounts.intent.to_account_info();
    let intent = {
        let data = intent_info.try_borrow_data()?;
        CheckoutIntent::try_deserialize(&mut &data[..])
            .map_err(|_| error!(CardPolicyError::InvalidAccount))?
    };
    require!(intent.policy == policy_key, CardPolicyError::InvalidAccount);
    require!(
        intent.state != INTENT_OPEN || now > intent.expires_at,
        CardPolicyError::IntentInvalid
    );
    let intent_bump = [intent.bump];
    let intent_seeds: [&[u8]; 4] = [
        INTENT_SEED,
        policy_key.as_ref(),
        &intent.intent_id,
        &intent_bump,
    ];
    let expected = Pubkey::create_program_address(&intent_seeds, &crate::ID)
        .map_err(|_| error!(CardPolicyError::InvalidAccount))?;
    require!(
        expected == intent_info.key(),
        CardPolicyError::InvalidAccount
    );

    let binding = policy.binding;
    let policy_bump = [policy.bump];
    let policy_seeds: [&[u8]; 3] = [CARD_POLICY_SEED, binding.as_ref(), &policy_bump];
    let policy_info = policy.to_account_info();
    let vault = accounts.vault.to_account_info();
    let permission = accounts.intent_permission.to_account_info();
    if er::permission_exists(&permission) {
        er::close_permission(
            PermissionAccounts {
                payer: &policy_info,
                permissioned: &intent_info,
                permission: &permission,
                vault: &vault,
                magic_program: &accounts.magic_program.to_account_info(),
                permission_program: &accounts.permission_program.to_account_info(),
            },
            &[&policy_seeds, &intent_seeds],
        )?;
    }
    er::close_ephemeral(&policy_info, &intent_info, &vault, &policy_seeds)?;
    ephemeral_closed(&mut ctx.accounts.policy);
    Ok(())
}
