use crate::{
    constants::*,
    er::{
        self, PermissionAccounts, AUTHORIZER_FLAGS, MAGIC_PROGRAM_ADDR, OWNER_FLAGS, READER_FLAGS,
    },
    errors::CardPolicyError,
    hashes::{append_ledger, LedgerEvent},
    instructions::common::*,
    state::{CardPeriod, CardPolicy, CheckoutIntent, Reservation},
};
use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use ephemeral_rollups_sdk::{
    access_control::structs::PERMISSION_SEED,
    consts::{EPHEMERAL_VAULT_ID, PERMISSION_PROGRAM_ID},
};

/// Shared by every instruction that edits the policy and period permissions.
#[derive(Accounts)]
pub struct CardPermissions<'info> {
    pub owner: Signer<'info>,
    #[account(
        mut,
        has_one = owner @ CardPolicyError::Unauthorized,
        seeds = [CARD_POLICY_SEED, policy.binding.as_ref()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, CardPolicy>>,
    #[account(
        mut,
        seeds = [CARD_PERIOD_SEED, policy.binding.as_ref()],
        bump = period.bump,
        constraint = period.policy == policy.key() @ CardPolicyError::InvalidAccount,
    )]
    pub period: Box<Account<'info, CardPeriod>>,
    /// CHECK: policy permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, policy.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub policy_permission: UncheckedAccount<'info>,
    /// CHECK: period permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, period.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub period_permission: UncheckedAccount<'info>,
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum PermissionWrite {
    Create,
    Update,
}

impl<'info> CardPermissions<'info> {
    /// Applies the canonical member list to the policy and period permissions.
    fn write_card_permissions(&self, mode: PermissionWrite) -> Result<()> {
        let binding = self.policy.binding;
        let policy_bump = [self.policy.bump];
        let policy_seeds: [&[u8]; 3] = [CARD_POLICY_SEED, binding.as_ref(), &policy_bump];
        let period_bump = [self.period.bump];
        let period_seeds: [&[u8]; 3] = [CARD_PERIOD_SEED, binding.as_ref(), &period_bump];
        let policy_info = self.policy.to_account_info();
        let period_info = self.period.to_account_info();
        let vault = self.vault.to_account_info();
        let magic_program = self.magic_program.to_account_info();
        let permission_program = self.permission_program.to_account_info();
        let count = self.policy.member_count as usize;

        for (permissioned, permission, seeds) in [
            (
                &policy_info,
                self.policy_permission.to_account_info(),
                &policy_seeds,
            ),
            (
                &period_info,
                self.period_permission.to_account_info(),
                &period_seeds,
            ),
        ] {
            let members = er::private_members(
                &self.policy.members[..count],
                &self.policy.member_flags[..count],
            )?;
            let accounts = PermissionAccounts {
                payer: &policy_info,
                permissioned,
                permission: &permission,
                vault: &vault,
                magic_program: &magic_program,
                permission_program: &permission_program,
            };
            let signers: &[&[&[u8]]] = if permissioned.key == policy_info.key {
                &[&policy_seeds]
            } else {
                &[&policy_seeds, seeds]
            };
            match mode {
                PermissionWrite::Create if !er::permission_exists(&permission) => {
                    er::create_permission(accounts, members, signers)?
                }
                PermissionWrite::Create => {}
                PermissionWrite::Update => er::update_permission(accounts, members, signers)?,
            }
        }
        Ok(())
    }
}

/// Re-applies the canonical members to both card permissions (used by set_policy
/// when the authorizer changes).
pub fn sync_card_permissions(accounts: &CardPermissions) -> Result<()> {
    accounts.write_card_permissions(PermissionWrite::Update)
}

