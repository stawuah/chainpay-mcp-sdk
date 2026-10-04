//! Support splitter: a vault that can only ever pay its two recipients equally.
//!
//! Money flow:
//!   donor --(SOL or USDC transfer)--> vault
//!   allocate_*  (anyone)  splits new, unallocated funds into two equal "owed" balances
//!   pay_*(side) (anyone)  sends one side's owed balance to that side's own wallet
//!
//! There is no admin, no withdraw, no delegate, no authority change and no close
//! instruction. Each side is paid independently, so a broken destination for one
//! side leaves the other side's payout untouched. Only the current key for a side
//! can rotate that side, the new wallet must co-sign, and rotation never touches
//! the other side.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, AssociatedToken};
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

declare_id!("D1DvnVq37696mcFB5JeVWZy22wjxZ5xPJmZazbfPK7BH");

pub mod constants {
    use anchor_lang::prelude::*;

    pub const VAULT_SEED: &[u8] = b"vault";

    // Throwaway keys derived from the fixed seeds [11; 32], [22; 32], [33; 32].
    // Only the LiteSVM test build uses them.
    #[cfg(feature = "test-config")]
    pub const RECIPIENT_A: Pubkey = pubkey!("7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9");
    #[cfg(feature = "test-config")]
    pub const RECIPIENT_B: Pubkey = pubkey!("6TcyBfPdBt1kjsvDZLzmBFnuMaLWiTaAt4RjUr9VA5YD");
    #[cfg(feature = "test-config")]
    pub const USDC_MINT: Pubkey = pubkey!("AB3FQHskSYuWVw4M9EpGdxNzrAjBNiYGpbH4CVzLFene");

    // Filled in only from setup comments verified by scripts/read-setup.mjs.
    // While they are all-zero, `initialize` refuses to run.
    #[cfg(not(feature = "test-config"))]
    pub const RECIPIENT_A: Pubkey = Pubkey::new_from_array([0; 32]);
    #[cfg(not(feature = "test-config"))]
    pub const RECIPIENT_B: Pubkey = Pubkey::new_from_array([0; 32]);

    // Circle's published USDC mints (classic SPL Token program).
    #[cfg(all(not(feature = "test-config"), feature = "devnet"))]
    pub const USDC_MINT: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    #[cfg(all(not(feature = "test-config"), not(feature = "devnet")))]
    pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
}

use constants::*;

#[program]
pub mod support_splitter {
    use super::*;

    /// Creates the vault. Both pinned recipients must sign, so nobody can claim
    /// the vault first with their own wallets.
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        require!(
            RECIPIENT_A != Pubkey::default() && RECIPIENT_B != Pubkey::default(),
            SplitterError::PlaceholderRecipients
        );
        require_keys_neq!(RECIPIENT_A, RECIPIENT_B, SplitterError::DuplicateRecipient);

        let vault_key = ctx.accounts.vault.key();
        let vault_usdc_key = ctx.accounts.vault_usdc.key();
        for recipient in [RECIPIENT_A, RECIPIENT_B] {
            require!(
                recipient != vault_key && recipient != vault_usdc_key,
                SplitterError::InvalidRecipient
            );
        }

        // Idempotent: someone may already have created the vault's USDC account
        // by sending USDC to the vault address. The ATA program rejects an
        // existing account with the wrong mint or owner.
        associated_token::create_idempotent(CpiContext::new(
            ctx.accounts.associated_token_program.key(),
            associated_token::Create {
                payer: ctx.accounts.payer.to_account_info(),
                associated_token: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                token_program: ctx.accounts.token_program.to_account_info(),
            },
        ))?;

        let vault_usdc = {
            let info = ctx.accounts.vault_usdc.to_account_info();
            require_keys_eq!(
                *info.owner,
                token::ID,
                SplitterError::InvalidVaultTokenAccount
            );
            let data = info.try_borrow_data()?;
            TokenAccount::try_deserialize(&mut &data[..])?
        };
        require!(
            vault_usdc.mint == USDC_MINT
                && vault_usdc.owner == vault_key
                && vault_usdc.delegate.is_none()
                && vault_usdc.close_authority.is_none(),
            SplitterError::InvalidVaultTokenAccount
        );

