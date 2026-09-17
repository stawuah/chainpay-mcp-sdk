//! Complete supported instruction-set validation before any RPC submission.
use super::*;
use solana_address::Address;
use solana_message::compiled_instruction::CompiledInstruction;
use std::str::FromStr;

fn bad(message: &str) -> ApiError {
    ApiError::BadRequest(message.into())
}
pub(super) fn key(tx: &VersionedTransaction, index: u8) -> Result<String, ApiError> {
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

const INIT_CONFIG: [u8; 8] = [208, 127, 21, 1, 194, 190, 196, 70];
const REGISTER_ASSET: [u8; 8] = [21, 80, 155, 149, 117, 207, 235, 16];
const SET_ASSET_STATUS: [u8; 8] = [58, 54, 181, 102, 68, 238, 240, 245];
const CREATE_MANDATE: [u8; 8] = [230, 170, 158, 68, 33, 169, 16, 158];
const PAUSE_MANDATE: [u8; 8] = [192, 108, 97, 124, 56, 229, 236, 3];
const REVOKE_MANDATE: [u8; 8] = [252, 97, 140, 119, 67, 43, 177, 108];
const UPDATE_MANDATE: [u8; 8] = [69, 131, 248, 29, 105, 50, 139, 30];
const APPROVE_CHECKED: u8 = 13;
const REVOKE_DELEGATE: u8 = 5;
const ATA_PROGRAM: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM: &str = "11111111111111111111111111111111";
const COMPUTE_BUDGET_PROGRAM: &str = "ComputeBudget111111111111111111111111111111";
const REQUEST_HEAP_FRAME: u8 = 1;
const SET_COMPUTE_UNIT_LIMIT: u8 = 2;
const SET_COMPUTE_UNIT_PRICE: u8 = 3;
const SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT: u8 = 4;

/// The ChainPay instructions of a transaction, with compute-budget instructions
/// removed.
///
/// Wallets attach their own compute-budget instructions when they add a priority
/// fee, and they place them first. Every validator here addresses instructions by
/// position, so they must all see the same compute-budget-free view or an
/// injected instruction silently shifts what each position means. A V1 message
/// carries these limits in its message config instead, and `common` bounds them
/// there; this is the legacy-message equivalent.
///
/// Compute-budget instructions cannot touch accounts or move funds. `common`
/// checks that each one is well formed and bounded before anything reaches here.
fn payload_instructions(tx: &VersionedTransaction) -> Vec<&CompiledInstruction> {
    tx.message
        .instructions()
        .iter()
        .filter(|ix| !is_compute_budget(tx, ix.program_id_index))
        .collect()
}

fn is_compute_budget(tx: &VersionedTransaction, program_id_index: u8) -> bool {
    matches!(key(tx, program_id_index), Ok(program) if program == COMPUTE_BUDGET_PROGRAM)
}

/// Bound every compute-budget instruction the same way `common` bounds a V1
/// message config. An owner signs these in their own wallet, but the relay still
/// refuses to broadcast an unbounded priority fee charged to that owner.
fn validate_compute_budget(tx: &VersionedTransaction) -> Result<(), ApiError> {
    let mut seen = Vec::new();
    for ix in tx.message.instructions() {
        if !is_compute_budget(tx, ix.program_id_index) {
            continue;
        }
        if !ix.accounts.is_empty() || ix.data.is_empty() {
            return Err(bad("Malformed compute budget instruction"));
        }
        let selector = ix.data[0];
        if seen.contains(&selector) {
            return Err(bad("Duplicate compute budget instruction"));
        }
        seen.push(selector);
        let bounded = match selector {
            SET_COMPUTE_UNIT_LIMIT => {
                read_u32(&ix.data).is_some_and(|value| value > 0 && value <= 1_400_000)
            }
            SET_COMPUTE_UNIT_PRICE => read_u64(&ix.data).is_some_and(|value| value <= 100_000),
            SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT => {
                read_u32(&ix.data).is_some_and(|value| value > 0 && value <= 64 * 1024 * 1024)
            }
            REQUEST_HEAP_FRAME => read_u32(&ix.data)
                .is_some_and(|value| (32_768..=262_144).contains(&value) && value % 1024 == 0),
            _ => false,
        };
        if !bounded {
            return Err(bad(
                "Compute budget instructions require bounded compute, data and priority fee limits",
            ));
        }
    }
    Ok(())
}

fn read_u32(data: &[u8]) -> Option<u32> {
    if data.len() != 5 {
        return None;
    }
    Some(u32::from_le_bytes(data[1..5].try_into().ok()?))
}

fn read_u64(data: &[u8]) -> Option<u64> {
    if data.len() != 9 {
        return None;
    }
    Some(u64::from_le_bytes(data[1..9].try_into().ok()?))
}

fn discriminator(data: &[u8]) -> Option<[u8; 8]> {
    if data.len() < 8 {
        return None;
    }
    data[..8].try_into().ok()
}

fn token_program(value: &str) -> Result<(), ApiError> {
    if ![SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].contains(&value) {
        return Err(bad("Invalid token program"));
    }
    Ok(())
}

fn validate_approve_checked(
    tx: &VersionedTransaction,
    position: usize,
    wallet: &str,
    mandate: &str,
    source: &str,
    mint: &str,
) -> Result<(), ApiError> {
    let ix = &payload_instructions(tx)[position];
    token_program(&key(tx, ix.program_id_index)?)?;
    if ix.accounts.len() != 4 || ix.data.len() != 10 || ix.data[0] != APPROVE_CHECKED {
        return Err(bad("Unexpected delegate approval"));
    }
    let accounts = ix
        .accounts
        .iter()
        .map(|index| key(tx, *index))
        .collect::<Result<Vec<_>, _>>()?;
    if accounts != [source, mint, mandate, wallet] {
        return Err(bad(
            "Delegate approval must match mandate, owner, source and mint",
        ));
    }
    if ix.accounts[3] as usize >= tx.message.header().num_required_signatures as usize {
        return Err(bad("Delegate approval owner must sign"));
    }
    role(tx, ix.program_id_index, false, false)?;
    Ok(())
}

fn validate_ata_creation(
    tx: &VersionedTransaction,
    wallet: &str,
    owner_must_be_wallet: bool,
) -> Result<(), ApiError> {
    let ix = &payload_instructions(tx)[0];
    if payload_instructions(tx).len() != 1 || !ix.data.is_empty() || ix.accounts.len() != 6 {
        return Err(bad("Only standalone associated-token setup is supported"));
    }
    let accounts = ix
        .accounts
        .iter()
        .map(|index| key(tx, *index))
        .collect::<Result<Vec<_>, _>>()?;
    if accounts[0] != wallet
        || accounts[4] != SYSTEM_PROGRAM
        || key(tx, ix.program_id_index)? != ATA_PROGRAM
    {
        return Err(bad(
            "Associated token account payer must be the owner wallet",
        ));
    }
    token_program(&accounts[5])?;
    if owner_must_be_wallet && accounts[2] != wallet {
        return Err(bad(
            "Token account must be the connected owner's canonical ATA",
        ));
    }
    if accounts[1]
        != pda(
            ATA_PROGRAM,
            &[
                &address_bytes(&accounts[2])?,
                &address_bytes(&accounts[5])?,
                &address_bytes(&accounts[3])?,
            ],
        )?
    {
        return Err(bad("Associated token account address mismatch"));
    }
    if owner_must_be_wallet {
        for (position, index) in ix.accounts.iter().enumerate() {
            role(
                tx,
                *index,
                matches!(position, 0 | 1 | 2),
                matches!(position, 0 | 2),
            )?;
        }
    } else {
        role(tx, ix.accounts[0], true, true)?;
        role(tx, ix.accounts[1], true, false)?;
    }
    role(tx, ix.program_id_index, false, false)?;
    Ok(())
}

fn validate_delegate_repair(tx: &VersionedTransaction, wallet: &str) -> Result<(), ApiError> {
    if payload_instructions(tx).len() != 1 {
        return Err(bad("Delegate repair must be a single approval instruction"));
    }
    let accounts = payload_instructions(tx)[0]
        .accounts
        .iter()
        .map(|index| key(tx, *index))
        .collect::<Result<Vec<_>, _>>()?;
    // The account count must be checked here, not only inside validate_approve_checked:
    // the indexes below are evaluated as its arguments, so a short list panics first.
    if accounts.len() != 4 {
        return Err(bad("Unexpected delegate approval"));
    }
    validate_approve_checked(tx, 0, wallet, &accounts[2], &accounts[0], &accounts[1])?;
    Ok(())
}

fn validate_delegate_removal(tx: &VersionedTransaction, wallet: &str) -> Result<(), ApiError> {
    let ix = &payload_instructions(tx)[0];
    if payload_instructions(tx).len() != 1
        || ix.data.len() != 1
        || ix.data[0] != REVOKE_DELEGATE
        || ix.accounts.len() != 2
        || tx.message.static_account_keys().len() != 3
    {
        return Err(bad(
            "Delegate removal must be a standalone revoke instruction",
        ));
    }
    token_program(&key(tx, ix.program_id_index)?)?;
    let accounts = ix
        .accounts
        .iter()
        .map(|index| key(tx, *index))
        .collect::<Result<Vec<_>, _>>()?;
    if accounts[1] != wallet {
        return Err(bad(
            "Delegate removal must be signed by the token account owner",
        ));
    }
    if ix.accounts[1] as usize >= tx.message.header().num_required_signatures as usize {
        return Err(bad("Delegate removal owner must sign"));
    }
    role(tx, ix.program_id_index, false, false)?;
    Ok(())
}

fn validate_initialize_config(
    tx: &VersionedTransaction,
    wallet: &str,
    program: &str,
) -> Result<(), ApiError> {
    let ix = &payload_instructions(tx)[0];
    if payload_instructions(tx).len() != 1
        || ix.data.len() != 104
        || ix.accounts.len() != 3
        || tx.message.static_account_keys().len() != 4
    {
        return Err(bad("Invalid protocol initialization transaction"));
    }
    let accounts = ix
        .accounts
        .iter()
        .map(|index| key(tx, *index))
        .collect::<Result<Vec<_>, _>>()?;
    if accounts[0] != pda(program, &[b"config"])?
        || accounts[1] != wallet
        || accounts[2] != SYSTEM_PROGRAM
    {
        return Err(bad("Invalid protocol initialization accounts"));
    }
    if ix.accounts[1] as usize >= tx.message.header().num_required_signatures as usize {
        return Err(bad("Protocol initialization authority must sign"));
    }
    role(tx, ix.program_id_index, false, false)?;
    Ok(())
}

fn validate_register_asset(
    tx: &VersionedTransaction,
    wallet: &str,
    program: &str,
) -> Result<(), ApiError> {
    let ix = &payload_instructions(tx)[0];
    if payload_instructions(tx).len() != 1
        || ix.data.len() != 40
        || ix.accounts.len() != 6
        || tx.message.static_account_keys().len() != 7
    {
        return Err(bad("Invalid asset registration transaction"));
    }
    let accounts = ix
        .accounts
        .iter()
        .map(|index| key(tx, *index))
        .collect::<Result<Vec<_>, _>>()?;
    let mint = bs58::encode(&ix.data[8..40]).into_string();
    token_program(&accounts[4])?;
    if accounts[0] != pda(program, &[b"config"])?
        || accounts[1] != pda(program, &[b"asset", &ix.data[8..40]])?
        || accounts[2] != wallet
        || accounts[3] != mint
        || accounts[5] != SYSTEM_PROGRAM
    {
        return Err(bad("Invalid asset registration accounts"));
    }
    if ix.accounts[2] as usize >= tx.message.header().num_required_signatures as usize {
        return Err(bad("Asset registration authority must sign"));
    }
    role(tx, ix.program_id_index, false, false)?;
    Ok(())
}

fn validate_set_asset_status(
    tx: &VersionedTransaction,
    wallet: &str,
    program: &str,
) -> Result<(), ApiError> {
    let ix = &payload_instructions(tx)[0];
    if payload_instructions(tx).len() != 1
        || ix.data.len() != 9
        || ix.accounts.len() != 3
        || tx.message.static_account_keys().len() != 4
        || ix.data[8] > 1
    {
        return Err(bad("Invalid asset status transaction"));
    }
    let accounts = ix
        .accounts
        .iter()
        .map(|index| key(tx, *index))
        .collect::<Result<Vec<_>, _>>()?;
    if accounts[0] != pda(program, &[b"config"])? || accounts[2] != wallet {
        return Err(bad("Invalid asset status accounts"));
    }
    if ix.accounts[2] as usize >= tx.message.header().num_required_signatures as usize {
        return Err(bad("Asset status authority must sign"));
    }
    role(tx, ix.program_id_index, false, false)?;
    Ok(())
}

fn validate_management_instruction(
    tx: &VersionedTransaction,
    position: usize,
    wallet: &str,
) -> Result<(), ApiError> {
    let ix = &payload_instructions(tx)[position];
    let expected = if ix.data[..8] == UPDATE_MANDATE {
        81
    } else {
        8
    };
    if ix.data.len() != expected || ix.accounts.len() != 2 {
        return Err(bad("Invalid mandate management transaction"));
    }
    let accounts = ix
        .accounts
        .iter()
        .map(|index| key(tx, *index))
        .collect::<Result<Vec<_>, _>>()?;
    if accounts[1] != wallet {
        return Err(bad("Invalid mandate management transaction"));
    }
    role(tx, ix.accounts[0], true, false)?;
    role(tx, ix.accounts[1], true, true)?;
    Ok(())
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
    if tx.message.instructions().len() > 32 {
        return Err(bad("Unexpected instruction count"));
    }
    // Every validator below indexes the compute-budget-free view, so that view is
    // what must be non-empty. A transaction carrying nothing but compute-budget
    // instructions would otherwise index past the end of it.
    if payload_instructions(tx).is_empty() {
        return Err(bad("Unexpected instruction count"));
    }
    validate_compute_budget(tx)?;
    // The compute-budget program is referenced by its own instructions, so the
    // full instruction list is what accounts for every static key.
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
    if payload_instructions(tx).len() != 1 || tx.message.static_account_keys().len() != 11 {
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
    let ix = &payload_instructions(tx)[position];
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
    if payload_instructions(tx).len() > 4 {
        return Err(bad("Payment batches are limited to four instructions"));
    }
    let mut requests = Vec::new();
    for (position, ix) in payload_instructions(tx).iter().enumerate() {
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
    let instructions = payload_instructions(tx);
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
    if key(tx, ix.program_id_index)? == ATA_PROGRAM {
        let owner_is_wallet = ix
            .accounts
            .get(2)
            .is_some_and(|index| key(tx, *index).is_ok_and(|owner| owner == wallet));
        return validate_ata_creation(tx, wallet, owner_is_wallet);
    }
    if [SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]
        .contains(&key(tx, ix.program_id_index)?.as_str())
    {
        if ix.data.len() == 1 && ix.data[0] == REVOKE_DELEGATE {
            return validate_delegate_removal(tx, wallet);
        }
        if ix.data.len() == 10 && ix.data[0] == APPROVE_CHECKED {
            return validate_delegate_repair(tx, wallet);
        }
        return Err(bad("Relay accepts only supported token delegate actions"));
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
    match discriminator(&ix.data) {
        Some(INIT_CONFIG) => validate_initialize_config(tx, wallet, program),
        Some(REGISTER_ASSET) => validate_register_asset(tx, wallet, program),
        Some(SET_ASSET_STATUS) => validate_set_asset_status(tx, wallet, program),
        Some(CREATE_MANDATE) => {
            if tx.message.static_account_keys().len() != 9
                || ix.data.len() != 176
                || a.len() != 8
                || a[3] != wallet
                || a[0] != pda(program, &[b"config"])?
                || a[1] != pda(program, &[b"asset", &address_bytes(&a[4])?])?
                || a[7] != SYSTEM_PROGRAM
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
            if instructions.len() != 2 {
                return Err(bad(
                    "Create mandate must include its exact delegate approval",
                ));
            }
            if key(tx, instructions[1].program_id_index)? != a[6] {
                return Err(bad("Unexpected delegate approval"));
            }
            validate_approve_checked(tx, 1, wallet, &a[2], &a[5], &a[4])?;
            for (position, index) in ix.accounts.iter().enumerate() {
                role(tx, *index, matches!(position, 2 | 3 | 5), position == 3)?;
            }
            Ok(())
        }
        Some(UPDATE_MANDATE) => {
            validate_management_instruction(tx, 0, wallet)?;
            if instructions.len() == 2 {
                // Checked here because the indexes below are evaluated as arguments to
                // validate_approve_checked, ahead of its own account-count guard.
                if instructions[1].accounts.len() != 4 {
                    return Err(bad("Unexpected delegate approval"));
                }
                validate_approve_checked(
                    tx,
                    1,
                    wallet,
                    &a[0],
                    &key(tx, instructions[1].accounts[0])?,
                    &key(tx, instructions[1].accounts[1])?,
                )
            } else if instructions.len() == 1 {
                if tx.message.static_account_keys().len() != 3 {
                    return Err(bad("Invalid mandate management transaction"));
                }
                Ok(())
            } else {
                Err(bad(
                    "Mandate update must include at most one delegate approval",
                ))
            }
        }
        Some(PAUSE_MANDATE) | Some(REVOKE_MANDATE) => {
            if tx.message.static_account_keys().len() != 3 || instructions.len() != 1 {
                return Err(bad("Invalid mandate management transaction"));
            }
            validate_management_instruction(tx, 0, wallet)
        }
        _ => Err(bad("Unsupported ChainPay owner action")),
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use solana_message::{
        Message, MessageHeader, VersionedMessage, compiled_instruction::CompiledInstruction, v0, v1,
    };

    pub(in crate::server) fn fixture(
        version: u8,
    ) -> (VersionedTransaction, PaymentSubmissionRequest, SigningKey) {
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

    /// Build a minimal legacy transaction whose key set is exactly what the
    /// instruction references, so it clears common()'s "every key is used" rule.
    fn minimal(
        keys: Vec<String>,
        instructions: Vec<CompiledInstruction>,
        readonly_unsigned: u8,
    ) -> VersionedTransaction {
        let mut seed = [0; 32];
        getrandom::fill(&mut seed).unwrap();
        let signer = SigningKey::from_bytes(&seed);
        let account_keys = keys.iter().map(|s| Address::from_str(s).unwrap()).collect();
        let message = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: readonly_unsigned,
            },
            account_keys,
            recent_blockhash: Default::default(),
            instructions,
        });
        let signatures = vec![signer.sign(&message.serialize()).to_bytes().into()];
        VersionedTransaction {
            message,
            signatures,
        }
    }

    /// Both shapes below indexed out of bounds while building the arguments to
    /// validate_approve_checked, which only checks accounts.len() after they are
    /// evaluated. There is no CatchPanic layer, so a panic takes the worker.
    /// Removing either guard makes this test panic rather than fail.
    #[test]
    fn owner_validation_rejects_short_account_lists_instead_of_panicking() {
        let wallet = bs58::encode([9u8; 32]).into_string();
        let other = bs58::encode([8u8; 32]).into_string();
        let approve_data = vec![APPROVE_CHECKED, 0, 0, 0, 0, 0, 0, 0, 0, 6];

        // Delegate repair: a lone ApproveChecked carrying two accounts, not four.
        let tx = minimal(
            vec![wallet.clone(), other.clone(), SPL_TOKEN_PROGRAM_ID.into()],
            vec![CompiledInstruction {
                program_id_index: 2,
                accounts: vec![0, 1],
                data: approve_data.clone(),
            }],
            1,
        );
        assert!(
            common(&tx).is_ok(),
            "shape must reach validate_delegate_repair"
        );
        assert!(owner(&tx, &wallet, DEFAULT_PROGRAM_ID).is_err());

        // update_mandate whose trailing approval carries no accounts at all.
        // Instruction 0 is shaped to clear validate_management_instruction, which
        // only inspects instruction 0.
        let mut update_data = UPDATE_MANDATE.to_vec();
        update_data.resize(81, 0);
        let tx = minimal(
            vec![
                wallet.clone(),
                other,
                DEFAULT_PROGRAM_ID.into(),
                SPL_TOKEN_PROGRAM_ID.into(),
            ],
            vec![
                CompiledInstruction {
                    program_id_index: 2,
                    accounts: vec![1, 0],
                    data: update_data,
                },
                CompiledInstruction {
                    program_id_index: 3,
                    accounts: vec![],
                    data: approve_data,
                },
            ],
            2,
        );
        assert!(
            common(&tx).is_ok(),
            "shape must reach the UPDATE_MANDATE arm"
        );
        assert!(owner(&tx, &wallet, DEFAULT_PROGRAM_ID).is_err());
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

    /// Wallets add a priority fee by prepending their own compute-budget
    /// instructions, which shifts every ChainPay instruction one position later.
    /// Validating the raw list rejects the transaction the owner actually signed.
    fn ata_with_leading_compute_budget(
        price_micro_lamports: u64,
    ) -> (VersionedTransaction, String) {
        let signer = SigningKey::from_bytes(&[9; 32]);
        let wallet = Address::from(signer.verifying_key().to_bytes()).to_string();
        let mint = Address::from([5; 32]).to_string();
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
        let mut price = vec![SET_COMPUTE_UNIT_PRICE];
        price.extend_from_slice(&price_micro_lamports.to_le_bytes());
        let message = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 5,
            },
            account_keys: [
                wallet.clone(),
                ata,
                mint,
                SPL_TOKEN_PROGRAM_ID.into(),
                "11111111111111111111111111111111".into(),
                ata_program.into(),
                COMPUTE_BUDGET_PROGRAM.into(),
            ]
            .map(|s| Address::from_str(&s).unwrap())
            .to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![
                CompiledInstruction {
                    program_id_index: 6,
                    accounts: vec![],
                    data: price,
                },
                CompiledInstruction {
                    program_id_index: 5,
                    accounts: vec![0, 1, 0, 2, 4, 3],
                    data: vec![],
                },
            ],
        });
        let tx = VersionedTransaction {
            signatures: vec![signer.sign(&message.serialize()).to_bytes().into()],
            message,
        };
        (tx, wallet)
    }

    #[test]
    fn wallet_added_priority_fee_does_not_reject_the_owner_transaction() {
        let (tx, wallet) = ata_with_leading_compute_budget(1_000);
        owner(&tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();
    }

    #[test]
    fn an_unbounded_priority_fee_is_still_refused() {
        let (tx, wallet) = ata_with_leading_compute_budget(100_001);
        assert!(owner(&tx, &wallet, DEFAULT_PROGRAM_ID).is_err());
    }

    #[test]
    fn a_transaction_of_only_compute_budget_instructions_is_refused() {
        let signer = SigningKey::from_bytes(&[11; 32]);
        let wallet = Address::from(signer.verifying_key().to_bytes()).to_string();
        let message = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 1,
            },
            account_keys: [wallet.clone(), COMPUTE_BUDGET_PROGRAM.into()]
                .map(|s| Address::from_str(&s).unwrap())
                .to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 1,
                accounts: vec![],
                data: vec![SET_COMPUTE_UNIT_LIMIT, 0x40, 0x0d, 0x03, 0x00],
            }],
        });
        let tx = VersionedTransaction {
            signatures: vec![signer.sign(&message.serialize()).to_bytes().into()],
            message,
        };
        assert!(owner(&tx, &wallet, DEFAULT_PROGRAM_ID).is_err());
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

    #[test]
    fn protocol_asset_and_recipient_ata_shapes_are_accepted() {
        let (_, request, signer) = fixture(0);
        let wallet = request.agent.unwrap();
        let mint = bs58::encode([5; 32]).into_string();
        let config = pda(DEFAULT_PROGRAM_ID, &[b"config"]).unwrap();
        let asset = pda(DEFAULT_PROGRAM_ID, &[b"asset", &[5; 32]]).unwrap();
        let recipient = bs58::encode([9; 32]).into_string();
        let ata = pda(
            ATA_PROGRAM,
            &[
                &address_bytes(&recipient).unwrap(),
                &address_bytes(SPL_TOKEN_PROGRAM_ID).unwrap(),
                &[5; 32],
            ],
        )
        .unwrap();
        let keys = [
            wallet.clone(),
            config.clone(),
            asset.clone(),
            mint.clone(),
            SPL_TOKEN_PROGRAM_ID.into(),
            SYSTEM_PROGRAM.into(),
            DEFAULT_PROGRAM_ID.into(),
            recipient.clone(),
            ata.clone(),
            ATA_PROGRAM.into(),
        ]
        .map(|value| Address::from_str(&value).unwrap())
        .to_vec();

        let mut init_data = INIT_CONFIG.to_vec();
        init_data.extend_from_slice(&[1; 96]);
        let init = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 1,
            },
            account_keys: [
                wallet.clone(),
                config.clone(),
                SYSTEM_PROGRAM.into(),
                DEFAULT_PROGRAM_ID.into(),
            ]
            .map(|value| Address::from_str(&value).unwrap())
            .to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 3,
                accounts: vec![1, 0, 2],
                data: init_data,
            }],
        });
        let init_tx = VersionedTransaction {
            signatures: vec![signer.sign(&init.serialize()).to_bytes().into()],
            message: init,
        };
        owner(&init_tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();

        let mut register_data = REGISTER_ASSET.to_vec();
        register_data.extend_from_slice(&[5; 32]);
        let register = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 4,
            },
            account_keys: keys[..7].to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 6,
                accounts: vec![1, 2, 0, 3, 4, 5],
                data: register_data,
            }],
        });
        let register_tx = VersionedTransaction {
            signatures: vec![signer.sign(&register.serialize()).to_bytes().into()],
            message: register,
        };
        owner(&register_tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();

        let set_status = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 1,
            },
            account_keys: [
                wallet.clone(),
                config.clone(),
                asset.clone(),
                DEFAULT_PROGRAM_ID.into(),
            ]
            .map(|value| Address::from_str(&value).unwrap())
            .to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 3,
                accounts: vec![1, 2, 0],
                data: vec![58, 54, 181, 102, 68, 238, 240, 245, 0],
            }],
        });
        let set_status_tx = VersionedTransaction {
            signatures: vec![signer.sign(&set_status.serialize()).to_bytes().into()],
            message: set_status,
        };
        owner(&set_status_tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();

        let recipient_ata = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 4,
            },
            account_keys: [
                wallet.clone(),
                ata.clone(),
                recipient.clone(),
                mint.clone(),
                SPL_TOKEN_PROGRAM_ID.into(),
                SYSTEM_PROGRAM.into(),
                ATA_PROGRAM.into(),
            ]
            .map(|value| Address::from_str(&value).unwrap())
            .to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 6,
                accounts: vec![0, 1, 2, 3, 5, 4],
                data: vec![],
            }],
        });
        let recipient_tx = VersionedTransaction {
            signatures: vec![signer.sign(&recipient_ata.serialize()).to_bytes().into()],
            message: recipient_ata,
        };
        owner(&recipient_tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();
        let mut bad_recipient = recipient_tx;
        if let VersionedMessage::Legacy(message) = &mut bad_recipient.message {
            message.instructions[0].accounts[2] = 0;
        }
        assert!(owner(&bad_recipient, &wallet, DEFAULT_PROGRAM_ID).is_err());
    }

    #[test]
    fn mandate_update_with_approval_and_delegate_actions_validate() {
        let (_, request, signer) = fixture(0);
        let wallet = request.agent.unwrap();
        let mandate = bs58::encode([2; 32]).into_string();
        let source = bs58::encode([6; 32]).into_string();
        let mint = bs58::encode([5; 32]).into_string();
        let keys = [
            wallet.clone(),
            mandate.clone(),
            source.clone(),
            mint.clone(),
            SPL_TOKEN_PROGRAM_ID.into(),
            DEFAULT_PROGRAM_ID.into(),
        ]
        .map(|value| Address::from_str(&value).unwrap())
        .to_vec();
        let mut update_data = UPDATE_MANDATE.to_vec();
        update_data.extend_from_slice(&signer.verifying_key().to_bytes());
        for value in [10_u64, 100, 1000, 0, 0] {
            update_data.extend_from_slice(&value.to_le_bytes());
        }
        update_data.push(0);
        let mut approval = vec![APPROVE_CHECKED];
        approval.extend_from_slice(&100u64.to_le_bytes());
        approval.push(6);
        let update = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 2,
            },
            account_keys: keys.clone(),
            recent_blockhash: Default::default(),
            instructions: vec![
                CompiledInstruction {
                    program_id_index: 5,
                    accounts: vec![1, 0],
                    data: update_data.clone(),
                },
                CompiledInstruction {
                    program_id_index: 4,
                    accounts: vec![2, 3, 1, 0],
                    data: approval.clone(),
                },
            ],
        });
        let update_tx = VersionedTransaction {
            signatures: vec![signer.sign(&update.serialize()).to_bytes().into()],
            message: update,
        };
        owner(&update_tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();

        let repair = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 2,
            },
            account_keys: keys[..5].to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 4,
                accounts: vec![2, 3, 1, 0],
                data: approval,
            }],
        });
        let repair_tx = VersionedTransaction {
            signatures: vec![signer.sign(&repair.serialize()).to_bytes().into()],
            message: repair,
        };
        owner(&repair_tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();

        let removal = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 1,
            },
            account_keys: [wallet.clone(), source, SPL_TOKEN_PROGRAM_ID.into()]
                .map(|value| Address::from_str(&value).unwrap())
                .to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![CompiledInstruction {
                program_id_index: 2,
                accounts: vec![1, 0],
                data: vec![REVOKE_DELEGATE],
            }],
        });
        let removal_tx = VersionedTransaction {
            signatures: vec![signer.sign(&removal.serialize()).to_bytes().into()],
            message: removal,
        };
        owner(&removal_tx, &wallet, DEFAULT_PROGRAM_ID).unwrap();

        let mut bad_update = update_tx;
        if let VersionedMessage::Legacy(message) = &mut bad_update.message {
            message.instructions[1].accounts[2] = 0;
        }
        assert!(owner(&bad_update, &wallet, DEFAULT_PROGRAM_ID).is_err());
    }

    #[test]
    fn rejects_unsupported_owner_shapes() {
        let (_, request, _) = fixture(0);
        let wallet = request.agent.unwrap();
        let memo = VersionedTransaction {
            signatures: vec![Default::default()],
            message: VersionedMessage::Legacy(Message {
                header: MessageHeader {
                    num_required_signatures: 1,
                    num_readonly_signed_accounts: 0,
                    num_readonly_unsigned_accounts: 1,
                },
                account_keys: [wallet.clone(), bs58::encode([10; 32]).into_string()]
                    .map(|value| Address::from_str(&value).unwrap())
                    .to_vec(),
                recent_blockhash: Default::default(),
                instructions: vec![CompiledInstruction {
                    program_id_index: 1,
                    accounts: vec![0],
                    data: b"hello".to_vec(),
                }],
            }),
        };
        assert!(owner(&memo, &wallet, DEFAULT_PROGRAM_ID).is_err());

        let mut register_data = REGISTER_ASSET.to_vec();
        register_data.extend_from_slice(&[5; 32]);
        let register = VersionedMessage::Legacy(Message {
            header: MessageHeader {
                num_required_signatures: 1,
                num_readonly_signed_accounts: 0,
                num_readonly_unsigned_accounts: 4,
            },
            account_keys: [
                wallet.clone(),
                pda(DEFAULT_PROGRAM_ID, &[b"config"]).unwrap(),
                pda(DEFAULT_PROGRAM_ID, &[b"asset", &[5; 32]]).unwrap(),
                bs58::encode([5; 32]).into_string(),
                SPL_TOKEN_PROGRAM_ID.into(),
                SYSTEM_PROGRAM.into(),
                DEFAULT_PROGRAM_ID.into(),
            ]
            .map(|value| Address::from_str(&value).unwrap())
            .to_vec(),
            recent_blockhash: Default::default(),
            instructions: vec![
                CompiledInstruction {
                    program_id_index: 6,
                    accounts: vec![1, 2, 0, 3, 4, 5],
                    data: register_data,
                },
                CompiledInstruction {
                    program_id_index: 6,
                    accounts: vec![1, 2, 0, 3, 4, 5],
                    data: vec![21, 80, 155, 149, 117, 207, 235, 16, 5, 5, 5, 5],
                },
            ],
        });
        let extra_ix = VersionedTransaction {
            signatures: vec![Default::default()],
            message: register,
        };
        assert!(owner(&extra_ix, &wallet, DEFAULT_PROGRAM_ID).is_err());
    }
}
