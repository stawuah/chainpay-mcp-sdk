# Networks and assets

**ChainPay's current product target is Solana Devnet.** A token symbol or a mint
listed in source does not prove that a running deployment supports payment with
it. Confirm the selected RPC, program, registry entry, and live token-account
capabilities together.

## Devnet defaults in source

The [bootstrap script](../../scripts/bootstrap-devnet.mjs) contains these defaults:

| Setting | Source default |
| --- | --- |
| RPC | `https://api.devnet.solana.com` |
| ChainPay program | `3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4` |
| USDC mint · classic SPL Token | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| PYUSD mint · Token-2022 | `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM` |

These are repository configuration mappings, not a claim of current issuer,
provider, or merchant acceptance. `CHAINPAY_RPC_URL`, `CHAINPAY_PROGRAM_ID`, and
`CHAINPAY_TOKEN_2022_MINT` can override the script defaults. An override must
still match the intended Devnet deployment; do not infer a cluster from a token
label.

## Read support before preparing a payment

1. Read `get_protocol_config` for the protocol authority and legacy bootstrap
   list. That list is not the active settlement allowlist.
2. Read `get_supported_assets` or `get_asset` for the mint's `SupportedAsset`
   registry entry. It must be enabled and bound to the correct token program.
3. Check the live mint and source/recipient accounts through SDK preparation.
   The asset must be compatible with the supported transfer path and the mandate.

The [SDK quickstart](../guides/use-the-sdk.md) starts with a read-only config
request. A successful config read proves that account was readable; it does not
prove a full payment flow. Current evidence belongs in
[implementation status](../project/implementation-status.md).

## Bootstrap is an authority operation

The bootstrap script verifies the executable program and mint program owners,
initializes missing configuration, and registers missing USDC/PYUSD entries.
Existing disabled assets, ownership mismatches, or conflicting configuration
stop it rather than silently changing policy. It signs and submits missing setup
transactions and waits for finality; it is not a read-only setup check.

Use the [script reference](../../scripts/README.md) when an authority explicitly
chooses to initialize a deployment.

## Token-2022 support

The supported SDK/MCP path uses transparent `transfer_checked` transfers and
checks live mint and account extensions. Active transfer hooks, non-zero fees,
incompatible account state, and unknown extensions block preparation.
A confidential extension's presence is not proof of confidential-payment support.

**Do not supply hook accounts manually.** The SDK rejects caller-supplied
`remainingAccounts`; active hooks need a separately implemented and verified
adapter. Although the program forwards remaining accounts to its CPI, the public
integration does not expose that as supported hook settlement.

## Production targets in repository history

The scope names USDC and PYUSD as future production assets. The repository's
historical mappings are retained here for reference:

| Asset | Documented mainnet mint | Documented token program |
| --- | --- | --- |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Classic SPL Token |
| PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 |

These mappings were not independently reverified for this documentation change.
They are not deployment instructions or evidence of supported mainnet payments.
Mainnet deployment and production x402 integration remain outside the current
[scope](../scope.md).
