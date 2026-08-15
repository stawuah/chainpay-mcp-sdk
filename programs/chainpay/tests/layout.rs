use anchor_lang::prelude::Pubkey;
use chainpay::state::{PaymentMandate, PaymentReceipt, ProtocolConfig, SupportedAsset};

#[test]
fn mandate_and_receipt_have_stable_layout_constants() {
    assert_eq!(PaymentMandate::LEN, 227);
    assert_eq!(PaymentReceipt::LEN, 274);
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