        let vault = &mut ctx.accounts.vault;
        vault.recipients = [RECIPIENT_A, RECIPIENT_B];
        vault.sol = Ledger::default();
        vault.usdc = Ledger::default();
        vault.bump = ctx.bumps.vault;

        emit!(VaultInitialized {
            vault: vault_key,
            vault_usdc: vault_usdc_key,
            recipients: vault.recipients,
        });
        Ok(())
    }

    /// Splits SOL that arrived since the last allocation into two equal owed
    /// balances. Rent and any odd lamport stay in the vault.
    pub fn allocate_sol(ctx: Context<AllocateSol>) -> Result<()> {
        let info = ctx.accounts.vault.to_account_info();
        let rent = Rent::get()?.minimum_balance(info.data_len());
        let balance = info.lamports();
        let vault = &mut ctx.accounts.vault;
        allocate(&mut vault.sol, balance, rent, Asset::Sol)
    }

    /// Splits USDC that arrived since the last allocation into two equal owed
    /// balances. An odd base unit stays in the vault.
    pub fn allocate_usdc(ctx: Context<AllocateUsdc>) -> Result<()> {
        let balance = ctx.accounts.vault_usdc.amount;
        let vault = &mut ctx.accounts.vault;
        allocate(&mut vault.usdc, balance, 0, Asset::Usdc)
    }

    /// Pays one side's owed SOL to that side's wallet. Anyone may call it; the
    /// destination is fixed by the vault, never by the caller.
    pub fn pay_sol(ctx: Context<PaySol>, side: Side) -> Result<()> {
        let amount = take_owed(&mut ctx.accounts.vault.sol, side)?;
        if amount == 0 {
            return Ok(());
        }

        let vault_info = ctx.accounts.vault.to_account_info();
        vault_info.sub_lamports(amount)?;
        ctx.accounts.recipient.add_lamports(amount)?;

        let rent = Rent::get()?.minimum_balance(vault_info.data_len());
        let ledger = &ctx.accounts.vault.sol;
        let committed = rent
            .checked_add(ledger.owed[0])
            .and_then(|v| v.checked_add(ledger.owed[1]))
            .ok_or(SplitterError::LedgerInvariant)?;
        require!(
            vault_info.lamports() >= committed,
            SplitterError::LedgerInvariant
        );

        emit!(Paid {
            asset: Asset::Sol,
            side,
            amount,
            destination: ctx.accounts.recipient.key(),
        });
        Ok(())
    }

    /// Pays one side's owed USDC to any USDC account owned by that side. If one
    /// token account is frozen or broken, the side can use another account it owns.
    pub fn pay_usdc(ctx: Context<PayUsdc>, side: Side) -> Result<()> {
        let amount = take_owed(&mut ctx.accounts.vault.usdc, side)?;
        if amount == 0 {
            return Ok(());
        }

        let bump = [ctx.accounts.vault.bump];
        let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault_usdc.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            ctx.accounts.usdc_mint.decimals,
        )?;

        ctx.accounts.vault_usdc.reload()?;
        let ledger = &ctx.accounts.vault.usdc;
        let committed = ledger.owed[0]
            .checked_add(ledger.owed[1])
            .ok_or(SplitterError::LedgerInvariant)?;
        require!(
            ctx.accounts.vault_usdc.amount >= committed,
            SplitterError::LedgerInvariant
        );

        emit!(Paid {
            asset: Asset::Usdc,
            side,
            amount,
            destination: ctx.accounts.destination.key(),
        });
        Ok(())
    }

    /// Moves one side to a new wallet. That side's current key and the new
    /// wallet must both sign (so a typo or an address nobody controls can't
    /// become a recipient), and the side keeps its owed balances.
    pub fn rotate_recipient(
        ctx: Context<RotateRecipient>,
        side: Side,
        new_recipient: Pubkey,
    ) -> Result<()> {
        let vault_key = ctx.accounts.vault.key();
        let vault_usdc_key = ctx.accounts.vault_usdc.key();
        let vault = &mut ctx.accounts.vault;
        let other = vault.recipients[side.other().index()];
        let old = vault.recipients[side.index()];

        require!(
            new_recipient != Pubkey::default(),
            SplitterError::InvalidRecipient
        );
        require!(
            new_recipient != vault_key && new_recipient != vault_usdc_key,
            SplitterError::InvalidRecipient
        );
        require_keys_neq!(new_recipient, other, SplitterError::DuplicateRecipient);
        require_keys_neq!(new_recipient, old, SplitterError::SameRecipient);

        vault.recipients[side.index()] = new_recipient;
        emit!(RecipientRotated {
            side,
            old,
            new: new_recipient,
        });
        Ok(())
    }
}

