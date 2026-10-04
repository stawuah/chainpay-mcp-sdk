//! Card policy math. Mirrors the style of `programs/chainpay/src/policy.rs`
//! `validate_payment`: pure functions, first failing rule wins, checked math.
//! Every amount is an integer number of US cents.

use crate::{
    constants::*,
    errors::CardPolicyError,
    state::{CardPeriod, CardPolicy, CheckoutIntent},
};
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PolicyArgs {
    pub budget_cents: u64,
    pub max_purchase_cents: u64,
    pub max_purchases_per_period: u16,
    pub period_seconds: u32,
    pub currency: [u8; 3],
    pub merchant_id_hashes: Vec<[u8; 32]>,
    pub mccs: Vec<u16>,
    pub expires_at: i64,
    pub recurring_allowed: bool,
    pub fee_bps: u16,
    pub authorizer: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct AuthorizeArgs {
    pub auth_id_hash: [u8; 32],
    pub intent_id: [u8; 16],
    pub amount_cents: u64,
    pub currency: [u8; 3],
    pub merchant_id_hash: [u8; 32],
    pub mcc: u16,
    pub merchant_initiated: bool,
    pub single_message: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct IntentArgs {
    pub intent_id: [u8; 16],
    pub agent: Pubkey,
    pub merchant_id_hash: [u8; 32],
    pub mcc: u16,
    pub max_amount_cents: u64,
    pub currency: [u8; 3],
    pub expires_at: i64,
}

/// `fee(x) = ceil(x * fee_bps / 10_000)` in integer math (contracts.md §1.5).
pub fn fee(amount_cents: u64, fee_bps: u16) -> Result<u64> {
    let numerator = (amount_cents as u128)
        .checked_mul(fee_bps as u128)
        .and_then(|v| v.checked_add(BPS_DENOMINATOR as u128 - 1))
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    u64::try_from(numerator / BPS_DENOMINATOR as u128)
        .map_err(|_| error!(CardPolicyError::MathOverflow))
}

/// Amount plus its fee, the credit exposure one captured purchase creates.
pub fn with_fee(amount_cents: u64, fee_bps: u16) -> Result<u64> {
    amount_cents
        .checked_add(fee(amount_cents, fee_bps)?)
        .ok_or(error!(CardPolicyError::MathOverflow))
}

/// `available = budget - (captured + reserved)`, never negative.
pub fn available(policy: &CardPolicy, period: &CardPeriod) -> Result<u64> {
    let used = period
        .captured_cents
        .checked_add(period.reserved_cents)
        .ok_or(error!(CardPolicyError::MathOverflow))?;
    Ok(policy.budget_cents.saturating_sub(used))
}

fn has_duplicates<T: PartialEq>(items: &[T]) -> bool {
    items
        .iter()
        .enumerate()
        .any(|(index, item)| items[..index].contains(item))
}

pub fn validate_policy_args(args: &PolicyArgs, owner: &Pubkey, now: i64) -> Result<()> {
    require!(args.max_purchase_cents > 0, CardPolicyError::InvalidPolicy);
    require!(
        args.max_purchase_cents <= args.budget_cents,
        CardPolicyError::InvalidPolicy
    );
    require!(
        args.budget_cents <= MAX_BUDGET_CENTS,
        CardPolicyError::InvalidPolicy
    );
    require!(
        args.period_seconds >= MIN_PERIOD_SECONDS,
        CardPolicyError::InvalidPolicy
    );
    require!(args.currency == USD, CardPolicyError::InvalidPolicy);
    require!(args.fee_bps <= MAX_FEE_BPS, CardPolicyError::InvalidPolicy);
    require!(
        args.merchant_id_hashes.len() <= MAX_MERCHANTS && args.mccs.len() <= MAX_MCCS,
        CardPolicyError::InvalidPolicy
    );
    require!(
        !args.merchant_id_hashes.is_empty() || !args.mccs.is_empty(),
        CardPolicyError::InvalidPolicy
    );
    require!(
        !has_duplicates(&args.merchant_id_hashes) && !has_duplicates(&args.mccs),
        CardPolicyError::InvalidPolicy
    );
    require!(
        !args.merchant_id_hashes.contains(&[0u8; 32]) && !args.mccs.contains(&0),
        CardPolicyError::InvalidPolicy
    );
    require!(
        args.expires_at == 0 || args.expires_at > now,
        CardPolicyError::InvalidPolicy
    );
    require!(
        args.authorizer != Pubkey::default() && args.authorizer != *owner,
        CardPolicyError::InvalidPolicy
    );
    Ok(())
}

/// Writes validated policy fields. Never touches period counters, holds,
/// credit exposure, membership or the ledger.
pub fn apply_policy_args(policy: &mut CardPolicy, args: &PolicyArgs) {
    policy.budget_cents = args.budget_cents;
    policy.max_purchase_cents = args.max_purchase_cents;
    policy.max_purchases_per_period = args.max_purchases_per_period;
    policy.period_seconds = args.period_seconds;
    policy.currency = args.currency;
    policy.merchant_count = args.merchant_id_hashes.len() as u8;
    policy.merchant_id_hashes = [[0u8; 32]; MAX_MERCHANTS];
    policy.merchant_id_hashes[..args.merchant_id_hashes.len()]
        .copy_from_slice(&args.merchant_id_hashes);
    policy.mcc_count = args.mccs.len() as u8;
    policy.mccs = [0u16; MAX_MCCS];
    policy.mccs[..args.mccs.len()].copy_from_slice(&args.mccs);
    policy.expires_at = args.expires_at;
    policy.recurring_allowed = args.recurring_allowed;
    policy.fee_bps = args.fee_bps;
    policy.authorizer = args.authorizer;
}

pub fn is_expired(policy: &CardPolicy, now: i64) -> bool {
    policy.expires_at != 0 && now >= policy.expires_at
}

/// An empty merchant list means "any merchant inside the allowed MCCs".
pub fn merchant_allowed(policy: &CardPolicy, merchant_id_hash: &[u8; 32]) -> bool {
    policy.merchant_count == 0 || policy.merchants().contains(merchant_id_hash)
}

/// An empty MCC list means "any MCC" (only valid with a non-empty merchant list).
pub fn mcc_allowed(policy: &CardPolicy, mcc: u16) -> bool {
    policy.mcc_count == 0 || policy.mcc_list().contains(&mcc)
}

fn require_spendable(policy: &CardPolicy, now: i64) -> Result<()> {
    require!(policy.is_set(), CardPolicyError::PolicyNotSet);
    require!(!policy.frozen, CardPolicyError::CardFrozen);
    require!(
        policy.recovery_state == RECOVERY_NORMAL,
        CardPolicyError::RecoveryFrozen
    );
    require!(!is_expired(policy, now), CardPolicyError::PolicyExpired);
    Ok(())
}

pub fn validate_open_intent(
    policy: &CardPolicy,
    period: &CardPeriod,
    args: &IntentArgs,
    now: i64,
) -> Result<()> {
    require_spendable(policy, now)?;
    require!(
        args.intent_id != [0u8; 16] && args.agent != Pubkey::default(),
        CardPolicyError::IntentInvalid
    );
    require!(
        args.expires_at > now
            && args.expires_at
                <= now
                    .checked_add(MAX_INTENT_TTL_SECONDS)
                    .ok_or(error!(CardPolicyError::MathOverflow))?,
        CardPolicyError::IntentInvalid
    );
    require!(
        merchant_allowed(policy, &args.merchant_id_hash),
        CardPolicyError::MerchantNotAllowed
    );
    require!(
        args.mcc == 0 || mcc_allowed(policy, args.mcc),
        CardPolicyError::MccNotAllowed
    );
    require!(
        args.currency == policy.currency,
        CardPolicyError::CurrencyMismatch
    );
    require!(args.max_amount_cents > 0, CardPolicyError::InvalidAmount);
    require!(
        args.max_amount_cents <= policy.max_purchase_cents,
        CardPolicyError::AmountExceedsMax
    );
    require!(
        args.max_amount_cents <= available(policy, period)?,
        CardPolicyError::BudgetExceeded
    );
    Ok(())
}

/// The `authorize` rule chain, in the exact order of contracts.md §1.3 #9.
/// The duplicate check runs before this, in the instruction (see changelog).
pub fn validate_authorize(
    policy: &CardPolicy,
    period: &CardPeriod,
    intent: &CheckoutIntent,
    args: &AuthorizeArgs,
    now: i64,
) -> Result<()> {
    require!(policy.is_set(), CardPolicyError::PolicyNotSet);
    require!(!policy.frozen, CardPolicyError::CardFrozen);
    require!(
        policy.recovery_state == RECOVERY_NORMAL,
        CardPolicyError::RecoveryFrozen
    );
    require!(!is_expired(policy, now), CardPolicyError::PolicyExpired);

    require!(
        intent.state == INTENT_OPEN && intent.intent_id == args.intent_id,
        CardPolicyError::IntentInvalid
    );
    require!(now <= intent.expires_at, CardPolicyError::IntentExpired);
    require!(
        intent.policy_version == policy.policy_version,
        CardPolicyError::IntentStale
    );

    require!(
        args.merchant_id_hash == intent.merchant_id_hash,
        CardPolicyError::MerchantMismatch
    );
    require!(
        merchant_allowed(policy, &args.merchant_id_hash),
        CardPolicyError::MerchantNotAllowed
    );
    require!(
        mcc_allowed(policy, args.mcc) && (intent.mcc == 0 || intent.mcc == args.mcc),
        CardPolicyError::MccNotAllowed
    );
    require!(
        args.currency == intent.currency && args.currency == policy.currency,
        CardPolicyError::CurrencyMismatch
    );

    require!(args.amount_cents > 0, CardPolicyError::InvalidAmount);
    require!(
        args.amount_cents <= intent.max_amount_cents,
        CardPolicyError::AmountExceedsIntent
    );
    require!(
        args.amount_cents <= policy.max_purchase_cents,
        CardPolicyError::AmountExceedsMax
    );
    require!(
        args.amount_cents <= available(policy, period)?,
        CardPolicyError::BudgetExceeded
    );
    let next_count = period
        .purchases_count
        .checked_add(1)
        .ok_or(error!(CardPolicyError::VelocityExceeded))?;
    require!(
        policy.max_purchases_per_period == 0 || next_count <= policy.max_purchases_per_period,
        CardPolicyError::VelocityExceeded
    );
    require!(
        !args.merchant_initiated || policy.recurring_allowed,
        CardPolicyError::RecurringNotAllowed
    );
    Ok(())
}

pub fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b)
        .ok_or(error!(CardPolicyError::MathOverflow))
}

