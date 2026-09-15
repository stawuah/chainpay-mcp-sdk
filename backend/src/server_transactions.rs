//! Complete supported instruction-set validation before any RPC submission.
use super::*;
use solana_address::Address;
use std::str::FromStr;

fn bad(message: &str) -> ApiError {
    ApiError::BadRequest(message.into())
}
fn key(tx: &VersionedTransaction, index: u8) -> Result<String, ApiError> {
    tx.message
        .static_account_keys()
        .get(index as usize)
        .map(ToString::to_string)
        .ok_or_else(|| bad("Unresolved transaction account"))
}
fn writable(tx: &VersionedTransaction, index: usize) -> bool {
    let h = tx.message.header();
    let signers = usize::from(h.num_required_signatures);
    if index < signers {
        index < signers - usize::from(h.num_readonly_signed_accounts)
    } else {
        index
            < tx.message.static_account_keys().len() - usize::from(h.num_readonly_unsigned_accounts)
    }
}
fn role(tx: &VersionedTransaction, index: u8, write: bool, signer: bool) -> Result<(), ApiError> {
    if writable(tx, index as usize) != write
        || ((index as usize) < tx.message.header().num_required_signatures as usize) != signer
    {
        return Err(bad("Unexpected account signer or writable role"));
    }
    Ok(())
}
fn pda(program: &str, seeds: &[&[u8]]) -> Result<String, ApiError> {
    let program = Address::from_str(program).map_err(|_| bad("Invalid program"))?;
    Ok(Address::find_program_address(seeds, &program).0.to_string())
}
fn address_bytes(value: &str) -> Result<Vec<u8>, ApiError> {
    bs58::decode(value)
        .into_vec()
        .map_err(|_| bad("Invalid address"))
}

pub(super) fn future_mandate(
    program: &str,
    wallet: &str,
    mint: &str,
    nonce: &str,
) -> Result<String, ApiError> {
    validate_solana_address(mint, "mint")?;
    validate_solana_address(nonce, "mandate_nonce")?;
    let nonce = address_bytes(nonce)?;
    if !nonce.starts_with(b"CPNONCE!") {
        return Err(bad("Invalid mandate nonce prefix"));
    }
    pda(
        program,
        &[
            b"mandate",
            &address_bytes(wallet)?,
            &address_bytes(mint)?,
            &nonce,
        ],
    )
}

pub(super) fn common(tx: &VersionedTransaction) -> Result<(), ApiError> {
    tx.sanitize()
        .map_err(|_| bad("Invalid transaction structure"))?;
    if tx.message.header().num_required_signatures != 1
        || tx.message.header().num_readonly_signed_accounts != 0
    {
        return Err(bad("Exactly one writable signer and fee payer is required"));
    }
    if let solana_transaction::VersionedMessage::V1(message) = &tx.message {
        let c = &message.config;
        if !c
            .compute_unit_limit
            .is_some_and(|v| v > 0 && v <= 1_400_000)
            || !c
                .loaded_accounts_data_size_limit
                .is_some_and(|v| v > 0 && v <= 64 * 1024 * 1024)
            || c.priority_fee.is_some_and(|v| v > 100_000)
            || c.heap_size
                .is_some_and(|v| !(32_768..=262_144).contains(&v) || v % 1024 != 0)
        {
            return Err(bad(
                "V1 requires explicit bounded compute/data limits and a bounded priority fee",
            ));
        }
    }
    let keys = tx.message.static_account_keys();
    if keys.len() > 64 || keys.iter().enumerate().any(|(i, k)| keys[..i].contains(k)) {
        return Err(bad("Duplicate or excessive account keys"));
    }
    if tx
        .message
        .address_table_lookups()
        .is_some_and(|a| !a.is_empty())
    {
        return Err(bad(
            "Address-table transactions require resolved accounts and are not supported",
        ));
    }
    if tx.message.instructions().is_empty() || tx.message.instructions().len() > 32 {
        return Err(bad("Unexpected instruction count"));
    }
    let mut referenced = std::collections::HashSet::new();
    for ix in tx.message.instructions() {
        referenced.insert(ix.program_id_index);
        referenced.extend(ix.accounts.iter().copied());
    }
    if referenced.len() != keys.len() {
        return Err(bad("Unused or unresolved transaction account"));
    }
    Ok(())
}