pub fn init_permission(ctx: Context<CardPermissions>, authorizer: Pubkey) -> Result<()> {
    let owner = ctx.accounts.owner.key();
    require!(
        authorizer != Pubkey::default() && authorizer != owner,
        CardPolicyError::InvalidPolicy
    );
    let policy = &mut ctx.accounts.policy;
    let first_time = policy.member_count == 0;
    if first_time {
        policy.members[0] = owner;
        policy.member_flags[0] = OWNER_FLAGS;
        policy.members[1] = authorizer;
        policy.member_flags[1] = AUTHORIZER_FLAGS;
        policy.member_count = 2;
    } else {
        // Idempotent for the same authorizer; rotation goes through set_policy.
        require!(
            policy.members[1] == authorizer,
            CardPolicyError::InvalidPolicy
        );
    }
    ctx.accounts
        .write_card_permissions(PermissionWrite::Create)?;
    if first_time {
        let period_index = ctx.accounts.period.period_index;
        let mut event = LedgerEvent::new(EV_PERMISSION_CHANGE);
        event.event_id_hash = authorizer.to_bytes();
        event.state_after = 0;
        append_ledger(&mut ctx.accounts.policy, event, period_index, now()?)?;
    }
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum PermissionOp {
    AddReader { pubkey: Pubkey },
    RemoveReader { pubkey: Pubkey },
}

/// Remaining accounts (optional): pairs of `[ephemeral account, its permission]`
/// to re-sync in the same transaction, so a removed reader loses access to open
/// reservations and intents at once (otherwise use `sync_permission`).
pub fn update_permission<'info>(
    ctx: Context<'info, CardPermissions<'info>>,
    op: PermissionOp,
) -> Result<()> {
    let policy = &mut ctx.accounts.policy;
    require!(
        policy.member_count >= 2,
        CardPolicyError::PermissionNotInitialized
    );
    let count = policy.member_count as usize;
    let (pubkey, state_after) = match op {
        PermissionOp::AddReader { pubkey } => {
            require!(pubkey != Pubkey::default(), CardPolicyError::InvalidPolicy);
            require!(
                !policy.members[..count].contains(&pubkey),
                CardPolicyError::InvalidPolicy
            );
            require!(count < MAX_MEMBERS, CardPolicyError::MemberLimit);
            policy.members[count] = pubkey;
            policy.member_flags[count] = READER_FLAGS;
            policy.member_count += 1;
            (pubkey, 1u8)
        }
        PermissionOp::RemoveReader { pubkey } => {
            let index = policy.members[..count]
                .iter()
                .position(|member| *member == pubkey)
                .ok_or(error!(CardPolicyError::MemberNotFound))?;
            // Slot 0 is the owner and slot 1 the authorizer.
            require!(index >= 2, CardPolicyError::Unauthorized);
            for i in index..count - 1 {
                policy.members[i] = policy.members[i + 1];
                policy.member_flags[i] = policy.member_flags[i + 1];
            }
            policy.members[count - 1] = Pubkey::default();
            policy.member_flags[count - 1] = 0;
            policy.member_count -= 1;
            (pubkey, 2u8)
        }
    };
    ctx.accounts
        .write_card_permissions(PermissionWrite::Update)?;
    require!(
        ctx.remaining_accounts.len().is_multiple_of(2),
        CardPolicyError::InvalidAccount
    );
    for pair in ctx.remaining_accounts.chunks(2) {
        sync_one(&ctx.accounts, &pair[0], &pair[1])?;
    }
    let period_index = ctx.accounts.period.period_index;
    let mut event = LedgerEvent::new(EV_PERMISSION_CHANGE);
    event.event_id_hash = pubkey.to_bytes();
    event.state_after = state_after;
    append_ledger(&mut ctx.accounts.policy, event, period_index, now()?)
}

// ---------------------------------------------------------- sync_permission

#[derive(Accounts)]
pub struct SyncPermission<'info> {
    pub signer: Signer<'info>,
    #[account(
        mut,
        seeds = [CARD_POLICY_SEED, policy.binding.as_ref()],
        bump = policy.bump,
    )]
    pub policy: Box<Account<'info, CardPolicy>>,
    /// CHECK: a Reservation or CheckoutIntent of this card; verified in the handler.
    #[account(mut, owner = crate::ID @ CardPolicyError::InvalidAccount)]
    pub target: UncheckedAccount<'info>,
    /// CHECK: target permission PDA, verified by seeds.
    #[account(mut, seeds = [PERMISSION_SEED, target.key().as_ref()], bump, seeds::program = PERMISSION_PROGRAM_ID)]
    pub target_permission: UncheckedAccount<'info>,
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

