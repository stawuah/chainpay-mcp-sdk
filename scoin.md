# ChainPay stablecoin settlement

## Short answer

Yes: ChainPay has a real on-chain settlement path for fungible SPL assets.
The program can move tokens from a user-owned source token account to an
allowlisted recipient token account through either:

- the classic SPL Token program; or
- the Token-2022 program.

The settlement is performed by a real Solana CPI using `transfer_checked`. It
is not a balance simulation or an internal database transfer.

The honest qualification is:

> The code implements and tests the settlement rail with demonstration mints,
> including a basic Token-2022 mint. It does not yet prove a live production
> USDC or PYUSD payment on mainnet, and it does not support extension-heavy
> Token-2022 flows such as transfer hooks or confidential transfers.

| Capability | Status |
| --- | --- |
| Real on-chain token transfer | Implemented |
| User-approved spending policy | Implemented |
| Classic SPL Token settlement | Implemented and covered by LiteSVM |
| Basic Token-2022 settlement | Implemented and covered by LiteSVM |
| SDK payment preparation | Implemented |
| Rust backend simulation, relay, and status tracking | Implemented |
| MCP payment tools | Implemented |
| x402 exact challenge normalization on Solana Devnet | Implemented |
| Live mainnet USDC settlement | Not deployed or verified here |
| Live mainnet PYUSD settlement | Not deployed or verified here |
| Token-2022 transfer hooks/confidential transfers | Not implemented |
| Fiat redemption or stablecoin issuance | Not implemented |

## What “stablecoin settlement” means here

ChainPay does not create USDC, issue PYUSD, redeem dollars, or inspect whether
an asset is truly pegged to a fiat currency. The program sees a Solana mint and
integer token units.

For ChainPay, a stablecoin payment is:

```text
source token account
        |
        | controlled by a limited mandate delegate
        v
ChainPay execute_payment
        |
        | transfer_checked CPI
        v
SPL Token or Token-2022 program
        |
        v
recipient token account
```

The mint address identifies the asset. The token-program address identifies the
program that owns the mint and token accounts. A token symbol such as `USDC`
is not trusted by the program.

This means the same settlement path can support:

- a stablecoin such as USDC, once its correct mint is registered for the target
  cluster;
- a Token-2022 stablecoin such as PYUSD, once its exact mint and extension
  requirements are verified;
- another ordinary SPL token;
- a Devnet demonstration mint.

The protocol does not currently distinguish “stablecoin” from “normal token” at
the instruction level. The policy controls the exact mint, so an agent cannot
replace an approved stablecoin mint with a different token.

## The settlement components

| File | Settlement responsibility |
| --- | --- |
| [`programs/chainpay/src/lib.rs`](programs/chainpay/src/lib.rs) | Runs `execute_payment`, invokes the token program, updates the mandate, and writes the receipt. |
| [`programs/chainpay/src/instructions/execute_payment.rs`](programs/chainpay/src/instructions/execute_payment.rs) | Defines the exact mint, source, recipient, agent, token-program, and receipt accounts. |
| [`programs/chainpay/src/policy.rs`](programs/chainpay/src/policy.rs) | Checks amount, limits, expiry, pause/revoke state, cooldown, count, and identifiers. |
| [`programs/chainpay/src/state.rs`](programs/chainpay/src/state.rs) | Stores the mandate and durable receipt. |
| [`programs/chainpay/src/instructions/create_mandate.rs`](programs/chainpay/src/instructions/create_mandate.rs) | Verifies the source/mint/recipient relationship when the policy is created. |
| [`programs/chainpay/src/instructions/assets.rs`](programs/chainpay/src/instructions/assets.rs) | Registers a mint with its token-program identity and enabled status. |
| [`programs/chainpay/tests/settlement.rs`](programs/chainpay/tests/settlement.rs) | Runs the same program flow against classic SPL Token and Token-2022 in LiteSVM. |
| [`sdk/src/payment.ts`](sdk/src/payment.ts) | Builds the payment instruction and performs local preflight. |
| [`sdk/src/mandate.ts`](sdk/src/mandate.ts) | Builds mandate creation and token delegate approval. |
| [`backend/src/server.rs`](backend/src/server.rs) | Validates signed payment bytes, simulates, relays, and tracks confirmation. |
| [`mcp-server/src/tools/execute_payment.ts`](mcp-server/src/tools/execute_payment.ts) | Connects an agent payment request to the SDK and optional backend relay. |

## The real on-chain flow

### 1. Register protocol configuration

The authority calls `initialize_config` with up to three non-default, unique
mint addresses. This creates the config PDA:

```text
["config"]
```