pub fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b)
        .ok_or(error!(CardPolicyError::MathOverflow))
}

/// Adds captured spend plus fee to credit exposure.
pub fn add_exposure(policy: &mut CardPolicy, amount_cents: u64) -> Result<()> {
    policy.statement_outstanding_cents = add(
        policy.statement_outstanding_cents,
        with_fee(amount_cents, policy.fee_bps)?,
    )?;
    Ok(())
}

/// Credit: `outstanding -= min(amount + fee(amount), outstanding)`.
pub fn reduce_exposure(policy: &mut CardPolicy, amount_cents: u64) -> Result<()> {
    let credit = with_fee(amount_cents, policy.fee_bps)?;
    policy.statement_outstanding_cents = policy
        .statement_outstanding_cents
        .saturating_sub(credit.min(policy.statement_outstanding_cents));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;

    fn owner() -> Pubkey {
        Pubkey::new_from_array([7u8; 32])
    }

    fn merchant(n: u8) -> [u8; 32] {
        [n; 32]
    }

    fn args() -> PolicyArgs {
        PolicyArgs {
            budget_cents: 5_000,
            max_purchase_cents: 3_000,
            max_purchases_per_period: 0,
            period_seconds: 2_592_000,
            currency: USD,
            merchant_id_hashes: vec![merchant(1)],
            mccs: vec![],
            expires_at: 0,
            recurring_allowed: false,
            fee_bps: 50,
            authorizer: Pubkey::new_from_array([9u8; 32]),
        }
    }

    fn policy() -> CardPolicy {
        let mut p = CardPolicy {
            binding: Pubkey::new_from_array([1u8; 32]),
            owner: owner(),
            authorizer: Pubkey::default(),
            policy_version: 1,
            budget_cents: 0,
            max_purchase_cents: 0,
            max_purchases_per_period: 0,
            period_seconds: 0,
            currency: [0; 3],
            merchant_count: 0,
            merchant_id_hashes: [[0; 32]; MAX_MERCHANTS],
            mcc_count: 0,
            mccs: [0; MAX_MCCS],
            expires_at: 0,
            recurring_allowed: false,
            fee_bps: 0,
            frozen: false,
            freeze_reason: 0,
            recovery_state: 0,
            statement_outstanding_cents: 0,
            exceptions_open: 0,
            member_count: 0,
            members: [Pubkey::default(); MAX_MEMBERS],
            member_flags: [0; MAX_MEMBERS],
            ledger_head: [0; 32],
            ledger_seq: 0,
            commit_seq: 0,
            bump: 255,
            recon_digest: [0; 32],
            repayment_digests: [[0; 32]; REPAYMENT_RING],
            repayment_count: 0,
            event_ids: [[0; 32]; EVENT_RING],
            event_count: 0,
            ephemeral_count: 0,
        };
        apply_policy_args(&mut p, &args());
        p
    }

    fn period() -> CardPeriod {
        CardPeriod {
            policy: Pubkey::new_from_array([2u8; 32]),
            period_index: 1,
            period_start: NOW - 10,
            period_end: NOW + 2_592_000,
            captured_cents: 0,
            reserved_cents: 0,
            refunded_cents: 0,
            purchases_count: 0,
            exception_cents: 0,
            bump: 255,
        }
    }

    fn intent() -> CheckoutIntent {
        CheckoutIntent {
            policy: Pubkey::new_from_array([3u8; 32]),
            intent_id: [4u8; 16],
            agent: Pubkey::new_from_array([5u8; 32]),
            merchant_id_hash: merchant(1),
            mcc: 0,
            max_amount_cents: 3_000,
            currency: USD,
            policy_version: 1,
            expires_at: NOW + 300,
            state: INTENT_OPEN,
            reservation: Pubkey::default(),
            bump: 255,
        }
    }

    fn auth(amount: u64) -> AuthorizeArgs {
        AuthorizeArgs {
            auth_id_hash: [6u8; 32],
            intent_id: [4u8; 16],
            amount_cents: amount,
            currency: USD,
            merchant_id_hash: merchant(1),
            mcc: 5734,
            merchant_initiated: false,
            single_message: false,
        }
    }

    fn err(r: Result<()>) -> Error {
        r.unwrap_err()
    }

    #[test]
    fn fee_is_integer_ceiling() {
        assert_eq!(fee(50_000, 50).unwrap(), 250); // $500 -> $2.50 (PLAN F example)
        assert_eq!(with_fee(50_000, 50).unwrap(), 50_250);
        assert_eq!(fee(1, 50).unwrap(), 1); // ceil(0.005)
        assert_eq!(fee(0, 50).unwrap(), 0);
        assert_eq!(fee(199, 50).unwrap(), 1);
        assert_eq!(fee(200, 50).unwrap(), 1);
        assert_eq!(fee(201, 50).unwrap(), 2);
        assert_eq!(fee(12_345, 0).unwrap(), 0);
        assert_eq!(fee(u64::MAX, 1_000).unwrap(), u64::MAX / 10 + 1);
    }

    #[test]
    fn available_never_goes_negative() {
        let p = policy();
        let mut per = period();
        per.captured_cents = 4_000;
        per.reserved_cents = 2_000;
        assert_eq!(available(&p, &per).unwrap(), 0);
        per.captured_cents = 1_000;
        per.reserved_cents = 1_500;
        assert_eq!(available(&p, &per).unwrap(), 2_500);
    }

    #[test]
    fn accepts_valid_policy_and_rejects_each_bad_field() {
        assert!(validate_policy_args(&args(), &owner(), NOW).is_ok());
        let cases: Vec<Box<dyn Fn(&mut PolicyArgs)>> = vec![
            Box::new(|a| a.max_purchase_cents = 0),
            Box::new(|a| a.max_purchase_cents = a.budget_cents + 1),
            Box::new(|a| {
                a.budget_cents = MAX_BUDGET_CENTS + 1;
                a.max_purchase_cents = 1
            }),
            Box::new(|a| a.period_seconds = MIN_PERIOD_SECONDS - 1),
            Box::new(|a| a.currency = *b"EUR"),
            Box::new(|a| a.fee_bps = MAX_FEE_BPS + 1),
            Box::new(|a| a.merchant_id_hashes = vec![]),
            Box::new(|a| a.merchant_id_hashes = vec![merchant(1), merchant(1)]),
            Box::new(|a| a.merchant_id_hashes = vec![[0u8; 32]]),
            Box::new(|a| a.mccs = vec![5734, 5734]),
            Box::new(|a| a.mccs = vec![0]),
            Box::new(|a| a.merchant_id_hashes = (1..=9).map(merchant).collect()),
            Box::new(|a| a.mccs = (1..=17).collect()),
            Box::new(|a| a.expires_at = NOW),
            Box::new(|a| a.authorizer = Pubkey::default()),
            Box::new(|a| a.authorizer = owner()),
        ];
        for (i, mutate) in cases.iter().enumerate() {
            let mut a = args();
            mutate(&mut a);
            assert_eq!(
                validate_policy_args(&a, &owner(), NOW).unwrap_err(),
                error!(CardPolicyError::InvalidPolicy),
                "case {i}"
            );
        }
        let mut mcc_only = args();
        mcc_only.merchant_id_hashes = vec![];
        mcc_only.mccs = vec![5734];
        assert!(validate_policy_args(&mcc_only, &owner(), NOW).is_ok());
    }

    #[test]
    fn authorize_approves_within_policy() {
        assert!(validate_authorize(&policy(), &period(), &intent(), &auth(2_000), NOW).is_ok());
    }

    #[test]
    fn authorize_rule_order_first_failure_wins() {
        // Frozen wins over everything else.
        let mut p = policy();
        p.frozen = true;
        let mut bad = auth(99_999);
        bad.merchant_id_hash = merchant(2);
        assert_eq!(
            err(validate_authorize(&p, &period(), &intent(), &bad, NOW)),
            error!(CardPolicyError::CardFrozen)
        );
        p.frozen = false;
        p.recovery_state = RECOVERY_FROZEN;
        assert_eq!(
            err(validate_authorize(&p, &period(), &intent(), &bad, NOW)),
            error!(CardPolicyError::RecoveryFrozen)
        );
        // Merchant mismatch before amount.
        assert_eq!(
            err(validate_authorize(
                &policy(),
                &period(),
                &intent(),
                &bad,
                NOW
            )),
            error!(CardPolicyError::MerchantMismatch)
        );
    }

    #[test]
    fn authorize_rejects_each_rule() {
        let p = policy();
        let per = period();
        let i = intent();

        let mut unset = policy();
        unset.authorizer = Pubkey::default();
        assert_eq!(
            err(validate_authorize(&unset, &per, &i, &auth(1), NOW)),
            error!(CardPolicyError::PolicyNotSet)
        );

        let mut expired = policy();
        expired.expires_at = NOW;
        assert_eq!(
            err(validate_authorize(&expired, &per, &i, &auth(1), NOW)),
            error!(CardPolicyError::PolicyExpired)
        );

        let mut consumed = intent();
        consumed.state = INTENT_CONSUMED;
        assert_eq!(
            err(validate_authorize(&p, &per, &consumed, &auth(1), NOW)),
            error!(CardPolicyError::IntentInvalid)
        );
        let mut wrong_id = auth(1);
        wrong_id.intent_id = [8u8; 16];
        assert_eq!(
            err(validate_authorize(&p, &per, &i, &wrong_id, NOW)),
            error!(CardPolicyError::IntentInvalid)
        );
        assert_eq!(
            err(validate_authorize(&p, &per, &i, &auth(1), NOW + 301)),
            error!(CardPolicyError::IntentExpired)
        );
        let mut stale = intent();
        stale.policy_version = 0;
        assert_eq!(
            err(validate_authorize(&p, &per, &stale, &auth(1), NOW)),
            error!(CardPolicyError::IntentStale)
        );

        // Intent bound to a merchant that the owner later removed.
        let mut removed = intent();
        removed.merchant_id_hash = merchant(2);
        let mut a = auth(1);
        a.merchant_id_hash = merchant(2);
        assert_eq!(
            err(validate_authorize(&p, &per, &removed, &a, NOW)),
            error!(CardPolicyError::MerchantNotAllowed)
        );

        let mut mcc_policy = policy();
        mcc_policy.mcc_count = 1;
        mcc_policy.mccs[0] = 5734;
        let mut a = auth(1);
        a.mcc = 7995;
        assert_eq!(
            err(validate_authorize(&mcc_policy, &per, &i, &a, NOW)),
            error!(CardPolicyError::MccNotAllowed)
        );
        let mut mcc_intent = intent();
        mcc_intent.mcc = 5734;
        let mut a = auth(1);
        a.mcc = 5999;
        assert_eq!(
            err(validate_authorize(&p, &per, &mcc_intent, &a, NOW)),
            error!(CardPolicyError::MccNotAllowed)
        );

        let mut eur = auth(1);
        eur.currency = *b"EUR";
        assert_eq!(
            err(validate_authorize(&p, &per, &i, &eur, NOW)),
            error!(CardPolicyError::CurrencyMismatch)
        );

        assert_eq!(
            err(validate_authorize(&p, &per, &i, &auth(0), NOW)),
            error!(CardPolicyError::InvalidAmount)
        );
        let mut small_intent = intent();
        small_intent.max_amount_cents = 500;
        assert_eq!(
            err(validate_authorize(&p, &per, &small_intent, &auth(501), NOW)),
            error!(CardPolicyError::AmountExceedsIntent)
        );
        let mut big_intent = intent();
        big_intent.max_amount_cents = 10_000;
        assert_eq!(
            err(validate_authorize(&p, &per, &big_intent, &auth(3_001), NOW)),
            error!(CardPolicyError::AmountExceedsMax)
        );

        let mut used = period();
        used.captured_cents = 2_000;
        used.reserved_cents = 1_000;
        assert_eq!(
            err(validate_authorize(&p, &used, &i, &auth(2_001), NOW)),
            error!(CardPolicyError::BudgetExceeded)
        );
        assert!(validate_authorize(&p, &used, &i, &auth(2_000), NOW).is_ok());

        let mut velocity = policy();
        velocity.max_purchases_per_period = 2;
        let mut counted = period();
        counted.purchases_count = 2;
        assert_eq!(
            err(validate_authorize(&velocity, &counted, &i, &auth(1), NOW)),
            error!(CardPolicyError::VelocityExceeded)
        );

        let mut recurring = auth(1);
        recurring.merchant_initiated = true;
        assert_eq!(
            err(validate_authorize(&p, &per, &i, &recurring, NOW)),
            error!(CardPolicyError::RecurringNotAllowed)
        );
        let mut allow = policy();
        allow.recurring_allowed = true;
        assert!(validate_authorize(&allow, &per, &i, &recurring, NOW).is_ok());
    }

    #[test]
    fn open_intent_rules() {
        let p = policy();
        let per = period();
        let base = IntentArgs {
            intent_id: [4u8; 16],
            agent: Pubkey::new_from_array([5u8; 32]),
            merchant_id_hash: merchant(1),
            mcc: 0,
            max_amount_cents: 2_000,
            currency: USD,
            expires_at: NOW + 600,
        };
        assert!(validate_open_intent(&p, &per, &base, NOW).is_ok());
        let mut a = base.clone();
        a.expires_at = NOW + 601;
        assert_eq!(
            err(validate_open_intent(&p, &per, &a, NOW)),
            error!(CardPolicyError::IntentInvalid)
        );
        let mut a = base.clone();
        a.merchant_id_hash = merchant(3);
        assert_eq!(
            err(validate_open_intent(&p, &per, &a, NOW)),
            error!(CardPolicyError::MerchantNotAllowed)
        );
        let mut a = base.clone();
        a.max_amount_cents = 3_001;
        assert_eq!(
            err(validate_open_intent(&p, &per, &a, NOW)),
            error!(CardPolicyError::AmountExceedsMax)
        );
        let mut used = period();
        used.reserved_cents = 4_000;
        assert_eq!(
            err(validate_open_intent(&p, &used, &base, NOW)),
            error!(CardPolicyError::BudgetExceeded)
        );
        let mut frozen = policy();
        frozen.frozen = true;
        assert_eq!(
            err(validate_open_intent(&frozen, &per, &base, NOW)),
            error!(CardPolicyError::CardFrozen)
        );
    }

    #[test]
    fn exposure_adds_fee_and_credit_is_capped() {
        let mut p = policy();
        add_exposure(&mut p, 2_000).unwrap(); // 2_000 + 10
        assert_eq!(p.statement_outstanding_cents, 2_010);
        reduce_exposure(&mut p, 500).unwrap(); // 500 + 3
        assert_eq!(p.statement_outstanding_cents, 1_507);
        reduce_exposure(&mut p, 10_000).unwrap();
        assert_eq!(p.statement_outstanding_cents, 0);
    }
}