pub(super) fn payment(
    tx: &VersionedTransaction,
    request: &PaymentSubmissionRequest,
    program: &str,
) -> Result<(), ApiError> {
    common(tx)?;
    // The shipped payment builder emits exactly one execute_payment. No auxiliary
    // transfer, approval, memo, or compute instruction is needed for this flow.
    if tx.message.instructions().len() != 1 || tx.message.static_account_keys().len() != 11 {
        return Err(bad(
            "Payments require exactly one execute_payment instruction",
        ));
    }
    payment_at(tx, request, program, 0)
}

fn payment_at(
    tx: &VersionedTransaction,
    request: &PaymentSubmissionRequest,
    program: &str,
    position: usize,
) -> Result<(), ApiError> {
    let ix = &tx.message.instructions()[position];
    if key(tx, ix.program_id_index)? != program
        || ix.data.len() != 112
        || ix.data[..8] != [86, 4, 7, 7, 120, 139, 232, 139]
        || ix.accounts.len() != 10
    {
        return Err(bad("Unsupported payment instruction or accounts"));
    }
    let a = ix
        .accounts
        .iter()
        .map(|i| key(tx, *i))
        .collect::<Result<Vec<_>, _>>()?;
    let amount = u64::from_le_bytes(ix.data[104..112].try_into().unwrap());
    if a[2] != request.mandate
        || Some(a[3].as_str()) != request.receipt_address.as_deref()
        || a[7] != request.recipient
        || request.agent.as_deref().is_some_and(|v| v != a[4])
        || request.mint.as_deref().is_some_and(|v| v != a[5])
        || request.amount.is_some_and(|v| v != amount)
        || amount == 0
    {
        return Err(bad("Payment fields differ from the signed instruction"));
    }
    if a[4] != key(tx, 0)? || ix.accounts[4] != 0 {
        return Err(bad("Approved agent must be the signer and fee payer"));
    }
    if hex_encode(&ix.data[8..40])
        != request
            .invoice_hash
            .trim()
            .trim_start_matches("0x")
            .to_ascii_lowercase()
    {
        return Err(bad("Invoice differs from signed instruction"));
    }
    if a[0] != pda(program, &[b"config"])?
        || a[1] != pda(program, &[b"asset", &address_bytes(&a[5])?])?
        || a[3]
            != pda(
                program,
                &[b"receipt", &address_bytes(&a[2])?, &ix.data[8..40]],
            )?
    {
        return Err(bad("Invalid config, asset, or receipt PDA"));
    }
    if ![SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].contains(&a[8].as_str())
        || a[9] != "11111111111111111111111111111111"
    {
        return Err(bad("Invalid token or system program"));
    }
    if let Some(token) = &request.token_program {
        let expected = if token == "spl-token" {
            SPL_TOKEN_PROGRAM_ID
        } else if token == "token-2022" {
            TOKEN_2022_PROGRAM_ID
        } else {
            return Err(bad("Unknown token program"));
        };
        if a[8] != expected {
            return Err(bad("Token program mismatch"));
        }
    }
    for (position, index) in ix.accounts.iter().enumerate() {
        role(
            tx,
            *index,
            matches!(position, 2 | 3 | 4 | 6 | 7),
            position == 4,
        )?;
    }
    role(tx, ix.program_id_index, false, false)?;
    if a.iter().enumerate().any(|(i, k)| a[..i].contains(k)) {
        return Err(bad("Payment accounts must be distinct"));
    }
    Ok(())
}

pub(super) fn batch_payment_requests(
    tx: &VersionedTransaction,
    program: &str,
) -> Result<Vec<PaymentSubmissionRequest>, ApiError> {
    if tx.message.instructions().len() > 4 {
        return Err(bad("Payment batches are limited to four instructions"));
    }
    let mut requests = Vec::new();
    for (position, ix) in tx.message.instructions().iter().enumerate() {
        if ix.accounts.len() != 10 || ix.data.len() != 112 {
            return Err(bad("Invalid batch payment instruction"));
        }
        let request = PaymentSubmissionRequest {
            idempotency_key: format!("batch:{position}"),
            mandate: key(tx, ix.accounts[2])?,
            invoice_hash: hex_encode(&ix.data[8..40]),
            receipt_address: Some(key(tx, ix.accounts[3])?),
            signed_transaction: String::new(),
            agent: Some(key(tx, ix.accounts[4])?),
            mint: Some(key(tx, ix.accounts[5])?),
            recipient: key(tx, ix.accounts[7])?,
            amount: Some(u64::from_le_bytes(ix.data[104..112].try_into().unwrap())),
            token_program: Some(
                if key(tx, ix.accounts[8])? == SPL_TOKEN_PROGRAM_ID {
                    "spl-token"
                } else {
                    "token-2022"
                }
                .into(),
            ),
            x402: None,
        };
        payment_at(tx, &request, program, position)?;
        if requests.iter().any(|prior: &PaymentSubmissionRequest| {
            prior.receipt_address == request.receipt_address
        }) {
            return Err(bad("Duplicate batch receipt"));
        }
        requests.push(request);
    }
    Ok(requests)
}

