//! Thin layer over the MagicBlock CPIs (ephemeral accounts, ephemeral
//! permissions, Magic Actions, commit/undelegate).
//!
//! With the `litesvm-mock` feature the same functions run local equivalents so
//! the policy logic can be exercised in LiteSVM, where the magic program and the
//! permission program do not exist. The deployable build never enables it.

use crate::errors::CardPolicyError;
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::structs::{
    EphemeralMembersArgs, Member, AUTHORITY_FLAG, TX_BALANCES_FLAG, TX_LOGS_FLAG, TX_MESSAGE_FLAG,
};

pub const OWNER_FLAGS: u8 = AUTHORITY_FLAG | TX_LOGS_FLAG | TX_MESSAGE_FLAG | TX_BALANCES_FLAG;
pub const AUTHORIZER_FLAGS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG;
pub const READER_FLAGS: u8 = TX_LOGS_FLAG | TX_MESSAGE_FLAG;

/// Address the contexts expect for the magic program. Under `litesvm-mock` the
/// local equivalents CPI into the system program, so the slot carries it.
#[cfg(not(feature = "litesvm-mock"))]
pub const MAGIC_PROGRAM_ADDR: Pubkey = ephemeral_rollups_sdk::consts::MAGIC_PROGRAM_ID;
#[cfg(feature = "litesvm-mock")]
pub const MAGIC_PROGRAM_ADDR: Pubkey = anchor_lang::system_program::ID;

/// Members are always private and never empty. `is_private = false` or an empty
/// member list would publish the account, so it is refused here, structurally.
pub fn private_members(members: &[Pubkey], flags: &[u8]) -> Result<EphemeralMembersArgs> {
    require!(
        !members.is_empty() && members.len() == flags.len(),
        CardPolicyError::DisclosureBlocked
    );
    Ok(EphemeralMembersArgs {
        is_private: true,
        members: members
            .iter()
            .zip(flags.iter())
            .map(|(pubkey, flags)| Member {
                flags: *flags,
                pubkey: *pubkey,
            })
            .collect(),
    })
}

pub struct PermissionAccounts<'a, 'info> {
    pub payer: &'a AccountInfo<'info>,
    pub permissioned: &'a AccountInfo<'info>,
    pub permission: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
    pub magic_program: &'a AccountInfo<'info>,
    pub permission_program: &'a AccountInfo<'info>,
}

pub fn permission_exists(permission: &AccountInfo) -> bool {
    permission.lamports() > 0
}

#[cfg(not(feature = "litesvm-mock"))]
mod imp {
    use super::*;
    use ephemeral_rollups_sdk::{
        access_control::instructions::{
            CloseEphemeralPermissionCpi, CreateEphemeralPermissionCpi, UpdateEphemeralPermissionCpi,
        },
        ephem::{CallHandler, FoldableIntentBuilder, MagicIntentBundleBuilder},
        ephemeral_accounts::EphemeralAccount,
        ActionArgs, ShortAccountMeta,
    };

    pub fn create_ephemeral<'info>(
        sponsor: &AccountInfo<'info>,
        eph: &AccountInfo<'info>,
        vault: &AccountInfo<'info>,
        sponsor_seeds: &[&[u8]],
        eph_seeds: &[&[u8]],
        data_len: u32,
    ) -> Result<()> {
        let seeds = [sponsor_seeds, eph_seeds];
        EphemeralAccount::new(sponsor, eph, vault)
            .with_signer_seeds(&seeds)
            .create(data_len)?;
        Ok(())
    }

    pub fn close_ephemeral<'info>(
        sponsor: &AccountInfo<'info>,
        eph: &AccountInfo<'info>,
        vault: &AccountInfo<'info>,
        sponsor_seeds: &[&[u8]],
    ) -> Result<()> {
        let seeds = [sponsor_seeds];
        EphemeralAccount::new(sponsor, eph, vault)
            .with_signer_seeds(&seeds)
            .close()?;
        Ok(())
    }

    pub fn create_permission(
        accounts: PermissionAccounts,
        members: EphemeralMembersArgs,
        signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        CreateEphemeralPermissionCpi {
            payer: accounts.payer.clone(),
            permissioned_account: accounts.permissioned.clone(),
            permission: accounts.permission.clone(),
            vault: accounts.vault.clone(),
            magic_program: accounts.magic_program.clone(),
            permission_program: accounts.permission_program.clone(),
            args: members,
        }
        .invoke_signed(signer_seeds)?;
        Ok(())
    }

    pub fn update_permission(
        accounts: PermissionAccounts,
        members: EphemeralMembersArgs,
        signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        UpdateEphemeralPermissionCpi {
            payer: accounts.payer.clone(),
            permissioned_account: accounts.permissioned.clone(),
            permission: accounts.permission.clone(),
            vault: accounts.vault.clone(),
            magic_program: accounts.magic_program.clone(),
            permission_program: accounts.permission_program.clone(),
            // The permissioned PDA is the permission authority and signs by seeds.
            authority: accounts.permissioned.clone(),
            authority_is_signer: false,
            args: members,
        }
        .invoke_signed(signer_seeds)?;
        Ok(())
    }

    pub fn close_permission(accounts: PermissionAccounts, signer_seeds: &[&[&[u8]]]) -> Result<()> {
        CloseEphemeralPermissionCpi {
            payer: accounts.payer.clone(),
            permissioned_account: accounts.permissioned.clone(),
            permission: accounts.permission.clone(),
            vault: accounts.vault.clone(),
            magic_program: accounts.magic_program.clone(),
            permission_program: accounts.permission_program.clone(),
            authority: accounts.permissioned.clone(),
            authority_is_signer: false,
        }
        .invoke_signed(signer_seeds)?;
        Ok(())
    }

    pub struct ActionAccounts<'a, 'info> {
        pub payer: &'a AccountInfo<'info>,
        pub magic_context: &'a AccountInfo<'info>,
        pub magic_program: &'a AccountInfo<'info>,
        pub escrow_authority: &'a AccountInfo<'info>,
    }

    /// Schedules a standalone base-layer action. No private account is
    /// committed: only `action_accounts` reach the base transaction.
    pub fn schedule_standalone_action(
        accounts: ActionAccounts,
        action_accounts: &[(Pubkey, bool)],
        data: Vec<u8>,
        escrow_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        // The builder copies `is_signer` from the AccountInfo into the CPI meta.
        // A PDA escrow authority signs through `escrow_seeds`, so mark it here.
        let mut escrow_authority = accounts.escrow_authority.clone();
        if !escrow_seeds.is_empty() {
            escrow_authority.is_signer = true;
        }
        let action = CallHandler {
            destination_program: crate::ID,
            accounts: action_accounts
                .iter()
                .map(|(pubkey, is_writable)| ShortAccountMeta {
                    pubkey: pubkey.to_bytes().into(),
                    is_writable: *is_writable,
                })
                .collect(),
            args: ActionArgs::new(data),
            escrow_authority,
            compute_units: 60_000,
        };
        MagicIntentBundleBuilder::new(
            accounts.payer.clone(),
            accounts.magic_context.clone(),
            accounts.magic_program.clone(),
        )
        .add_standalone_actions([action])
        .build_and_invoke_signed(escrow_seeds)?;
        Ok(())
    }

    pub fn commit_and_undelegate<'info>(
        payer: &AccountInfo<'info>,
        magic_context: &AccountInfo<'info>,
        magic_program: &AccountInfo<'info>,
        accounts: &[AccountInfo<'info>],
    ) -> Result<()> {
        MagicIntentBundleBuilder::new(payer.clone(), magic_context.clone(), magic_program.clone())
            .commit_and_undelegate(accounts)
            .build_and_invoke()?;
        Ok(())
    }
}