fn allocate(ledger: &mut Ledger, balance: u64, reserved: u64, asset: Asset) -> Result<()> {
    let committed = reserved
        .checked_add(ledger.owed[0])
        .and_then(|v| v.checked_add(ledger.owed[1]))
        .ok_or(SplitterError::LedgerInvariant)?;
    let unallocated = balance
        .checked_sub(committed)
        .ok_or(SplitterError::LedgerInvariant)?;
    let share = unallocated / 2;
    if share == 0 {
        return Ok(());
    }

    ledger.owed[0] = ledger.owed[0]
        .checked_add(share)
        .ok_or(SplitterError::LedgerInvariant)?;
    ledger.owed[1] = ledger.owed[1]
        .checked_add(share)
        .ok_or(SplitterError::LedgerInvariant)?;
    ledger.allocated_each = ledger
        .allocated_each
        .checked_add(share)
        .ok_or(SplitterError::LedgerInvariant)?;

    emit!(Allocated { asset, share });
    Ok(())
}

fn take_owed(ledger: &mut Ledger, side: Side) -> Result<u64> {
    let i = side.index();
    let amount = ledger.owed[i];
    ledger.owed[i] = 0;
    ledger.paid[i] = ledger.paid[i]
        .checked_add(amount)
        .ok_or(SplitterError::LedgerInvariant)?;
    Ok(amount)
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    /// Index 0 is side A, index 1 is side B.
    pub recipients: [Pubkey; 2],
    pub sol: Ledger,
    pub usdc: Ledger,
    pub bump: u8,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub struct Ledger {
    /// Allocated but not yet paid, per side.
    pub owed: [u64; 2],
    /// Total ever allocated to each side. Both sides always receive the same.
    pub allocated_each: u64,
    /// Total ever paid out, per side.
    pub paid: [u64; 2],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    A,
    B,
}

impl Side {
    pub fn index(self) -> usize {
        match self {
            Side::A => 0,
            Side::B => 1,
        }
    }

    pub fn other(self) -> Side {
        match self {
            Side::A => Side::B,
            Side::B => Side::A,
        }
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asset {
    Sol,
    Usdc,
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(address = RECIPIENT_A @ SplitterError::UnauthorizedInitializer)]
    pub recipient_a: Signer<'info>,
    #[account(address = RECIPIENT_B @ SplitterError::UnauthorizedInitializer)]
    pub recipient_b: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    /// CHECK: must be the canonical USDC ATA of the vault. Created (or validated
    /// if it already exists) by the ATA program in the handler.
    #[account(
        mut,
        address = associated_token::get_associated_token_address(&vault.key(), &USDC_MINT)
            @ SplitterError::InvalidVaultTokenAccount,
    )]
    pub vault_usdc: UncheckedAccount<'info>,
    #[account(address = USDC_MINT @ SplitterError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AllocateSol<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct AllocateUsdc<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(address = USDC_MINT @ SplitterError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(side: Side)]
pub struct PaySol<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: lamports only; must be exactly the vault's recipient for `side`.
    #[account(
        mut,
        address = vault.recipients[side.index()] @ SplitterError::WrongDestination,
    )]
    pub recipient: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(side: Side)]