pub fn sync_permission(ctx: Context<SyncPermission>) -> Result<()> {
    let accounts = &ctx.accounts;
    let policy = &accounts.policy;
    require_owner_or_authorizer(policy, &accounts.signer.key())?;
    require!(
        policy.member_count >= 2,
        CardPolicyError::PermissionNotInitialized
    );
    let policy_key = policy.key();
    let (prefix, id, bump) = ephemeral_identity(&accounts.target, &policy_key)?;
    let target_bump = [bump];
    let target_seeds: [&[u8]; 4] = [prefix, policy_key.as_ref(), &id, &target_bump];
    let binding = policy.binding;
    let policy_bump = [policy.bump];
    let policy_seeds: [&[u8]; 3] = [CARD_POLICY_SEED, binding.as_ref(), &policy_bump];
    let count = policy.member_count as usize;
    let members = er::private_members(&policy.members[..count], &policy.member_flags[..count])?;
    er::update_permission(
        PermissionAccounts {
            payer: &policy.to_account_info(),
            permissioned: &accounts.target.to_account_info(),
            permission: &accounts.target_permission.to_account_info(),
            vault: &accounts.vault.to_account_info(),
            magic_program: &accounts.magic_program.to_account_info(),
            permission_program: &accounts.permission_program.to_account_info(),
        },
        members,
        &[&policy_seeds, &target_seeds],
    )
}

fn sync_one<'info>(
    accounts: &CardPermissions<'info>,
    target: &AccountInfo<'info>,
    target_permission: &AccountInfo<'info>,
) -> Result<()> {
    require!(target.owner == &crate::ID, CardPolicyError::InvalidAccount);
    let policy = &accounts.policy;
    let policy_key = policy.key();
    let (prefix, id, bump) = ephemeral_identity(target, &policy_key)?;
    let (expected_permission, _) = Pubkey::find_program_address(
        &[PERMISSION_SEED, target.key.as_ref()],
        &PERMISSION_PROGRAM_ID,
    );
    require!(
        expected_permission == *target_permission.key,
        CardPolicyError::InvalidAccount
    );
    let target_bump = [bump];
    let target_seeds: [&[u8]; 4] = [prefix, policy_key.as_ref(), &id, &target_bump];
    let binding = policy.binding;
    let policy_bump = [policy.bump];
    let policy_seeds: [&[u8]; 3] = [CARD_POLICY_SEED, binding.as_ref(), &policy_bump];
    let count = policy.member_count as usize;
    er::update_permission(
        PermissionAccounts {
            payer: &policy.to_account_info(),
            permissioned: target,
            permission: target_permission,
            vault: &accounts.vault.to_account_info(),
            magic_program: &accounts.magic_program.to_account_info(),
            permission_program: &accounts.permission_program.to_account_info(),
        },
        er::private_members(&policy.members[..count], &policy.member_flags[..count])?,
        &[&policy_seeds, &target_seeds],
    )
}

/// Seeds identity of an ephemeral account that belongs to `policy`.
pub fn ephemeral_identity(
    target: &AccountInfo,
    policy: &Pubkey,
) -> Result<(&'static [u8], Vec<u8>, u8)> {
    let data = target.try_borrow_data()?;
    let (prefix, id, bump): (&'static [u8], Vec<u8>, u8) =
        if data.starts_with(Reservation::DISCRIMINATOR) {
            let r = Reservation::try_deserialize(&mut &data[..])?;
            require!(r.policy == *policy, CardPolicyError::InvalidAccount);
            (RESERVATION_SEED, r.auth_id_hash.to_vec(), r.bump)
        } else if data.starts_with(CheckoutIntent::DISCRIMINATOR) {
            let i = CheckoutIntent::try_deserialize(&mut &data[..])?;
            require!(i.policy == *policy, CardPolicyError::InvalidAccount);
            (INTENT_SEED, i.intent_id.to_vec(), i.bump)
        } else {
            return err!(CardPolicyError::InvalidAccount);
        };
    let expected =
        Pubkey::create_program_address(&[prefix, policy.as_ref(), &id, &[bump]], &crate::ID)
            .map_err(|_| error!(CardPolicyError::InvalidAccount))?;
    require!(expected == *target.key, CardPolicyError::InvalidAccount);
    Ok((prefix, id, bump))
}
