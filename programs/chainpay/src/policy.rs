use crate::{
    errors::ChainPayError,
    instructions::{MandateParams, PaymentParams},
    state::{PaymentMandate, ProtocolConfig},
};
use anchor_lang::prelude::*;

pub fn validate_supported_mints(supported_mints: &[Pubkey; 3]) -> Result<()> {
    let mut has_supported_mint = false;

    for (index, mint) in supported_mints.iter().enumerate() {
        if *mint == Pubkey::default() {
            continue;
        }

        has_supported_mint = true;
        require!(
            !supported_mints[..index].contains(mint),
            ChainPayError::InvalidSupportedMintList
        );
    }

    require!(has_supported_mint, ChainPayError::InvalidSupportedMintList);
    Ok(())
}

pub fn is_supported_mint(config: &ProtocolConfig, mint: &Pubkey) -> bool {
    config.supported_mints.contains(mint)
}

pub fn validate_mandate_params(params: &MandateParams, current_slot: u64) -> Result<()> {
    require!(
        params.approved_agent != Pubkey::default(),
        ChainPayError::InvalidAgent
    );
    require!(
        params.source_token_account != Pubkey::default(),
        ChainPayError::InvalidSourceTokenAccount
    );
    require!(
        params.allowed_mint != Pubkey::default(),
        ChainPayError::InvalidMint
    );
    require!(
        params.max_per_payment > 0,
        ChainPayError::InvalidPerPaymentLimit
    );
    require!(
        params.total_limit >= params.max_per_payment,
        ChainPayError::InvalidTotalLimit
    );
    require!(
        params.expires_at_slot > current_slot,
        ChainPayError::InvalidExpiry
    );
    require!(
        params.max_payment_count == 0 || params.max_payment_count >= 1,
        ChainPayError::PaymentCountExceeded
    );

    Ok(())
}

