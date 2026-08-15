# ChainPay Solana program

This Anchor program implements the ChainPay Devnet payment rail described in
`docs/scope.md`.

## On-chain flow

1. The protocol authority initializes the `config` PDA, then registers each
   explicitly supported settlement mint in its own `asset` PDA.
2. A wallet owner creates a nonce-scoped `mandate` PDA per policy and supported
   mint, with a source token account, per-payment limit, total limit, expiry
   slot, optional payment-count cap, and optional cooldown. The same owner can
   maintain multiple independent policies for USDC, PYUSD, or any other
   registered token. Each payment supplies its own destination token account.
   Existing legacy and mint-scoped accounts remain readable and executable.
3. The wallet owner explicitly approves the mandate PDA as the source token
   account's SPL Token delegate. The program never receives or stores the
   wallet private key.
4. The approved agent calls `execute_payment`. The program checks the mandate,
   delegate, mint, recipient, amount, expiry, and identifiers before invoking
   the configured SPL Token or Token-2022 program with the mandate PDA as
   signer.
5. A `receipt` PDA is created using:

   ```text
   ["receipt", mandate, invoice_hash]
   ```

   A second attempt using the same invoice hash fails because the receipt PDA
   already exists.

New mandate identities use:

```text
["mandate", owner, allowed_mint, mandate_nonce]
```

The SDK creates the nonce automatically. The program stores it in the existing
reserved compatibility field, keeping old mandate account sizes compatible.

## Instructions

Core payment instructions:

- `create_mandate`
- `update_mandate`
- `pause_mandate`
- `revoke_mandate`
- `execute_payment`

Devnet configuration instructions:

- `initialize_config`
- `update_config`
- `register_asset`
- `set_asset_status`

The asset registry allows any explicitly approved SPL or Token-2022 mint while
rejecting every unregistered or disabled mint on-chain. The config and asset
authority are operational trust boundaries and must be controlled by the
deployment owner.

## Token support boundary

The transfer path uses `anchor_spl::token_interface::transfer_checked`, which
supports classic SPL Token and basic Token-2022 mints. The mint, source account,
recipient account, and token program are cross-checked on-chain. Token-2022
transfer-hook, confidential-transfer, and other extension-specific flows are
not part of this MVP; they require additional remaining accounts and dedicated
tests.

`signature_reference` is supplied by the caller because a Solana program cannot
know the enclosing transaction signature during execution. The backend should
map it to the finalized transaction signature after confirmation.

## Local verification

```bash
cargo fmt --all -- --check
cargo test -p chainpay --offline
cargo check -p chainpay --offline

# Build the SBF program, generate target/idl/chainpay.json, and run both
# classic SPL Token and Token-2022 settlement tests.
make ANCHOR=/home/stephen/.avm/bin/anchor-1.1.2 contract-smoke
```

Do not deploy or sign transactions as part of local checks. Devnet deployment
requires an explicit wallet, configured RPC, funded payer, and a separately
approved deployment step.