The config stores the authority and three configured mint slots.

The code also contains `is_supported_mint`, but no production instruction
currently calls it. The active settlement gate is the separate
`SupportedAsset` registry described next.

### 2. Register the mint and token program

The authority calls `register_asset` for a mint. The program creates:

```text
["asset", mint]
```

The `SupportedAsset` PDA stores:

```text
authority
mint
token_program
enabled
bump
```

The account constraints require that:

1. the mint account address matches the requested mint;
2. the mint account is owned by the supplied token program;
3. the token program is the classic SPL Token program or Token-2022 interface;
4. the signer is the protocol authority.

The asset starts with `enabled = true`. The authority can call
`set_asset_status(false)` to stop new mandate/payment use of that asset.

### 3. Create the owner's mandate

The owner creates one mandate PDA:

```text
["mandate", owner]
```

The owner chooses:

```text
approved_agent
source_token_account
allowed_mint
allowed_recipient
max_per_payment
total_limit
expires_at_slot
max_payment_count
cooldown_slots
```

At creation, the program checks that:

1. the asset registry entry exists and is enabled;
2. the registry mint equals the allowed mint;
3. the registry token program equals the supplied token program;
4. the source account belongs to the owner;
5. the source account uses the allowed mint;
6. the recipient account uses the allowed mint;
7. the mint, source, recipient, and token program all belong to the same token
   program;
8. the limits and expiry are valid.

The program records zero spent amount, zero payment count, and false pause and
revoke state.

### 4. Approve the mandate PDA as a limited delegate

Creating the mandate does not automatically grant token spending permission.
The owner explicitly approves the mandate PDA as the source token account's
delegate through the token program.

The SDK normally prepares these two instructions in one owner-signed
transaction:

```text
1. ChainPay create_mandate
2. SPL Token or Token-2022 approve_checked
```

The default delegate amount is the mandate's `total_limit`, unless the caller
provides a smaller `delegateAmount`.

This creates two independent protections:

- the token program tracks the remaining delegate allowance;
- ChainPay tracks the mandate's per-payment and lifetime policy limits.

The approved agent is not the token delegate. The mandate PDA is the delegate.
The agent signs the request that asks ChainPay to use its PDA authority.

### 5. Prepare a payment request

A caller supplies:

```text
mandate
invoice_hash
payment_id
signature_reference
mint
recipient
amount
token_program
```

Amounts are integer base units. For a six-decimal token:

```text
1.25 tokens = 1_250_000 base units
```

The program does not convert display amounts into base units. The SDK, merchant,
connector, or application must do that before building the transaction.

The invoice hash is supplied by the caller. In a merchant-signed request or
x402 flow, it is derived deterministically from the canonical request.

### 6. Run local preflight

`ChainPayClient.preparePayment` reads the mandate and current slot, detects the
token program from the source account, derives the receipt PDA, checks whether a
receipt already exists, and runs SDK preflight.

The SDK checks:

- mandate status;
- approved agent;
- mint;
- recipient;
- positive amount;
- per-payment limit;
- total limit;
- payment-count limit;
- cooldown;
- expiry;
- non-zero invoice hash;
- non-zero payment ID;
- non-zero signature reference;
- duplicate receipt;
- token-program consistency.

This gives the agent or UI a useful explanation before asking for a signature.
It is not the final authority. The Solana program repeats the critical checks.

### 7. Sign the payment transaction

The prepared transaction requires the approved agent signer and normally uses
the agent as fee payer. The wallet or approved signer service signs it.

MCP does not hold a private key. If no external signer or payment adapter is
configured, MCP returns the transaction plan and says that an external signer is
required.

### 8. Validate accounts on-chain

`execute_payment` requires these accounts in this order:

| Position | Account | Settlement check |
| ---: | --- | --- |
| 0 | Config PDA | Must be the protocol config PDA. |
| 1 | Asset PDA | Must be enabled and bind the mandate mint to the token program. |
| 2 | Mandate PDA | Must be derived from the mandate owner. |
| 3 | Receipt PDA | Must be new and derived from mandate plus invoice hash. |
| 4 | Agent | Must sign and equal `mandate.approved_agent`. |
| 5 | Mint | Must equal `mandate.allowed_mint` and use the token program. |
| 6 | Source token account | Must be the mandate source, owner-owned, correctly minted, and delegated to the mandate PDA. |
| 7 | Recipient token account | Must equal `mandate.allowed_recipient` and use the same mint/program. |
| 8 | Token program | Must match the mint, source, recipient, and asset registry. |
| 9 | System program | Pays for the receipt PDA. |