pub(super) fn owner(
    tx: &VersionedTransaction,
    wallet: &str,
    program: &str,
) -> Result<(), ApiError> {
    common(tx)?;
    if key(tx, 0)? != wallet {
        return Err(bad("Owner must sign and pay transaction fees"));
    }
    let instructions = tx.message.instructions();
    let ix = &instructions[0];
    if key(tx, ix.program_id_index)? == program
        && ix.data.starts_with(&[86, 4, 7, 7, 120, 139, 232, 139])
    {
        batch_payment_requests(tx, program)?;
        return Ok(());
    }
    if key(tx, ix.program_id_index)? == program && ix.data == [252, 97, 140, 119, 67, 43, 177, 108]
    {
        let mut mandates = std::collections::HashSet::new();
        for ix in instructions {
            if key(tx, ix.program_id_index)? != program
                || ix.data != [252, 97, 140, 119, 67, 43, 177, 108]
                || ix.accounts.len() != 2
                || key(tx, ix.accounts[1])? != wallet
            {
                return Err(bad("Revoke-all may contain only owner mandate revocations"));
            }
            role(tx, ix.program_id_index, false, false)?;
            role(tx, ix.accounts[0], true, false)?;
            role(tx, ix.accounts[1], true, true)?;
            if !mandates.insert(ix.accounts[0]) {
                return Err(bad("Duplicate mandate revocation"));
            }
        }
        if tx.message.static_account_keys().len() != mandates.len() + 2 {
            return Err(bad("Unexpected revoke-all account"));
        }
        return Ok(());
    }
    if key(tx, ix.program_id_index)? == "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" {
        if instructions.len() != 1
            || !ix.data.is_empty()
            || ix.accounts.len() != 6
            || tx.message.static_account_keys().len() != 6
        {
            return Err(bad(
                "Only the owner token-account setup instruction is supported",
            ));
        }
        let a = ix
            .accounts
            .iter()
            .map(|i| key(tx, *i))
            .collect::<Result<Vec<_>, _>>()?;
        if a[0] != wallet
            || a[2] != wallet
            || a[4] != "11111111111111111111111111111111"
            || ![SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].contains(&a[5].as_str())
            || a[1]
                != pda(
                    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
                    &[
                        &address_bytes(wallet)?,
                        &address_bytes(&a[5])?,
                        &address_bytes(&a[3])?,
                    ],
                )?
        {
            return Err(bad(
                "Token account must be the connected owner's canonical ATA",
            ));
        }
        for (position, index) in ix.accounts.iter().enumerate() {
            role(
                tx,
                *index,
                matches!(position, 0 | 1 | 2),
                matches!(position, 0 | 2),
            )?;
        }
        role(tx, ix.program_id_index, false, false)?;
        return Ok(());
    }
    if key(tx, ix.program_id_index)? != program || ix.data.len() < 8 {
        return Err(bad("Relay accepts only supported ChainPay owner actions"));
    }
    role(tx, ix.program_id_index, false, false)?;
    let a = ix
        .accounts
        .iter()
        .map(|i| key(tx, *i))
        .collect::<Result<Vec<_>, _>>()?;
    match &ix.data[..8] {
        [230, 170, 158, 68, 33, 169, 16, 158] => {
            if tx.message.static_account_keys().len() != 9
                || ix.data.len() != 176
                || a.len() != 8
                || a[3] != wallet
                || a[0] != pda(program, &[b"config"])?
                || a[1] != pda(program, &[b"asset", &address_bytes(&a[4])?])?
                || a[7] != "11111111111111111111111111111111"
                || ![SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].contains(&a[6].as_str())
            {
                return Err(bad("Invalid create_mandate accounts"));
            }
            if address_bytes(&a[5])? != ix.data[40..72] || address_bytes(&a[4])? != ix.data[72..104]
            {
                return Err(bad("Create mandate source/mint mismatch"));
            }
            if a[2]
                != pda(
                    program,
                    &[
                        b"mandate",
                        &address_bytes(wallet)?,
                        &address_bytes(&a[4])?,
                        &ix.data[144..176],
                    ],
                )?
            {
                return Err(bad("Invalid mandate PDA"));
            }
            // ApproveChecked is the only auxiliary needed by the existing create flow.
            if instructions.len() != 2 {
                return Err(bad(
                    "Create mandate must include its exact delegate approval",
                ));
            }
            let approve = &instructions[1];
            if key(tx, approve.program_id_index)? != a[6]
                || approve.accounts.len() != 4
                || approve.data.len() != 10
                || approve.data[0] != 13
            {
                return Err(bad("Unexpected delegate approval"));
            }
            let aa = approve
                .accounts
                .iter()
                .map(|i| key(tx, *i))
                .collect::<Result<Vec<_>, _>>()?;
            if aa != vec![a[5].clone(), a[4].clone(), a[2].clone(), wallet.into()] {
                return Err(bad(
                    "Delegate approval must match created mandate, owner, source and mint",
                ));
            }
            for (position, index) in ix.accounts.iter().enumerate() {
                role(tx, *index, matches!(position, 2 | 3 | 5), position == 3)?;
            }
        }
        [192, 108, 97, 124, 56, 229, 236, 3]
        | [252, 97, 140, 119, 67, 43, 177, 108]
        | [69, 131, 248, 29, 105, 50, 139, 30] => {
            let expected = if ix.data[..8] == [69, 131, 248, 29, 105, 50, 139, 30] {
                81
            } else {
                8
            };
            if tx.message.static_account_keys().len() != 3
                || ix.data.len() != expected
                || a.len() != 2
                || a[1] != wallet
                || instructions.len() != 1
            {
                return Err(bad("Invalid mandate management transaction"));
            }
            role(tx, ix.accounts[0], true, false)?;
            role(tx, ix.accounts[1], true, true)?; // Owner is also fee payer.
        }
        _ => return Err(bad("Unsupported ChainPay owner action")),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use solana_message::{
        Message, MessageHeader, VersionedMessage, compiled_instruction::CompiledInstruction, v0, v1,
    };

    fn fixture(version: u8) -> (VersionedTransaction, PaymentSubmissionRequest, SigningKey) {
        let mut seed = [0; 32];
        getrandom::fill(&mut seed).unwrap();
        let signer = SigningKey::from_bytes(&seed);
        let agent = bs58::encode(signer.verifying_key().to_bytes()).into_string();
        let mint = bs58::encode([5; 32]).into_string();
        let mandate = bs58::encode([2; 32]).into_string();
        let receipt = pda(
            DEFAULT_PROGRAM_ID,
            &[b"receipt", &address_bytes(&mandate).unwrap(), &[1; 32]],
        )
        .unwrap();
        let keys = [
            agent.clone(),
            mandate.clone(),
            receipt.clone(),
            bs58::encode([6; 32]).into_string(),
            bs58::encode([7; 32]).into_string(),
            pda(DEFAULT_PROGRAM_ID, &[b"config"]).unwrap(),
            pda(DEFAULT_PROGRAM_ID, &[b"asset", &[5; 32]]).unwrap(),
            mint.clone(),
            SPL_TOKEN_PROGRAM_ID.into(),
            "11111111111111111111111111111111".into(),
            DEFAULT_PROGRAM_ID.into(),
        ]
        .map(|s| Address::from_str(&s).unwrap())
        .to_vec();
        let mut data = vec![86, 4, 7, 7, 120, 139, 232, 139];
        data.extend_from_slice(&[1; 32]);
        data.extend_from_slice(&[2; 32]);
        data.extend_from_slice(&[3; 32]);
        data.extend_from_slice(&10u64.to_le_bytes());
        let instructions = vec![CompiledInstruction {
            program_id_index: 10,
            accounts: vec![5, 6, 1, 2, 0, 7, 3, 4, 8, 9],
            data,
        }];
        let header = MessageHeader {
            num_required_signatures: 1,
            num_readonly_signed_accounts: 0,
            num_readonly_unsigned_accounts: 6,
        };
        let message = match version {
            0 => VersionedMessage::Legacy(Message {
                header,
                account_keys: keys,
                recent_blockhash: Default::default(),
                instructions,
            }),
            1 => VersionedMessage::V0(v0::Message {
                header,
                account_keys: keys,
                recent_blockhash: Default::default(),
                instructions,
                address_table_lookups: vec![],
            }),
            _ => VersionedMessage::V1(v1::Message {
                header,
                account_keys: keys,
                lifetime_specifier: Default::default(),
                instructions,
                config: v1::TransactionConfig::empty()
                    .with_compute_unit_limit(200_000)
                    .with_loaded_accounts_data_size_limit(1_000_000),
            }),
        };
        let signatures = vec![signer.sign(&message.serialize()).to_bytes().into()];
        let tx = VersionedTransaction {
            message,
            signatures,
        };
        let request = PaymentSubmissionRequest {
            idempotency_key: "fixture".into(),
            mandate,
            invoice_hash: "01".repeat(32),
            receipt_address: Some(receipt),
            signed_transaction: BASE64.encode(wincode::serialize(&tx).unwrap()),
            agent: Some(agent),
            mint: Some(mint),
            recipient: bs58::encode([7; 32]).into_string(),
            amount: Some(10),
            token_program: Some("spl-token".into()),
            x402: None,
        };
        (tx, request, signer)
    }

    #[test]
    fn official_codecs_accept_signed_legacy_v0_and_v1_payment_fixtures() {
        for version in 0..3 {
            let (tx, request, _) = fixture(version);
            let wire = wincode::serialize(&tx).unwrap();
            validate_payment_request(&request, DEFAULT_PROGRAM_ID).unwrap();
            assert_eq!(decode_solana_transaction(&wire, "fixture").unwrap(), tx);
            let mut trailing = wire.clone();
            trailing.push(0);
            assert!(decode_solana_transaction(&trailing, "fixture").is_err());
            assert!(decode_solana_transaction(&wire[..wire.len() - 1], "fixture").is_err());
        }
    }

    #[test]
    fn rejects_appended_instruction_and_invalid_account_roles() {
        let (mut tx, request, _) = fixture(0);
        if let VersionedMessage::Legacy(m) = &mut tx.message {
            m.instructions.push(m.instructions[0].clone());
        }
        assert!(payment(&tx, &request, DEFAULT_PROGRAM_ID).is_err());
        let (mut tx, request, _) = fixture(0);
        if let VersionedMessage::Legacy(m) = &mut tx.message {
            m.instructions[0].accounts[6] = 4;
        }
        assert!(payment(&tx, &request, DEFAULT_PROGRAM_ID).is_err());
        let (mut tx, request, _) = fixture(0);
        if let VersionedMessage::Legacy(m) = &mut tx.message {
            m.header.num_readonly_unsigned_accounts = 7;
        }
        assert!(payment(&tx, &request, DEFAULT_PROGRAM_ID).is_err());
    }

    #[test]
    fn v1_config_and_provider_message_are_checked() {
        let (mut tx, request, signer) = fixture(2);
        let original = request.signed_transaction.clone();
        if let VersionedMessage::V1(m) = &mut tx.message {
            m.config.priority_fee = Some(100_001);
        }
        assert!(payment(&tx, &request, DEFAULT_PROGRAM_ID).is_err());
        if let VersionedMessage::V1(m) = &mut tx.message {
            m.config.priority_fee = Some(1);
        }
        tx.signatures = vec![signer.sign(&tx.message.serialize()).to_bytes().into()];
        assert!(
            validate_provider_signed_transaction(
                &original,
                &BASE64.encode(wincode::serialize(&tx).unwrap()),
                &request,
                DEFAULT_PROGRAM_ID
            )
            .is_err()
        );
        assert!(decode_transaction(&BASE64.encode(vec![0; 4097])).is_err());
    }

    #[test]
    fn owner_setup_create_approval_and_management_remain_supported() {
        let (_, request, signer) = fixture(0);
        let wallet = request.agent.unwrap();
        let mint = bs58::encode([5; 32]).into_string();
        let source = bs58::encode([6; 32]).into_string();
        let mut nonce = [0; 32];
        nonce[..8].copy_from_slice(b"CPNONCE!");
        nonce[8] = 1;
        let mandate = future_mandate(
            DEFAULT_PROGRAM_ID,
            &wallet,
            &mint,
            &bs58::encode(nonce).into_string(),
        )
        .unwrap();
        assert_ne!(
            future_mandate(
                DEFAULT_PROGRAM_ID,
                &bs58::encode([8; 32]).into_string(),
                &mint,
                &bs58::encode(nonce).into_string()
            )
            .unwrap(),
            mandate
        );
        let config = pda(DEFAULT_PROGRAM_ID, &[b"config"]).unwrap();
        let asset = pda(DEFAULT_PROGRAM_ID, &[b"asset", &[5; 32]]).unwrap();
        let keys = [
            wallet.clone(),
            mandate.clone(),
            source.clone(),
            config,
            asset,
            mint.clone(),
            SPL_TOKEN_PROGRAM_ID.into(),
            "11111111111111111111111111111111".into(),
            DEFAULT_PROGRAM_ID.into(),
        ]
        .map(|s| Address::from_str(&s).unwrap())
        .to_vec();
        let mut data = vec![230, 170, 158, 68, 33, 169, 16, 158];
        data.extend_from_slice(&signer.verifying_key().to_bytes());
        data.extend_from_slice(&[6; 32]);
        data.extend_from_slice(&[5; 32]);
        for n in [10u64, 100, 1000, 0, 0] {
            data.extend_from_slice(&n.to_le_bytes());
        }
        data.extend_from_slice(&nonce);
        let mut approval = vec![13];
        approval.extend_from_slice(&100u64.to_le_bytes());
        approval.push(6);
        let message = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 6,
            },
            account_keys: keys,
            recent_blockhash: Default::default(),
            instructions: vec![
                CompiledInstruction {
                    program_id_index: 8,
                    accounts: vec![3, 4, 1, 0, 5, 2, 6, 7],
                    data,
                },
                CompiledInstruction {
                    program_id_index: 6,
                    accounts: vec![2, 5, 1, 0],
                    data: approval,
                },
            ],
        });
        let mut tx = VersionedTransaction {
            signatures: vec![signer.sign(&message.serialize()).to_bytes().into()],
            message,
        };
        owner(&tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();
        for allowance in [1u64, 50, 200] {
            if let VersionedMessage::Legacy(m) = &mut tx.message {
                m.instructions[1].data[1..9].copy_from_slice(&allowance.to_le_bytes());
            }
            owner(&tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();
        }
        if let VersionedMessage::Legacy(m) = &mut tx.message {
            m.instructions[1].accounts[2] = 0;
        }
        assert!(owner(&tx, &wallet, DEFAULT_PROGRAM_ID).is_err());
        for data in [
            vec![192, 108, 97, 124, 56, 229, 236, 3],
            vec![252, 97, 140, 119, 67, 43, 177, 108],
        ] {
            let message = VersionedMessage::Legacy(Message {
                header: MessageHeader {
                    num_required_signatures: 1,
                    num_readonly_signed_accounts: 0,
                    num_readonly_unsigned_accounts: 1,
                },
                account_keys: [wallet.clone(), mandate.clone(), DEFAULT_PROGRAM_ID.into()]
                    .map(|s| Address::from_str(&s).unwrap())
                    .to_vec(),
                recent_blockhash: Default::default(),
                instructions: vec![CompiledInstruction {
                    program_id_index: 2,
                    accounts: vec![1, 0],
                    data,
                }],
            });
            let tx = VersionedTransaction {
                signatures: vec![signer.sign(&message.serialize()).to_bytes().into()],
                message,
            };
            owner(&tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();
        }
        let ata_program = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
        let ata = pda(
            ata_program,
            &[
                &address_bytes(&wallet).unwrap(),
                &address_bytes(SPL_TOKEN_PROGRAM_ID).unwrap(),
                &[5; 32],
            ],
        )
        .unwrap();
        let message = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 4,
            },
            account_keys: [
                wallet.clone(),
                ata,
                mint,
                SPL_TOKEN_PROGRAM_ID.into(),
                "11111111111111111111111111111111".into(),
                ata_program.into(),
            ]
            .map(|s| Address::from_str(&s).unwrap())
            .to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 5,
                accounts: vec![0, 1, 0, 2, 4, 3],
                data: vec![],
            }],
        });
        let tx = VersionedTransaction {
            signatures: vec![signer.sign(&message.serialize()).to_bytes().into()],
            message,
        };
        owner(&tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();
    }

    #[test]
    fn atomic_payment_batch_validates_each_instruction() {
        let (mut tx, request, signer) = fixture(0);
        let next_receipt = pda(
            DEFAULT_PROGRAM_ID,
            &[
                b"receipt",
                &address_bytes(&request.mandate).unwrap(),
                &[2; 32],
            ],
        )
        .unwrap();
        if let VersionedMessage::Legacy(m) = &mut tx.message {
            m.account_keys
                .insert(5, Address::from_str(&next_receipt).unwrap());
            m.instructions[0].program_id_index += 1;
            for index in &mut m.instructions[0].accounts {
                if *index >= 5 {
                    *index += 1;
                }
            }
            let mut second = m.instructions[0].clone();
            second.accounts[3] = 5;
            second.data[8..40].copy_from_slice(&[2; 32]);
            m.instructions.push(second);
        }
        tx.signatures = vec![signer.sign(&tx.message.serialize()).to_bytes().into()];
        owner(&tx, request.agent.as_deref().unwrap(), DEFAULT_PROGRAM_ID).unwrap();
        assert_eq!(
            batch_payment_requests(&tx, DEFAULT_PROGRAM_ID)
                .unwrap()
                .len(),
            2
        );
        if let VersionedMessage::Legacy(m) = &mut tx.message {
            m.instructions[1].data[0] = 0;
        }
        assert!(owner(&tx, request.agent.as_deref().unwrap(), DEFAULT_PROGRAM_ID).is_err());
    }

    #[test]
    fn revoke_all_checks_every_management_instruction() {
        let (_, request, signer) = fixture(0);
        let wallet = request.agent.unwrap();
        let keys = [
            wallet.clone(),
            bs58::encode([2; 32]).into_string(),
            bs58::encode([3; 32]).into_string(),
            DEFAULT_PROGRAM_ID.into(),
        ]
        .map(|v| Address::from_str(&v).unwrap())
        .to_vec();
        let message = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 1,
            },
            account_keys: keys,
            recent_blockhash: Default::default(),
            instructions: vec![
                CompiledInstruction {
                    program_id_index: 3,
                    accounts: vec![1, 0],
                    data: vec![252, 97, 140, 119, 67, 43, 177, 108],
                },
                CompiledInstruction {
                    program_id_index: 3,
                    accounts: vec![2, 0],
                    data: vec![252, 97, 140, 119, 67, 43, 177, 108],
                },
            ],
        });
        let mut tx = VersionedTransaction {
            signatures: vec![signer.sign(&message.serialize()).to_bytes().into()],
            message,
        };
        owner(&tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();
        if let VersionedMessage::Legacy(m) = &mut tx.message {
            m.instructions[1].data[0] = 0;
        }
        assert!(owner(&tx, &wallet, DEFAULT_PROGRAM_ID).is_err());
    }

    #[test]
    fn official_v1_decoder_handles_4096_boundary_and_rejects_unknown_config() {
        let (mut tx, _, _) = fixture(2);
        let length = wincode::serialize(&tx).unwrap().len();
        if let VersionedMessage::V1(m) = &mut tx.message {
            m.instructions[0].data.resize(112 + 4096 - length, 0);
        }
        let wire = wincode::serialize(&tx).unwrap();
        assert_eq!(wire.len(), 4096);
        assert!(decode_solana_transaction(&wire, "fixture").is_ok());
        let mut invalid = wire;
        invalid[7] |= 0x80;
        assert!(decode_solana_transaction(&invalid, "fixture").is_err());
    }

    #[test]
    fn generic_relay_accepts_owner_payment_and_rejects_other_owner() {
        let (tx, request, _) = fixture(0);
        owner(&tx, request.agent.as_deref().unwrap(), DEFAULT_PROGRAM_ID).unwrap();
        assert!(
            owner(
                &tx,
                &bs58::encode([8; 32]).into_string(),
                DEFAULT_PROGRAM_ID
            )
            .is_err()
        );
    }
}