pub struct PayUsdc<'info> {
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = vault,
        associated_token::token_program = token_program,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,
    #[account(
        mut,
        token::mint = usdc_mint,
        token::token_program = token_program,
        constraint = destination.owner == vault.recipients[side.index()] @ SplitterError::WrongDestination,
        constraint = destination.key() != vault_usdc.key() @ SplitterError::WrongDestination,
    )]
    pub destination: Account<'info, TokenAccount>,
    #[account(address = USDC_MINT @ SplitterError::WrongMint)]
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(side: Side, new_recipient: Pubkey)]
pub struct RotateRecipient<'info> {
    #[account(address = vault.recipients[side.index()] @ SplitterError::Unauthorized)]
    pub current: Signer<'info>,
    /// The new wallet proves it can sign, so payouts never go to a key nobody holds.
    #[account(address = new_recipient @ SplitterError::NewRecipientMustSign)]
    pub incoming: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: only its address is used, to stop a side rotating to it.
    #[account(address = associated_token::get_associated_token_address(&vault.key(), &USDC_MINT))]
    pub vault_usdc: UncheckedAccount<'info>,
}

#[event]
pub struct VaultInitialized {
    pub vault: Pubkey,
    pub vault_usdc: Pubkey,
    pub recipients: [Pubkey; 2],
}

#[event]
pub struct Allocated {
    pub asset: Asset,
    /// Amount added to each side.
    pub share: u64,
}

#[event]
pub struct Paid {
    pub asset: Asset,
    pub side: Side,
    pub amount: u64,
    pub destination: Pubkey,
}

#[event]
pub struct RecipientRotated {
    pub side: Side,
    pub old: Pubkey,
    pub new: Pubkey,
}

#[error_code]
pub enum SplitterError {
    #[msg("Recipients are still placeholders; fill them from verified setup comments")]
    PlaceholderRecipients,
    #[msg("Only the two pinned recipients can initialize the vault")]
    UnauthorizedInitializer,
    #[msg("Only the current recipient for this side can do that")]
    Unauthorized,
    #[msg("Recipient can't be empty, the vault, or the vault's token account")]
    InvalidRecipient,
    #[msg("Both sides can't use the same wallet")]
    DuplicateRecipient,
    #[msg("New recipient is the same as the current one")]
    SameRecipient,
    #[msg("Vault USDC account must be the vault's canonical USDC ATA with no delegate or close authority")]
    InvalidVaultTokenAccount,
    #[msg("Only the official USDC mint is supported")]
    WrongMint,
    #[msg("Destination doesn't belong to this side's recipient")]
    WrongDestination,
    #[msg("Ledger invariant broken: vault holds less than it owes")]
    LedgerInvariant,
    #[msg("The new recipient wallet must sign the rotation")]
    NewRecipientMustSign,
}

#[cfg(test)]
mod ledger_tests {
    use super::*;

    #[test]
    fn allocate_handles_u64_boundaries() {
        let mut ledger = Ledger::default();
        allocate(&mut ledger, u64::MAX, 0, Asset::Usdc).unwrap();
        assert_eq!(ledger.owed, [u64::MAX / 2, u64::MAX / 2]);
        // One unit of dust left, nothing more to allocate.
        allocate(&mut ledger, u64::MAX, 0, Asset::Usdc).unwrap();
        assert_eq!(ledger.owed, [u64::MAX / 2, u64::MAX / 2]);
    }

    #[test]
    fn allocate_refuses_a_balance_below_what_is_owed() {
        let mut ledger = Ledger {
            owed: [5, 5],
            allocated_each: 5,
            paid: [0, 0],
        };
        assert!(allocate(&mut ledger, 9, 0, Asset::Usdc).is_err());
        assert!(allocate(&mut ledger, 12, 3, Asset::Sol).is_err());
        assert_eq!(ledger.owed, [5, 5]);
    }

    #[test]
    fn take_owed_moves_one_side_only() {
        let mut ledger = Ledger {
            owed: [7, 9],
            allocated_each: 9,
            paid: [2, 0],
        };
        assert_eq!(take_owed(&mut ledger, Side::B).unwrap(), 9);
        assert_eq!(ledger.owed, [7, 0]);
        assert_eq!(ledger.paid, [2, 9]);
    }
}
