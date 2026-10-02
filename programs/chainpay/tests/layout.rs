use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountSerialize, Discriminator};
use chainpay::state::{PaymentMandate, PaymentReceipt, ProtocolConfig, SupportedAsset};

#[test]
fn mandate_and_receipt_have_stable_layout_constants() {
    assert_eq!(PaymentMandate::LEN, 227);
    assert_eq!(PaymentReceipt::LEN, 363);
    assert_eq!(ProtocolConfig::LEN, 129);
    assert_eq!(SupportedAsset::LEN, 98);
}

#[test]
fn mandate_and_receipt_pd_as_use_the_documented_seeds() {
    let owner = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let mut nonce_bytes = [0u8; 32];
    nonce_bytes[..8].copy_from_slice(b"CPNONCE!");
    nonce_bytes[8] = 1;
    let mandate_nonce = Pubkey::new_from_array(nonce_bytes);
    let invoice_hash = [7u8; 32];

    let (legacy_mandate, _) =
        Pubkey::find_program_address(&[b"mandate", owner.as_ref()], &chainpay::id());
    let (mint_scoped_mandate, _) = Pubkey::find_program_address(
        &[b"mandate", owner.as_ref(), mint.as_ref()],
        &chainpay::id(),
    );
    let (mandate, _) = Pubkey::find_program_address(
        &[
            b"mandate",
            owner.as_ref(),
            mint.as_ref(),
            mandate_nonce.as_ref(),
        ],
        &chainpay::id(),
    );
    let (receipt, _) = Pubkey::find_program_address(
        &[b"receipt", mandate.as_ref(), invoice_hash.as_ref()],
        &chainpay::id(),
    );

    assert_ne!(legacy_mandate, mandate);
    assert_ne!(mint_scoped_mandate, mandate);
    assert_ne!(mandate, receipt);
    assert_ne!(mandate, Pubkey::default());
    assert_ne!(receipt, Pubkey::default());
}

fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

#[test]
fn receipt_policy_snapshot_is_appended_after_the_original_fields() {
    // Distinct values per field so a shifted offset cannot pass by accident.
    let receipt = PaymentReceipt {
        mandate: Pubkey::new_from_array([1u8; 32]),
        invoice_hash: [2u8; 32],
        payment_id: [3u8; 32],
        mint: Pubkey::new_from_array([4u8; 32]),
        source_token_account: Pubkey::new_from_array([5u8; 32]),
        recipient_token_account: Pubkey::new_from_array([6u8; 32]),
        amount: 0x0707_0707_0707_0707,
        agent: Pubkey::new_from_array([8u8; 32]),
        executed_at_slot: 0x0909_0909_0909_0909,
        signature_reference: [10u8; 32],
        status: 11,
        bump: 12,
        snapshot_version: 1,
        policy_max_per_payment: 101,
        policy_total_limit: 102,
        policy_amount_spent_after: 103,
        policy_payment_count_after: 104,
        policy_max_payment_count: 105,
        policy_expires_at_slot: 106,
        policy_cooldown_slots: 107,
        reserved: [0u8; 32],
    };
    let mut data = Vec::new();
    receipt.try_serialize(&mut data).unwrap();

    assert_eq!(data.len(), 8 + PaymentReceipt::LEN);
    assert_eq!(data.len(), 371);
    assert_eq!(&data[..8], PaymentReceipt::DISCRIMINATOR);

    // Original v1 offsets (account bytes, including the discriminator). These
    // must not move: older clients read receipts by these offsets.
    assert_eq!(&data[8..40], &[1u8; 32]);
    assert_eq!(&data[40..72], &[2u8; 32]);
    assert_eq!(&data[72..104], &[3u8; 32]);
    assert_eq!(&data[104..136], &[4u8; 32]);
    assert_eq!(&data[136..168], &[5u8; 32]);
    assert_eq!(&data[168..200], &[6u8; 32]);
    assert_eq!(read_u64(&data, 200), 0x0707_0707_0707_0707);
    assert_eq!(&data[208..240], &[8u8; 32]);
    assert_eq!(read_u64(&data, 240), 0x0909_0909_0909_0909);
    assert_eq!(&data[248..280], &[10u8; 32]);
    assert_eq!(data[280], 11);
    assert_eq!(data[281], 12);

    // Policy snapshot, appended after `bump`.
    assert_eq!(data[282], 1);
    assert_eq!(read_u64(&data, 283), 101);
    assert_eq!(read_u64(&data, 291), 102);
    assert_eq!(read_u64(&data, 299), 103);
    assert_eq!(read_u64(&data, 307), 104);
    assert_eq!(read_u64(&data, 315), 105);
    assert_eq!(read_u64(&data, 323), 106);
    assert_eq!(read_u64(&data, 331), 107);
    assert_eq!(&data[339..371], &[0u8; 32]);
}