#[cfg(feature = "litesvm-mock")]
mod imp {
    use super::*;
    use anchor_lang::system_program::{allocate, assign, Allocate, Assign};

    pub fn create_ephemeral<'info>(
        sponsor: &AccountInfo<'info>,
        eph: &AccountInfo<'info>,
        _vault: &AccountInfo<'info>,
        _sponsor_seeds: &[&[u8]],
        eph_seeds: &[&[u8]],
        data_len: u32,
    ) -> Result<()> {
        require!(eph.data_is_empty(), CardPolicyError::InvalidAccount);
        let seeds = [eph_seeds];
        allocate(
            CpiContext::new_with_signer(
                anchor_lang::system_program::ID,
                Allocate {
                    account_to_allocate: eph.clone(),
                },
                &seeds,
            ),
            data_len as u64,
        )?;
        assign(
            CpiContext::new_with_signer(
                anchor_lang::system_program::ID,
                Assign {
                    account_to_assign: eph.clone(),
                },
                &seeds,
            ),
            &crate::ID,
        )?;
        // Fund after the CPIs: the runtime checks lamport balance per CPI.
        let rent = Rent::get()?.minimum_balance(data_len as usize);
        let needed = rent.saturating_sub(eph.lamports());
        **sponsor.try_borrow_mut_lamports()? = sponsor
            .lamports()
            .checked_sub(needed)
            .ok_or(error!(CardPolicyError::PrefundTooLow))?;
        **eph.try_borrow_mut_lamports()? += needed;
        Ok(())
    }

    pub fn close_ephemeral<'info>(
        sponsor: &AccountInfo<'info>,
        eph: &AccountInfo<'info>,
        _vault: &AccountInfo<'info>,
        _sponsor_seeds: &[&[u8]],
    ) -> Result<()> {
        let lamports = eph.lamports();
        **eph.try_borrow_mut_lamports()? = 0;
        **sponsor.try_borrow_mut_lamports()? += lamports;
        eph.assign(&anchor_lang::system_program::ID);
        eph.resize(0)?;
        Ok(())
    }

    pub fn create_permission(
        _accounts: PermissionAccounts,
        _members: EphemeralMembersArgs,
        _signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        Ok(())
    }

    pub fn update_permission(
        _accounts: PermissionAccounts,
        _members: EphemeralMembersArgs,
        _signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        Ok(())
    }

    pub fn close_permission(
        _accounts: PermissionAccounts,
        _signer_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        Ok(())
    }

    pub struct ActionAccounts<'a, 'info> {
        pub payer: &'a AccountInfo<'info>,
        pub magic_context: &'a AccountInfo<'info>,
        pub magic_program: &'a AccountInfo<'info>,
        pub escrow_authority: &'a AccountInfo<'info>,
    }

    pub fn schedule_standalone_action(
        _accounts: ActionAccounts,
        _action_accounts: &[(Pubkey, bool)],
        _data: Vec<u8>,
        _escrow_seeds: &[&[&[u8]]],
    ) -> Result<()> {
        Ok(())
    }

    pub fn commit_and_undelegate<'info>(
        _payer: &AccountInfo<'info>,
        _magic_context: &AccountInfo<'info>,
        _magic_program: &AccountInfo<'info>,
        _accounts: &[AccountInfo<'info>],
    ) -> Result<()> {
        Ok(())
    }
}

pub use imp::*;