pub fn validate_payment(
    mandate: &PaymentMandate,
    params: &PaymentParams,
    current_slot: u64,
) -> Result<()> {
    require!(!mandate.revoked, ChainPayError::MandateRevoked);
    require!(!mandate.paused, ChainPayError::MandatePaused);
    require!(
        mandate.expires_at_slot > current_slot,
        ChainPayError::MandateExpired
    );
    require!(params.amount > 0, ChainPayError::InvalidPaymentAmount);
    require!(
        params.amount <= mandate.max_per_payment,
        ChainPayError::AmountExceedsPerPayment
    );
    require!(
        params.invoice_hash != [0u8; 32],
        ChainPayError::InvalidInvoiceHash
    );
    require!(
        params.payment_id != [0u8; 32],
        ChainPayError::InvalidPaymentId
    );
    require!(
        params.signature_reference != [0u8; 32],
        ChainPayError::InvalidSignatureReference
    );

    let new_amount_spent = mandate
        .amount_spent
        .checked_add(params.amount)
        .ok_or(error!(ChainPayError::TotalLimitExceeded))?;
    require!(
        new_amount_spent <= mandate.total_limit,
        ChainPayError::TotalLimitExceeded
    );
    let new_payment_count = mandate
        .payment_count
        .checked_add(1)
        .ok_or(error!(ChainPayError::PaymentCountExceeded))?;
    require!(
        mandate.max_payment_count == 0 || new_payment_count <= mandate.max_payment_count,
        ChainPayError::PaymentCountExceeded
    );
    if mandate.last_payment_slot > 0 {
        let next_allowed_slot = mandate
            .last_payment_slot
            .checked_add(mandate.cooldown_slots)
            .ok_or(error!(ChainPayError::PaymentCooldownActive))?;
        require!(
            current_slot >= next_allowed_slot,
            ChainPayError::PaymentCooldownActive
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_mandate_params() -> MandateParams {
        MandateParams {
            approved_agent: Pubkey::new_unique(),
            source_token_account: Pubkey::new_unique(),
            allowed_mint: Pubkey::new_unique(),
            max_per_payment: 25,
            total_limit: 100,
            expires_at_slot: 101,
            max_payment_count: 0,
            cooldown_slots: 0,
        }
    }

    fn valid_mandate() -> PaymentMandate {
        let params = valid_mandate_params();
        PaymentMandate {
            owner: Pubkey::new_unique(),
            approved_agent: params.approved_agent,
            source_token_account: params.source_token_account,
            allowed_mint: params.allowed_mint,
            legacy_allowed_recipient: Pubkey::default(),
            max_per_payment: params.max_per_payment,
            total_limit: params.total_limit,
            amount_spent: 0,
            payment_count: 0,
            expires_at_slot: params.expires_at_slot,
            max_payment_count: params.max_payment_count,
            cooldown_slots: params.cooldown_slots,
            last_payment_slot: 0,
            paused: false,
            revoked: false,
            bump: 255,
        }
    }

    fn valid_payment() -> PaymentParams {
        PaymentParams {
            invoice_hash: [1u8; 32],
            payment_id: [2u8; 32],
            signature_reference: [3u8; 32],
            amount: 25,
        }
    }

    #[test]
    fn accepts_a_non_empty_unique_supported_mint_list() {
        let supported_mints = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::default(),
        ];
        assert!(validate_supported_mints(&supported_mints).is_ok());
    }

    #[test]
    fn rejects_empty_or_duplicate_supported_mint_lists() {
        assert!(validate_supported_mints(&[Pubkey::default(); 3]).is_err());

        let mint = Pubkey::new_unique();
        assert!(validate_supported_mints(&[mint, mint, Pubkey::default()]).is_err());
    }

    #[test]
    fn accepts_a_valid_mandate() {
        assert!(validate_mandate_params(&valid_mandate_params(), 100).is_ok());
    }

    #[test]
    fn rejects_invalid_mandate_limits_and_expiry() {
        let mut params = valid_mandate_params();
        params.max_per_payment = 0;
        assert!(validate_mandate_params(&params, 100).is_err());

        params = valid_mandate_params();
        params.total_limit = 24;
        assert!(validate_mandate_params(&params, 100).is_err());

        params = valid_mandate_params();
        params.expires_at_slot = 100;
        assert!(validate_mandate_params(&params, 100).is_err());
    }

    #[test]
    fn rejects_paused_revoked_and_expired_mandates() {
        let mut mandate = valid_mandate();
        mandate.paused = true;
        assert!(validate_payment(&mandate, &valid_payment(), 100).is_err());

        mandate.paused = false;
        mandate.revoked = true;
        assert!(validate_payment(&mandate, &valid_payment(), 100).is_err());

        mandate.revoked = false;
        mandate.expires_at_slot = 100;
        assert!(validate_payment(&mandate, &valid_payment(), 100).is_err());
    }

    #[test]
    fn rejects_per_payment_and_total_limit_overruns() {
        let mandate = valid_mandate();
        let mut payment = valid_payment();
        payment.amount = 26;
        assert!(validate_payment(&mandate, &payment, 100).is_err());

        let mut mandate = valid_mandate();
        mandate.amount_spent = 80;
        payment.amount = 25;
        assert!(validate_payment(&mandate, &payment, 100).is_err());

        let mut mandate = valid_mandate();
        mandate.max_payment_count = 1;
        mandate.payment_count = 1;
        assert!(validate_payment(&mandate, &valid_payment(), 100).is_err());

        let mut mandate = valid_mandate();
        mandate.cooldown_slots = 10;
        mandate.last_payment_slot = 95;
        assert!(validate_payment(&mandate, &valid_payment(), 100).is_err());
    }

    #[test]
    fn rejects_replay_identifiers_that_are_all_zeroes() {
        let mandate = valid_mandate();
        let mut payment = valid_payment();
        payment.invoice_hash = [0u8; 32];
        assert!(validate_payment(&mandate, &payment, 100).is_err());

        payment = valid_payment();
        payment.payment_id = [0u8; 32];
        assert!(validate_payment(&mandate, &payment, 100).is_err());

        payment = valid_payment();
        payment.signature_reference = [0u8; 32];
        assert!(validate_payment(&mandate, &payment, 100).is_err());
    }
}
