use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TransferChecked};

declare_id!("3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4");

pub mod errors;
pub mod instructions;
pub mod policy;
pub mod state;

use instructions::*;
use policy::{validate_mandate_params, validate_payment, validate_supported_mints};

pub const RECEIPT_STATUS_SETTLED: u8 = 1;

#[event]
pub struct MandateCreated {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub approved_agent: Pubkey,
    pub allowed_mint: Pubkey,
    pub allowed_recipient: Pubkey,
    pub expires_at_slot: u64,
}

#[event]
pub struct ConfigInitialized {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub supported_mints: [Pubkey; 3],
}

#[event]
pub struct ConfigUpdated {
    pub config: Pubkey,
    pub authority: Pubkey,
    pub supported_mints: [Pubkey; 3],
}

#[event]
pub struct MandateUpdated {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub approved_agent: Pubkey,
    pub allowed_recipient: Pubkey,
    pub max_per_payment: u64,
    pub total_limit: u64,
    pub expires_at_slot: u64,
}

#[event]
pub struct MandateStatusChanged {
    pub mandate: Pubkey,
    pub owner: Pubkey,
    pub paused: bool,
    pub revoked: bool,
}

#[event]
pub struct PaymentExecuted {
    pub receipt: Pubkey,
    pub mandate: Pubkey,
    pub invoice_hash: [u8; 32],
    pub payment_id: [u8; 32],
    pub mint: Pubkey,
    pub recipient_token_account: Pubkey,
    pub amount: u64,
    pub agent: Pubkey,
    pub executed_at_slot: u64,
}

