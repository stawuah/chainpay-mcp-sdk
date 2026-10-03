use crate::{
    constants::*,
    errors::CardPolicyError,
    state::{CardPolicy, CheckoutIntent, Reservation},
};
use anchor_lang::prelude::*;
use ephemeral_rollups_sdk::access_control::structs::EphemeralPermission;

pub fn now() -> Result<i64> {
    Ok(Clock::get()?.unix_timestamp)
}

pub fn require_owner(policy: &CardPolicy, signer: &Pubkey) -> Result<()> {
    require!(policy.owner == *signer, CardPolicyError::Unauthorized);
    Ok(())
}

pub fn require_authorizer(policy: &CardPolicy, signer: &Pubkey) -> Result<()> {
    require!(policy.is_set(), CardPolicyError::PolicyNotSet);
    require!(policy.authorizer == *signer, CardPolicyError::Unauthorized);
    Ok(())
}

/// Returns `true` when the signer is the owner, `false` for the authorizer.
pub fn require_owner_or_authorizer(policy: &CardPolicy, signer: &Pubkey) -> Result<bool> {
    if policy.owner == *signer {
        return Ok(true);
    }
    require!(
        policy.is_set() && policy.authorizer == *signer,
        CardPolicyError::Unauthorized
    );
    Ok(false)
}

pub fn require_event_id(event_id_hash: &[u8; 32]) -> Result<()> {
    require!(*event_id_hash != [0u8; 32], CardPolicyError::InvalidEventId);
    Ok(())
}

/// Replay guard for issuer events that have no PDA of their own. A retried
/// transaction carrying the same event id is rejected while the id is among the
/// last `EVENT_RING` applied (retries land within seconds; Axum's applied-set
/// covers the long tail).
pub fn record_event_id(policy: &mut CardPolicy, event_id_hash: &[u8; 32]) -> Result<()> {
    require_event_id(event_id_hash)?;
    require!(
        !policy.event_ids.contains(event_id_hash),
        CardPolicyError::DuplicateEvent
    );
    let slot = (policy.event_count as usize) % EVENT_RING;
    policy.event_ids[slot] = *event_id_hash;
    policy.event_count = policy.event_count.wrapping_add(1);
    Ok(())
}

pub fn ephemeral_created(policy: &mut CardPolicy) -> Result<()> {
    policy.ephemeral_count = policy
        .ephemeral_count
        .checked_add(1)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    Ok(())
}

pub fn ephemeral_closed(policy: &mut CardPolicy) {
    policy.ephemeral_count = policy.ephemeral_count.saturating_sub(1);
}

pub const fn ephemeral_rent(data_len: usize) -> u64 {
    ephemeral_rollups_sdk::ephemeral_accounts::rent(data_len as u32)
}

pub const PERMISSION_RENT: u64 = ephemeral_rent(EphemeralPermission::size_of(MAX_MEMBERS));
pub const RESERVATION_LEN: usize = 8 + Reservation::INIT_SPACE;
pub const INTENT_LEN: usize = 8 + CheckoutIntent::INIT_SPACE;
const LARGEST_EPHEMERAL_LEN: usize = if RESERVATION_LEN > INTENT_LEN {
    RESERVATION_LEN
} else {
    INTENT_LEN
};
/// Allowance for Magic Action / intent scheduling fees paid on the ER.
pub const MAGIC_FEE_ALLOWANCE: u64 = 1_000_000;
pub const PREFUNDED_EPHEMERAL_ACCOUNTS: u64 = 64;
/// Rent for the policy and period permissions, 64 reservations or intents with
/// their own permissions, and the magic fee allowance (contracts.md §1.3 #1).
pub const MIN_PREFUND: u64 = 2 * PERMISSION_RENT
    + PREFUNDED_EPHEMERAL_ACCOUNTS * (ephemeral_rent(LARGEST_EPHEMERAL_LEN) + PERMISSION_RENT)
    + MAGIC_FEE_ALLOWANCE;