These are Anchor account constraints in
[`execute_payment.rs`](programs/chainpay/src/instructions/execute_payment.rs),
not merely checks in the SDK.

### 9. Enforce policy on-chain

`validate_payment` checks:

1. the mandate is not revoked;
2. the mandate is not paused;
3. the mandate has not expired;
4. the amount is positive;
5. the amount is within the per-payment limit;
6. the invoice hash is not all zeroes;
7. the payment ID is not all zeroes;
8. the signature reference is not all zeroes;
9. the new cumulative amount does not exceed the total limit;
10. the new payment count does not exceed its cap;
11. the cooldown has elapsed.

If any rule fails, the instruction returns a `ChainPayError` and the transfer
does not happen.

### 10. Execute the token transfer

The handler creates the PDA signer seeds:

```text
[b"mandate", mandate.owner, mandate.bump]
```

It creates an Anchor `TransferChecked` CPI context:

```rust
from: source_token_account
mint: allowed_mint
to: recipient_token_account
authority: mandate_pda
```

The call is:

```rust
token_interface::transfer_checked(
    transfer_context,
    params.amount,
    allowed_mint.decimals,
)?;
```

This is where real token balances move. ChainPay does not subtract a number in
its own database and call that settlement. It invokes the selected Solana token
program, which verifies the token account ownership, mint, delegate authority,
allowance, and amount.

### 11. Write counters and receipt

After the CPI succeeds, the program writes:

```text
mandate.amount_spent += amount
mandate.payment_count += 1
mandate.last_payment_slot = current_slot
```

It creates the receipt PDA:

```text
["receipt", mandate, invoice_hash]
```

The receipt records the mandate, invoice hash, payment ID, mint, source account,
recipient account, amount, agent, slot, signature reference, status `1`, and
receipt bump.

Because the receipt uses `init`, a second attempt with the same mandate and
invoice hash cannot create another receipt. The transaction fails atomically and
the recipient balance stays unchanged.

## Classic SPL Token versus Token-2022

The code does not have two separate payment handlers. It uses Anchor's token
interface:

```rust
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
```

The supplied token program is passed into the same `transfer_checked` CPI.

The program cross-checks:

```text
mint owner           == selected token program
source account owner == selected token program
recipient owner     == selected token program
asset registry       == selected token program
```

That prevents a caller from mixing a classic SPL mint with Token-2022 accounts,
or presenting a Token-2022 account while selecting the classic program.

### What the tests prove

`programs/chainpay/tests/settlement.rs` defines:

```text
Spl       -> classic SPL Token program
Token2022 -> Token-2022 program
```

For each variant, the test:

1. creates a mint;
2. initializes it with six decimals;
3. creates source and recipient token accounts;
4. mints 1,000 base units into the source;
5. initializes ChainPay config;
6. registers the asset;
7. creates the mandate;
8. approves the mandate PDA as delegate for 1,000 units;
9. executes a 250-unit payment signed by the agent;
10. checks that the recipient received 250 units;
11. checks that the receipt exists;
12. retries the invoice and expects failure;
13. tries an amount over the per-payment limit and expects failure;
14. confirms the recipient balance is still 250.

This is a real program execution inside LiteSVM, not a mocked assertion about a
function return value. It loads the built ChainPay program and invokes the token
program instructions.

### What the tests do not prove

They do not prove:

- that the deployed Render/backend environment reaches the correct live mint;
- that mainnet USDC is registered in a deployed production config;
- that the target PYUSD mint's actual Token-2022 extensions work with the basic
  transfer path;
- that a merchant accepts the resulting payment;
- that any fiat issuer will redeem the asset;
- that transfer hooks or confidential-transfer accounts are correctly resolved.

## Stablecoin asset targets

The repository documents these production targets in
[`docs/networks.md`](docs/networks.md):

| Asset | Documented target mint | Documented token program |
| --- | --- | --- |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | classic SPL Token |
| PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 |

These are configuration targets, not proof that the current Devnet deployment
has those assets registered. The automated test creates a fresh demonstration
mint for each token-program variant.

The exact mint and token-program mapping must be re-verified for every cluster
and deployment. Do not infer the asset from a ticker or UI label.

## Backend settlement path

The backend does not own a wallet and does not construct an unsigned payment
from a text request. It accepts a wallet-signed transaction.

`POST /v1/payments`:

1. validates the idempotency key, mandate, invoice hash, and base64 transaction;
2. deserializes and verifies the Solana transaction signatures;
3. finds the ChainPay `execute_payment` instruction;
4. binds request metadata to the signed instruction's mandate, invoice hash,
   receipt, agent, mint, recipient, token program, and amount;