#[program]
pub mod chainpay {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        supported_mints: [Pubkey; 3],
    ) -> Result<()> {
        validate_supported_mints(&supported_mints)?;
        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.supported_mints = supported_mints;
        config.bump = ctx.bumps.config;

        emit!(ConfigInitialized {
            config: config.key(),
            authority: config.authority,
            supported_mints: config.supported_mints,
        });

        Ok(())
    }

    pub fn update_config(ctx: Context<UpdateConfig>, supported_mints: [Pubkey; 3]) -> Result<()> {
        validate_supported_mints(&supported_mints)?;
        let config = &mut ctx.accounts.config;
        config.supported_mints = supported_mints;

        emit!(ConfigUpdated {
            config: config.key(),
            authority: config.authority,
            supported_mints: config.supported_mints,
        });

        Ok(())
    }

    pub fn create_mandate(ctx: Context<CreateMandate>, params: MandateParams) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        validate_mandate_params(&params, current_slot)?;

        let mandate = &mut ctx.accounts.mandate;
        mandate.owner = ctx.accounts.owner.key();
        mandate.approved_agent = params.approved_agent;
        mandate.source_token_account = params.source_token_account;
        mandate.allowed_mint = params.allowed_mint;
        mandate.allowed_recipient = params.allowed_recipient;
        mandate.max_per_payment = params.max_per_payment;
        mandate.total_limit = params.total_limit;
        mandate.amount_spent = 0;
        mandate.payment_count = 0;
        mandate.expires_at_slot = params.expires_at_slot;
        mandate.paused = false;
        mandate.revoked = false;
        mandate.bump = ctx.bumps.mandate;

        emit!(MandateCreated {
            mandate: mandate.key(),
            owner: mandate.owner,
            approved_agent: mandate.approved_agent,
            allowed_mint: mandate.allowed_mint,
            allowed_recipient: mandate.allowed_recipient,
            expires_at_slot: mandate.expires_at_slot,
        });

        Ok(())
    }

    pub fn update_mandate(ctx: Context<UpdateMandate>, params: MandateUpdate) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        let mandate = &mut ctx.accounts.mandate;

        require!(!mandate.revoked, errors::ChainPayError::MandateRevoked);
        require!(
            params.approved_agent != Pubkey::default(),
            errors::ChainPayError::InvalidAgent
        );
        require!(
            params.allowed_recipient != Pubkey::default(),
            errors::ChainPayError::InvalidRecipient
        );
        require!(
            params.max_per_payment > 0,
            errors::ChainPayError::InvalidPerPaymentLimit
        );
        require!(
            params.total_limit >= params.max_per_payment
                && params.total_limit >= mandate.amount_spent,
            errors::ChainPayError::InvalidTotalLimit
        );
        require!(
            params.expires_at_slot > current_slot,
            errors::ChainPayError::InvalidExpiry
        );

        mandate.approved_agent = params.approved_agent;
        mandate.allowed_recipient = params.allowed_recipient;
        mandate.max_per_payment = params.max_per_payment;
        mandate.total_limit = params.total_limit;
        mandate.expires_at_slot = params.expires_at_slot;
        mandate.paused = params.paused;

        emit!(MandateUpdated {
            mandate: mandate.key(),
            owner: mandate.owner,
            approved_agent: mandate.approved_agent,
            allowed_recipient: mandate.allowed_recipient,
            max_per_payment: mandate.max_per_payment,
            total_limit: mandate.total_limit,
            expires_at_slot: mandate.expires_at_slot,
        });

        Ok(())
    }

    pub fn pause_mandate(ctx: Context<PauseMandate>) -> Result<()> {
        let mandate = &mut ctx.accounts.mandate;
        require!(!mandate.revoked, errors::ChainPayError::MandateRevoked);
        mandate.paused = true;

        emit!(MandateStatusChanged {
            mandate: mandate.key(),
            owner: mandate.owner,
            paused: mandate.paused,
            revoked: mandate.revoked,
        });

        Ok(())
    }

    pub fn revoke_mandate(ctx: Context<RevokeMandate>) -> Result<()> {
        let mandate = &mut ctx.accounts.mandate;
        mandate.paused = true;
        mandate.revoked = true;

        emit!(MandateStatusChanged {
            mandate: mandate.key(),
            owner: mandate.owner,
            paused: mandate.paused,
            revoked: mandate.revoked,
        });

        Ok(())
    }

    pub fn execute_payment(ctx: Context<ExecutePayment>, params: PaymentParams) -> Result<()> {
        let current_slot = Clock::get()?.slot;
        validate_payment(&ctx.accounts.mandate, &params, current_slot)?;

        let mandate_key = ctx.accounts.mandate.key();
        let mandate_owner = ctx.accounts.mandate.owner;
        let mandate_bump = ctx.accounts.mandate.bump;
        let new_amount_spent = ctx
            .accounts
            .mandate
            .amount_spent
            .checked_add(params.amount)
            .ok_or(error!(errors::ChainPayError::TotalLimitExceeded))?;
        let new_payment_count = ctx
            .accounts
            .mandate
            .payment_count
            .checked_add(1)
            .ok_or(error!(errors::ChainPayError::TotalLimitExceeded))?;

        let signer_seeds: &[&[u8]] = &[b"mandate", mandate_owner.as_ref(), &[mandate_bump]];
        let signer_seed_set = [signer_seeds];
        let transfer_accounts = TransferChecked {
            from: ctx.accounts.source_token_account.to_account_info(),
            mint: ctx.accounts.allowed_mint.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.mandate.to_account_info(),
        };
        let transfer_context = CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            transfer_accounts,
            &signer_seed_set,
        );
        token_interface::transfer_checked(
            transfer_context,
            params.amount,
            ctx.accounts.allowed_mint.decimals,
        )?;

        let mandate = &mut ctx.accounts.mandate;
        mandate.amount_spent = new_amount_spent;
        mandate.payment_count = new_payment_count;

        let receipt = &mut ctx.accounts.receipt;
        receipt.mandate = mandate_key;
        receipt.invoice_hash = params.invoice_hash;
        receipt.payment_id = params.payment_id;
        receipt.mint = mandate.allowed_mint;
        receipt.source_token_account = mandate.source_token_account;
        receipt.recipient_token_account = mandate.allowed_recipient;
        receipt.amount = params.amount;
        receipt.agent = ctx.accounts.agent.key();
        receipt.executed_at_slot = current_slot;
        // Solana transaction signatures are only known after submission. The
        // caller supplies a deterministic reference that the backend can map
        // to the finalized transaction signature.
        receipt.signature_reference = params.signature_reference;
        receipt.status = RECEIPT_STATUS_SETTLED;
        receipt.bump = ctx.bumps.receipt;

        emit!(PaymentExecuted {
            receipt: receipt.key(),
            mandate: receipt.mandate,
            invoice_hash: receipt.invoice_hash,
            payment_id: receipt.payment_id,
            mint: receipt.mint,
            recipient_token_account: receipt.recipient_token_account,
            amount: receipt.amount,
            agent: receipt.agent,
            executed_at_slot: receipt.executed_at_slot,
        });

        Ok(())
    }
}