5. stores a prepared status record;
6. simulates the signed transaction with signature verification;
7. sends it to Solana RPC after successful simulation;
8. stores the transaction signature;
9. polls until finalized or failed;
10. returns the backend status and signature.

The backend is useful for relay, simulation, and status tracking. It cannot make
an invalid mandate valid. The program is still the final authority.

The backend currently enforces Devnet in `BackendConfig`. Therefore the current
service is not a mainnet stablecoin settlement service without deliberate
configuration and deployment changes.

## MCP and agent path

An agent can use:

```text
get_protocol_config
get_asset
get_mandate
verify_payment_request
quote_payment
prepare_payment
execute_payment
wait_for_payment
get_payment
```

The normal flow is:

```text
agent receives payment demand
        |
        v
verify merchant request or normalize x402 challenge
        |
        v
quote/preflight against mandate
        |
        v
return transaction to external signer
        |
        v
relay signed transaction through backend
        |
        v
read final status and receipt PDA
```

The agent does not receive unrestricted wallet authority. The owner has already
limited the mint, source, recipient, amount, expiry, count, and cooldown.

## x402 settlement

The x402 connector currently supports Solana Devnet and the `exact` scheme.

It normalizes an x402 challenge into:

```text
mint
recipient
amount
token_program
resource
nonce
expires_at_slot
invoice_hash
payment_id
signature_reference
```

It then sends those values through the same ChainPay mandate and payment
preflight path. It does not bypass policy and does not become a hosted
facilitator or key custodian.

The x402 payment still has to use an approved mandate, the approved mint and
token program, the approved recipient, the mandate limits, and an external
signature. It then executes through `execute_payment` and produces the same
receipt PDA. x402 is a connector, not a second settlement engine.

## Error handling during settlement

There are three important failure boundaries.

### SDK/MCP errors before signing

Invalid addresses, malformed hex, unsupported token-program labels, missing
fields, invalid amounts, or failed preflight are returned before a transaction
is submitted.

### Backend errors before relay

The backend rejects malformed base64, invalid transaction bytes, invalid
signatures, mismatched request metadata, unsupported token-program labels, and a
transaction without the expected ChainPay instruction.

### On-chain errors during execution

The program rejects:

- an unapproved agent;
- a wrong mint or token program;
- a wrong source or recipient account;
- an absent or disabled asset registry entry;
- a missing mandate delegate or insufficient delegate allowance;
- a paused, revoked, or expired mandate;
- an amount above policy;
- total or payment-count overflow/limits;
- an active cooldown;
- a replayed invoice receipt.

If the token CPI fails or any later part of the instruction fails, Solana rolls
back the entire transaction. No partial token transfer or half-written receipt
should remain.

## What is still needed for production stablecoin settlement

Before describing ChainPay as production stablecoin infrastructure, we still
need to complete and verify:

1. deploy and verify the program on the intended target cluster;
2. register the exact USDC and/or PYUSD mint for that cluster;
3. verify the mint owner and token-program mapping from chain state;
4. test a real wallet-signed payment using the target mint;
5. test the merchant recipient account and receipt lookup end to end;
6. decide whether `ProtocolConfig.supported_mints` is only a bootstrap list or
   must be enforced by calling `is_supported_mint`;
7. add dedicated Token-2022 extension handling where the target mint requires
   it;
8. add production-grade deployment authority, RPC, observability, and
   persistence controls;
9. add production connector and transaction tests;
10. separately assess legal, issuer, custody, and operational requirements for
    any real stablecoin product.

The current implementation is a settlement primitive. A primitive is not the
same thing as a production issuer integration or a mainnet deployment.

## How to verify the current implementation

From the repository root:

```bash
cargo fmt --all -- --check
cargo test --workspace --offline
cargo check -p chainpay --offline
```

To run the settlement tests specifically:

```bash
make ANCHOR=/home/stephen/.avm/bin/anchor-1.1.2 contract-smoke
```

The settlement tests run both:

```text
settles_through_classic_spl_token_and_rejects_replay
settles_through_token_2022_and_rejects_replay
```

These commands build and test the program. They do not sign or send a Devnet or
mainnet transaction. Any live wallet operation must be separately reviewed,
simulated, and explicitly approved.

## Final answer in plain language

We have implemented the core stablecoin settlement mechanism:

```text
owner-approved mandate
    -> limited token delegate
    -> approved agent request
    -> on-chain policy checks
    -> real SPL/Token-2022 transfer_checked CPI
    -> durable receipt PDA
```

What we have not implemented is the full production promise around it: live
mainnet asset deployment, verified USDC/PYUSD flows, issuer/merchant settlement,
and advanced Token-2022 extensions.
