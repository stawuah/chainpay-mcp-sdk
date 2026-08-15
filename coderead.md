# ChainPay code read

This is a guided reading of the current ChainPay codebase. It starts with the
Solana program because that is the final authority over funds, then follows a
payment through the TypeScript SDK, the Rust backend, and the MCP server.

The guide describes what the code does today. Product ideas that are not yet
implemented are called out as roadmap items instead of being presented as
working behavior.

## Start here: the whole system in one minute

The simplest mental model is:

```text
owner wallet
    |
    | creates mandate + approves limited token delegate
    v
PaymentMandate PDA  <----- approved agent signs payment transaction
    |                                      |
    | PDA signs token CPI                  v
    +------------------------------> ChainPay program
                                           |
                                           | transfer_checked CPI
                                           v
                                  SPL Token or Token-2022
                                           |
                                           v
                                  merchant token account

                                  PaymentReceipt PDA
                                  proves the invoice was settled
```

The surrounding services do not replace the program:

```text
AI agent
   |
   v
MCP tool -> TypeScript SDK -> wallet/external signer -> signed transaction
                                      |
                                      v
                              Rust backend (optional relay)
                                      |
                                      v
                                 Solana RPC
                                      |
                                      v
                              ChainPay Solana program
```

### Explain it like I am five

Imagine a parent gives a babysitter a special spending card.

- The parent writes the rules: “only this shop, only this token, no more than
  10 coins at once, no more than 100 coins in total, and only until Friday.”
- The parent gives the card a small spending allowance. The parent does not
  give the babysitter the bank password.
- The babysitter asks the payment machine to pay the shop.
- The payment machine checks every rule itself.
- If the rules fit, the machine moves the coins and writes a receipt.
- If the same invoice comes back, the receipt slot is already occupied, so it
  cannot be paid a second time.

In ChainPay terminology, the parent is the wallet owner, the babysitter is the
approved agent, the card is the token delegate, the rule card is the mandate
PDA, and the receipt slot is the receipt PDA.

## What is actually in the repository

### Contract and contract tests

| File | Job |
| --- | --- |
| `programs/chainpay/src/lib.rs` | Anchor program ID, events, and all instruction handlers. |
| `programs/chainpay/src/state.rs` | On-chain account data layouts and byte-size constants. |
| `programs/chainpay/src/policy.rs` | Reusable mandate, payment, and supported-mint validation. |
| `programs/chainpay/src/errors.rs` | Custom on-chain error codes and user-readable messages. |
| `programs/chainpay/src/instructions/mod.rs` | Registers and re-exports instruction account/context modules. |
| `programs/chainpay/src/instructions/config.rs` | Accounts for initializing and updating the config PDA. |
| `programs/chainpay/src/instructions/assets.rs` | Accounts for registering and enabling/disabling asset registry PDAs. |
| `programs/chainpay/src/instructions/create_mandate.rs` | Mandate input type and account constraints for creation. |
| `programs/chainpay/src/instructions/update_mandate.rs` | Mandate update input and owner account constraints. |
| `programs/chainpay/src/instructions/pause_mandate.rs` | Owner-only pause account constraints. |
| `programs/chainpay/src/instructions/revoke_mandate.rs` | Owner-only permanent revocation account constraints. |
| `programs/chainpay/src/instructions/execute_payment.rs` | Payment input and the account constraints for settlement. |
| `programs/chainpay/tests/layout.rs` | Layout constants and PDA-seed tests. |
| `programs/chainpay/tests/settlement.rs` | LiteSVM end-to-end settlement tests for classic SPL Token and Token-2022. |
| `programs/chainpay/Cargo.toml` | Anchor, token-interface, and optional LiteSVM test dependencies. |

### Integration code

| Area | Important files | What it contributes |
| --- | --- | --- |
| SDK | `sdk/src/client.ts`, `mandate.ts`, `payment.ts`, `encoding.ts`, `accounts.ts`, `pda.ts` | Derives addresses, encodes instructions, decodes state, performs local preflight, and prepares transactions. |
| Backend | `backend/src/server.rs`, `rpc/mod.rs`, `api/mod.rs`, `status/mod.rs`, `storage/mod.rs` | Validates signed requests, simulates, relays, confirms, and stores public status metadata. |
| MCP | `mcp-server/src/index.ts`, `server.ts`, `http.ts`, `tools/*` | Exposes safe JSON-RPC tools to agents and keeps signing outside MCP. |
| Deployment | `Anchor.toml`, `render.yaml`, `Makefile` | Selects Devnet, program ID, build/test commands, and Render services. |
| UI | `frontend/`, `app/` | Presentation and wallet-operation boundaries; neither is the on-chain authority. |

The package-level README files are useful summaries, but the Rust files above
are the source of truth for the contract behavior.

## Solana concepts used by this contract

### Program Derived Address (PDA)

A PDA is an address calculated from fixed seed bytes, other addresses, and the
program ID. No private key controls it. The program can sign for its own PDA
when it supplies the same seeds and bump.

The ChainPay seeds are:

| Account | Seeds |
| --- | --- |
| Config | `[b"config"]` |
| Supported asset | `[b"asset", mint]` |
| Mandate | `[b"mandate", owner]` |
| Receipt | `[b"receipt", mandate, invoice_hash]` |

### Bump

Solana searches for a bump that makes the derived address a valid PDA. The
program stores the bump in each account so it can later reproduce the PDA
signer seeds. The bump is not a secret and is not a spending limit.

### Account constraints

The `#[derive(Accounts)]` structs in `instructions/*.rs` are more than type
definitions. Anchor generates validation code from annotations such as:

- `init`: create a new account and allocate its space;
- `mut`: the instruction may change the account;
- `payer = owner`: that signer pays account-creation rent;
- `seeds` and `bump`: prove the account is the expected PDA;
- `has_one = owner`: compare an account field to a supplied account;
- `address = ...`: require an exact address;
- `constraint = expression @ Error`: run a custom check and return that error;
- `Signer`: require a transaction signature from that account;
- `InterfaceAccount` and `Interface<TokenInterface>`: accept the classic SPL
  Token program or Token-2022 through Anchor's token interface.

These checks happen before the handler body runs. That is why a handler can
start with a trusted `ctx.accounts.mandate`: Anchor has already checked the
constraints declared for that instruction.

### CPI and signer seeds

CPI means “cross-program invocation.” ChainPay invokes the token program rather
than implementing token accounting itself. In `execute_payment`, ChainPay uses
the mandate PDA as the token delegate authority. The PDA signs the CPI with:

```text
[b"mandate", mandate.owner, mandate.bump]
```

The wallet owner approved that PDA as a delegate earlier. The program therefore
spends only the amount the owner delegated and only inside the mandate rules.

## Contract entrypoint: `src/lib.rs`

### Module declarations and imports

The top of `lib.rs`:

1. imports Anchor's prelude;
2. imports `TransferChecked` and the token interface;
3. declares the deployed program ID;
4. exposes `errors`, `instructions`, `policy`, and `state`;
5. imports every account context through `instructions::*`;
6. imports the reusable policy validators.

`declare_id!` must agree with `Anchor.toml`, the SDK default program ID, the
backend default program ID, and the deployed address. The current Devnet ID is:

```text
3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4
```

### Constant: `RECEIPT_STATUS_SETTLED`

`RECEIPT_STATUS_SETTLED: u8 = 1` is the on-chain status written into a receipt
after the token transfer succeeds. The SDK interprets status `1` as confirmed.

### Events

Events are logs emitted from successful instructions. They are useful for
indexers and debugging, but the durable state is in the PDAs.

#### `AssetRegistered`

Contains the asset PDA, mint, token-program address, and initial `enabled`
value. It tells observers which program owns the mint path.

#### `AssetStatusChanged`

Contains the asset PDA, mint, and new enabled flag. This is the operational
kill switch for a registered asset.

#### `MandateCreated`

Contains the mandate address, owner, approved agent, allowed mint, expiry,
payment-count cap, and cooldown. It intentionally does not contain a new
recipient because each payment supplies its own destination. It also does not
contain the secret key or the token delegate amount.

#### `ConfigInitialized` and `ConfigUpdated`

Contain the config PDA, authority, and the three configured mint slots. A default
public key is used for an unused slot.

#### `MandateUpdated`

Contains the updated agent, limits, expiry, payment-count cap, and cooldown. It
does not report the `paused` field even though the handler updates
it; the account state remains authoritative.

#### `MandateStatusChanged`

Contains the mandate, owner, paused flag, and revoked flag. Pause and revoke
both emit this event.

#### `PaymentExecuted`

Contains the receipt, mandate, invoice hash, payment ID, mint, recipient token
account, amount, agent, and execution slot. It does not include the caller's
signature reference; read the receipt PDA for that value.

## State accounts: `src/state.rs`

Every `#[account]` gets an eight-byte Anchor account discriminator before its
fields. The `LEN` constants below exclude that discriminator. `space = 8 + LEN`
is therefore used in `init` contexts.

### `ProtocolConfig`

Fields in order:

1. `authority: Pubkey` — the authority allowed to update config and asset status;
2. `supported_mints: [Pubkey; 3]` — three bootstrap/configured mint slots;
3. `bump: u8` — PDA bump.

`LEN = 32 * 4 + 1 = 129` bytes, so the full account is 137 bytes including the
discriminator.

### `SupportedAsset`

Fields:

1. `authority` — who registered and can change this entry;
2. `mint` — the token mint;
3. `token_program` — classic SPL Token or Token-2022 program ID;
4. `enabled` — whether new mandates/payments may use this entry;
5. `bump` — asset PDA bump.

`LEN = 32 * 3 + 2 = 98`; full account size is 106 bytes.

### `PaymentMandate`

Fields in serialized order:

| Field | Meaning |
| --- | --- |
| `owner` | Wallet owner who created and controls the policy. |
| `approved_agent` | Only this signer may execute payments. |
| `source_token_account` | The one token account from which funds may be spent. |
| `allowed_mint` | The one mint allowed by this mandate. |
| `legacy_allowed_recipient` | Legacy fixed recipient, or the nonce marker used by new nonce-scoped mandates. New nonce-scoped mandates still accept a destination supplied by each payment. |
| `max_per_payment` | Maximum base units in one settlement. |
| `total_limit` | Lifetime maximum base units for this mandate. |
| `amount_spent` | Cumulative amount settled so far. |
| `payment_count` | Cumulative successful settlement count. |
| `expires_at_slot` | Last slot boundary; execution requires current slot to be lower. |
| `max_payment_count` | Maximum successful payments; `0` means unlimited. |
| `cooldown_slots` | Minimum gap after the previous payment. |
| `last_payment_slot` | Slot of the last successful payment; `0` means none yet. |
| `paused` | Temporary stop flag. |
| `revoked` | Permanent stop flag. |
| `bump` | Mandate PDA bump. |

`LEN = 32 * 5 + 8 * 8 + 3 = 227`; full account size is 235 bytes.

New mandate PDAs are derived from the owner, mint, and SDK-generated nonce:

```text
[b"mandate", owner, allowed_mint, mandate_nonce]
```

That allows multiple independent mandates for the same token. The program also
keeps compatibility with the older owner-scoped and owner-plus-mint accounts
already deployed on Devnet. The nonce is stored in the existing reserved
32-byte compatibility field, so the serialized account size does not change.

### `PaymentReceipt`

Fields:

1. `mandate` — the policy that authorized the payment;
2. `invoice_hash` — caller-supplied 32-byte invoice identity;
3. `payment_id` — caller-supplied 32-byte payment identity;
4. `mint` — settled mint;
5. `source_token_account` — source account recorded for audit;
6. `recipient_token_account` — destination token account;
7. `amount` — base-unit amount;
8. `agent` — agent signer that executed;
9. `executed_at_slot` — slot observed by the program;
10. `signature_reference` — caller-supplied deterministic reference;
11. `status` — currently `1` for settled;
12. `bump` — receipt PDA bump.

`LEN = 32 * 8 + 8 * 2 + 2 = 274`; full account size is 282 bytes.

The receipt PDA includes the invoice hash in its seeds. `init` fails if the same
mandate and invoice hash are used again. This is the actual on-chain replay
barrier.

## Instruction account files

The account structs are separated from the handlers so each handler has a clear
account contract. The handler names and the account context names are re-exported
by `src/instructions/mod.rs`.

### `config.rs`

#### `InitializeConfig`

Accounts:

1. `config`: new PDA at `[b"config"]`; Anchor creates it;
2. `authority`: mutable signer and rent payer;
3. `system_program`: creates the account.

There is no previous authority to check because this is the first write to the
config PDA.

#### `UpdateConfig`

Accounts:

1. `config`: existing mutable config PDA;
2. `authority`: signer that must match `config.authority` through `has_one`.

The handler does not allow an arbitrary account to update the configuration.

### `assets.rs`

#### `RegisterAsset`

Accounts and checks:

1. `config` must be the config PDA and its stored authority must match the
   signer;
2. `asset` is initialized at `[b"asset", mint]` and paid for by authority;
3. `authority` signs;
4. `mint_account` must be the supplied `mint` public key;
5. the mint account owner must equal the supplied token program;
6. `token_program` is the interface account for classic SPL Token or
   Token-2022;
7. `system_program` pays for account creation.

The handler records the mint and the token-program identity and sets the entry
to enabled.

#### `SetAssetStatus`

Accounts:

1. existing config PDA with the same authority;
2. mutable asset PDA derived from the asset's stored mint;
3. authority signer matching `asset.authority`.

The handler flips only `asset.enabled` and emits `AssetStatusChanged`.

### `create_mandate.rs`

#### `MandateParams`

This is the serialized instruction input. It contains the approved agent, source
token account, allowed mint, five policy numbers, a generated mandate nonce, and no wallet secret. The five
numbers are:

- maximum amount per payment;
- total amount;
- expiry slot;
- maximum payment count, where zero is unlimited;
- cooldown slots.

The nonce carries the `CPNONCE!` prefix, is included in the PDA seeds, and is
stored in the existing reserved compatibility field.

#### `CreateMandate`

The account checks run in this order conceptually:

1. `config` must be the config PDA;
2. `asset_registry` must be the asset PDA for `params.allowed_mint`;
3. the registry entry must be enabled;
4. the registry mint must equal `params.allowed_mint`;
5. the registry token program must equal the supplied token program;
6. `mandate` is initialized at
   `[b"mandate", owner, params.allowed_mint, params.mandate_nonce]`;
7. `owner` signs and pays rent;
8. `allowed_mint` must be the parameter mint and must belong to the supplied
   token program;
9. `source_token_account` must be the parameter source account, owned by the
   wallet owner, for the allowed mint, and owned by the same token program;
10. the token interface and system program are supplied for later compatibility
    and account creation.

The handler then validates the numeric and public-key parameters, writes the
mandate with zero spend and zero payment count, clears pause/revoke flags, stores
the PDA bump, emits `MandateCreated`, and returns.

Important: creating the mandate does not itself set the token delegate. The SDK
normally puts a token-program `approve_checked` instruction immediately after
the create instruction. The owner wallet signs that approval.

### `update_mandate.rs`

#### `MandateUpdate`

This input can change the approved agent, limits, expiry, count cap, cooldown,
and paused flag. It cannot change the mandate owner, mint, source token account,
or per-payment destination.

#### `UpdateMandate`

Accounts:

1. mutable mandate PDA supplied by the caller (new and legacy mandate PDAs are
   both supported);
2. owner signer checked by `has_one`.

The handler obtains the current slot and then checks:

1. revoked mandates cannot be updated;
2. the new agent is not the default public key;
3. the new per-payment limit is positive;
4. the new total limit covers both the per-payment limit and money already spent;
5. the new expiry is in the future;
6. the new payment-count cap is zero or is not below the count already used.

It writes the new fields and emits `MandateUpdated`. Because `paused` is part of
the update input, an owner can temporarily pause and later unpause through an
update. A revoked mandate cannot be unpaused.

### `pause_mandate.rs`

The context accepts only a mutable mandate PDA and its owner signer. The handler
rejects a revoked mandate, sets `paused = true`, emits the status event, and
returns. This is the immediate owner-controlled stop.

There is no separate `resume_mandate` instruction. The current resume path is an
owner-signed `update_mandate` with `paused = false` while the mandate is not
revoked.

### `revoke_mandate.rs`

The context is the same owner-only shape as pause. The handler sets both
`paused = true` and `revoked = true`, emits the status event, and returns.

There is no un-revoke instruction. `update_mandate` and `execute_payment` reject
the revoked state, so this is the permanent shutdown path.

### `execute_payment.rs`

#### `PaymentParams`

The payment input is:

1. `invoice_hash: [u8; 32]`;
2. `payment_id: [u8; 32]`;
3. `signature_reference: [u8; 32]`;
4. `amount: u64` in token base units.

The program does not calculate the invoice hash. The merchant, connector,
backend, SDK, or agent must agree on the bytes being hashed before creating the
request.

#### `ExecutePayment` account validation

The account order is important because the SDK and backend both mirror it:

| Position | Account | Why it is present |
| ---: | --- | --- |
| 0 | config | Confirms the protocol config PDA exists. |
| 1 | asset registry | Confirms the mandate mint is enabled and bound to this token program. |
| 2 | mandate | Mutable policy PDA; its counters change. |
| 3 | receipt | New receipt PDA; its seed includes the invoice hash. |
| 4 | agent | Mutable signer and must equal `mandate.approved_agent`. |
| 5 | allowed mint | Mint account for checked transfer and decimals. |
| 6 | source token account | Delegate-controlled source account. |
| 7 | recipient token account | Destination supplied by this payment. Legacy mandates may constrain it to their stored compatibility destination. |
| 8 | token program | Classic SPL Token or Token-2022. |
| 9 | system program | Pays for receipt PDA initialization. |

Anchor checks the following before the function body:

1. config is the config PDA;
2. asset registry is derived from the mandate mint;
3. the asset is enabled;
4. asset mint equals the mandate mint;
5. asset token program equals the supplied token program;
6. mandate is the PDA derived from `mandate.owner`;
7. receipt is a new PDA at `[b"receipt", mandate, invoice_hash]`;
8. agent is a signer and its address equals the approved agent;
9. mint equals `mandate.allowed_mint` and uses the supplied token program;
10. source equals `mandate.source_token_account`;
11. source is owned by the mandate owner;
12. source uses the mandate mint;
13. source's delegate is exactly the mandate PDA;
14. source's remaining delegated amount is at least the requested amount;
15. source uses the supplied token program;
16. recipient is the token account supplied by this payment; legacy mandates
    additionally require it to equal their stored compatibility destination;
17. recipient uses the mandate mint and token program.

#### `execute_payment` handler, one step at a time

1. Read the current Solana slot with `Clock::get()`.
2. Call `validate_payment` for status, expiry, amount, identifiers, limits,
   count, and cooldown.
3. Copy the mandate key, owner, and bump before mutating the account. These
   values are needed for the PDA signer and receipt.
4. Add the requested amount to `amount_spent` with checked arithmetic. Overflow
   becomes `TotalLimitExceeded`.
5. Add one to `payment_count` with checked arithmetic. Overflow also returns a
   policy error.
6. Build signer seeds for the mandate PDA.
7. Build `TransferChecked` with source, mint, recipient, and mandate authority.
8. Create a CPI context using the token program and the mandate signer seeds.
9. Call `token_interface::transfer_checked` with the requested amount and mint
   decimals. The token program performs the actual balance movement.
10. If the CPI succeeds, write the new spend total, count, and last-payment slot.
11. Fill the new receipt with all payment facts and status `1`.
12. Emit `PaymentExecuted`.
13. Return success.

If the transfer CPI or any later operation fails, Solana's transaction atomicity
rolls the whole instruction back. The balance, mandate counters, and receipt do
not remain half-updated.

### Token-2022 boundary

The program uses `anchor_spl::token_interface::transfer_checked`, and every
mint/token-account owner is compared to the same supplied token program. This is
why one code path supports both:

- classic SPL Token;
- basic Token-2022 mints.

The current code does not provide extension-specific remaining-account handling
for transfer hooks, confidential transfers, or other complex Token-2022 flows.
Those require more account resolution and dedicated tests. “Token-2022 is
supported” currently means the basic checked-transfer path tested in
`tests/settlement.rs`.

## Policy helpers: `src/policy.rs`

The policy module keeps repeated rules out of the handlers. `require!` returns
the first matching `ChainPayError` and stops the function.

### `validate_supported_mints`

For each of the three config slots it:

1. skips a default public key, treating it as an empty slot;
2. marks that at least one real mint exists;
3. checks that the current mint did not appear earlier;
4. returns `InvalidSupportedMintList` for duplicates;
5. after the loop, rejects a list with no real mint;
6. returns `Ok(())` for a non-empty, unique list.

### `is_supported_mint`

This function checks whether a mint appears in `ProtocolConfig.supported_mints`.
It is currently not called by any production instruction. The config list is
validated and stored, but asset registration and payment authorization currently
use the `SupportedAsset` PDA's enabled flag and token-program binding as the
operational gate.

This is an important code-reading distinction: the existence of a helper does
not mean the helper is enforcing a rule. A future hardening change could call it
from asset registration or add a deliberate reason for keeping the two registries
separate.

### `validate_mandate_params`

It checks, in order:

1. approved agent is non-default;
2. source token account is non-default;
3. allowed mint is non-default;
4. per-payment limit is greater than zero;
5. total limit is at least the per-payment limit;
6. expiry is after the current slot;
7. payment count is zero or at least one.

The last check is effectively always true for a `u64`: the only value below one
is zero, which the left side explicitly accepts. It documents the intended
meaning of zero, but it does not reject any possible `u64`.

### `validate_payment`

It checks, in order:

1. mandate is not revoked;
2. mandate is not paused;
3. mandate has not expired;
4. amount is positive;
5. amount is at or below `max_per_payment`;
6. invoice hash is not all zeroes;
7. payment ID is not all zeroes;
8. signature reference is not all zeroes;
9. `amount_spent + amount` does not overflow and stays within `total_limit`;
10. `payment_count + 1` does not overflow;
11. if a count cap exists, the new count stays within it;
12. if this is not the first payment, the current slot is at least
    `last_payment_slot + cooldown_slots`.

This helper does not check the agent, mint, source, recipient, token program, or
receipt address. Those are account constraints in `execute_payment`. The policy
is split intentionally: values are checked in the helper, identities and account
relationships are checked by Anchor.

### Policy tests

The private test builders `valid_mandate_params`, `valid_mandate`, and
`valid_payment` make safe baseline values. The tests then prove:

- valid unique mint lists pass;
- empty and duplicate lists fail;
- valid mandate parameters pass;
- invalid limits and expiry fail;
- paused, revoked, and expired mandates fail payment validation;
- per-payment, total, count, and cooldown limits fail when exceeded;
- zero invoice, payment, and signature identifiers fail.

These are pure Rust tests. They do not need a validator because they call the
policy functions directly.

## Error handling: `src/errors.rs`

`ChainPayError` is an Anchor error enum. Each variant becomes a stable program
error code with a readable message. There are three layers of error handling in
the contract.

### Layer 1: account constraints

An invalid account relationship fails before the handler runs. Examples:

- wrong authority: `InvalidConfigAuthority` or `InvalidAssetAuthority`;
- disabled asset: `AssetNotEnabled`;
- wrong token program: `InvalidTokenProgram`;
- wrong source account: `InvalidSourceTokenAccount`;
- wrong source mint: `InvalidSourceMint`;
- wrong recipient mint: `InvalidRecipientMint`.

### Layer 2: explicit handler/policy checks

`require!(condition, Error)` is used for state and parameter checks. Examples:

- paused or revoked mandate;
- expired mandate;
- amount or limits outside policy;
- all-zero replay identifiers.

The first failed `require!` returns immediately. A caller should therefore treat
the returned error as the first failed gate, not as a complete list of all
problems.

### Layer 3: fallible operations and arithmetic

The `?` operator propagates errors from:

- `Clock::get()`;
- token-program CPI;
- checked integer addition converted into a ChainPay error.

The payment handler calculates new totals before changing the account and calls
the transfer CPI before committing the new counters. Combined with Solana's
transaction atomicity, this prevents partial settlement state.

### Error list grouped by purpose

| Group | Errors |
| --- | --- |
| Configuration/assets | `InvalidConfigAuthority`, `UnsupportedMint`, `InvalidSupportedMintList`, `AssetNotEnabled`, `InvalidAssetAuthority`, `InvalidTokenProgram` |
| Identity/accounts | `InvalidAgent`, `InvalidSourceTokenAccount`, `InvalidSourceMint`, `InvalidRecipientMint`, `InvalidRecipient`, `InvalidMint` |
| Mandate creation/update | `InvalidPerPaymentLimit`, `InvalidTotalLimit`, `InvalidExpiry` |
| Mandate/payment state | `MandatePaused`, `MandateRevoked`, `MandateExpired` |
| Amount and counters | `InvalidPaymentAmount`, `AmountExceedsPerPayment`, `TotalLimitExceeded`, `PaymentCountExceeded`, `PaymentCooldownActive` |
| Replay/request identity | `InvalidInvoiceHash`, `InvalidPaymentId`, `InvalidSignatureReference` |

`UnsupportedMint` exists as an error variant but is not currently emitted by a
production handler. The current asset gate uses `AssetNotEnabled`, mint equality,
and token-program equality.

## Each public contract instruction

This section gives the handler-level story without repeating every account
constraint already listed above.

### `initialize_config`

1. Receive the new config PDA, authority signer, and three mint slots.
2. Validate that the list is non-empty and unique.
3. Set config authority to the signer.
4. Store the three slots.
5. Store Anchor's config bump.
6. Emit `ConfigInitialized`.
7. Return `Ok(())`.

### `update_config`

1. Anchor proves the caller owns the existing config authority.
2. Validate the replacement list.
3. Replace `supported_mints`.
4. Emit `ConfigUpdated`.
5. Return.

### `register_asset`

1. Anchor proves the authority owns the config and the mint account is owned by
   the supplied token program.
2. Initialize the asset PDA for the mint.
3. Store authority, mint, token program, `enabled = true`, and bump.
4. Emit `AssetRegistered`.
5. Return.

### `set_asset_status`

1. Anchor proves the config authority also owns the asset entry.
2. Set `enabled` to the requested boolean.
3. Emit `AssetStatusChanged`.
4. Return.

### `create_mandate`

1. Read the current slot.
2. Validate the requested policy fields.
3. Write owner, agent, source, mint, store the nonce marker, and write the limits.
4. Initialize spent amount, payment count, and last slot to zero.
5. Initialize pause/revoke to false.
6. Store the bump.
7. Emit `MandateCreated`.
8. Return. The separate token delegate approval must be signed by the owner.

### `update_mandate`

1. Read the current slot.
2. Reject revoked state and invalid replacement values.
3. Write the allowed mutable policy fields.
4. Emit `MandateUpdated`.
5. Return.

### `pause_mandate`

1. Anchor proves owner authority.
2. Reject an already revoked mandate.
3. Set `paused = true`.
4. Emit status.
5. Return.

### `revoke_mandate`

1. Anchor proves owner authority.
2. Set `paused = true`.
3. Set `revoked = true`.
4. Emit status.
5. Return.

### `execute_payment`

1. Read current slot.
2. Run policy checks.
3. Compute new totals with overflow protection.
4. Create mandate PDA signer seeds. New accounts use the stored nonce; old
   accounts fall back to the mint-scoped or legacy seed layout.
5. Invoke `transfer_checked` through the selected token program.
6. Update counters only after the transfer returns successfully.
7. Create the receipt data.
8. Emit settlement event.
9. Return.

## Serialization and account bytes

Anchor serializes instruction arguments in little-endian form for integers and
adds an eight-byte instruction discriminator. The SDK manually mirrors this in
`sdk/src/encoding.ts`.

### Instruction data sizes

| Instruction | Data size including 8-byte discriminator |
| --- | ---: |
| `initialize_config` | 104 bytes |
| `update_config` | 104 bytes |
| `register_asset` | 40 bytes |
| `set_asset_status` | 9 bytes |
| `create_mandate` | 176 bytes |
| `update_mandate` | 113 bytes |
| `pause_mandate` | 8 bytes |
| `revoke_mandate` | 8 bytes |
| `execute_payment` | 112 bytes |

The SDK also constructs token-program instructions that are not ChainPay
handlers:

- `approve_checked`: discriminator, u64 delegate amount, decimals;
- `revoke_delegate`: token-program revoke instruction;
- associated-token-account creation when a caller needs an ATA.

### Account byte offsets

The offsets below include the eight-byte Anchor account discriminator.

#### `ProtocolConfig` (137 bytes)

```text
0..8       discriminator
8..40      authority
40..72     supported_mints[0]
72..104    supported_mints[1]
104..136   supported_mints[2]
136        bump
```

#### `SupportedAsset` (106 bytes)

```text
0..8       discriminator
8..40      authority
40..72     mint
72..104    token_program
104        enabled
105        bump
```

#### `PaymentMandate` (235 bytes)

```text
0..8       discriminator
8..40      owner
40..72     approved_agent
72..104    source_token_account
104..136   allowed_mint
136..168   legacy_allowed_recipient (reserved compatibility field)
168..176   max_per_payment
176..184   total_limit
184..192   amount_spent
192..200   payment_count
200..208   expires_at_slot
208..216   max_payment_count
216..224   cooldown_slots
224..232   last_payment_slot
232        paused
233        revoked
234        bump
```

#### `PaymentReceipt` (282 bytes)

```text
0..8       discriminator
8..40      mandate
40..72     invoice_hash
72..104    payment_id
104..136   mint
136..168   source_token_account
168..200   recipient_token_account
200..208   amount
208..240   agent
240..248   executed_at_slot
248..280   signature_reference
280        status
281        bump
```

### Explain it like I am five: serialization

The program and SDK must agree on how to pack a lunchbox. If the program expects
the amount in slots 104–112 but the SDK puts it somewhere else, the program
reads the wrong number. Discriminators are labels on the lunchbox that stop us
from opening a receipt and pretending it is a mandate.

The layout tests and SDK tests exist to catch these “same bytes, different
meaning” mistakes.

## Tests: `programs/chainpay/tests`

### `layout.rs`

`mandate_and_receipt_have_stable_layout_constants` verifies the four `LEN`
constants:

- mandate payload: 227;
- receipt payload: 274;
- config payload: 129;
- supported asset payload: 98.

`mandate_and_receipt_pdas_use_the_documented_seeds` derives a random mandate
and receipt and confirms they are valid, distinct, and not default addresses.

### `settlement.rs` helper functions

The settlement test deliberately runs the same scenario twice: once with the
classic SPL Token program and once with Token-2022.

#### `TokenKind::program_id`

Returns the token program ID selected by the enum variant.

#### `TokenKind::initialize_mint`

Builds the correct mint initialization instruction for the selected token
program, with six decimals and the owner as mint authority.

#### `TokenKind::initialize_account`

Builds the selected token program's token-account initialization instruction.
The source is owned by the wallet owner; the recipient is owned by a separate
merchant owner.

#### `TokenKind::mint_to`

Creates a test mint-to instruction so the source account starts with funds.

#### `TokenKind::approve`

Approves the mandate PDA as delegate for the source account. This is the key
permission bridge between the owner's wallet and the program-controlled payment.

These four methods have the same shape because classic SPL and Token-2022 expose
parallel instruction APIs. The enum keeps the test scenario generic.

#### `submit`

1. Uses the first signer as the transaction fee payer.
2. Creates a legacy Solana message from the instructions.
3. Signs with the provided keypairs and the LiteSVM blockhash.
4. Sends the transaction and unwraps the result.

#### `chainpay_instruction`

Converts Anchor-generated account metas and instruction data into a raw Solana
instruction with `chainpay::ID` as the program ID. This proves the account
contexts and serialized arguments are usable without a high-level client.

#### `token_balance`

Reads a token account from LiteSVM and decodes the SPL-compatible amount bytes
at the token account balance offset. It is a test-only balance assertion helper.

#### `program_path`

Points LiteSVM at the built SBF artifact in `target/deploy/chainpay.so`.

#### `run_settlement`

This is the shared scenario:

1. Start a fresh LiteSVM instance.
2. Load the ChainPay SBF program.
3. Generate owner, agent, source, recipient, mint, and merchant identities.
4. Derive config, asset, mandate, and receipt PDAs.
5. Airdrop SOL to owner and agent.
6. Create and initialize the selected token mint.
7. Create source and recipient token accounts.
8. Mint 1,000 base units to the source.
9. Initialize config with the test mint in the first slot.
10. Register the mint in the asset registry.
11. Create a mandate allowing a 250-unit payment and a 1,000-unit total.
12. Approve the mandate PDA as delegate for 1,000 units.
13. Execute a 250-unit payment signed by the approved agent.
14. Assert the recipient received 250 units and the receipt exists.
15. Try the same invoice again with a different payment ID and signature
    reference. The existing receipt PDA makes the transaction fail.
16. Try a different invoice with an amount above the per-payment limit. Policy
    validation makes it fail and no invalid receipt is created.
17. Assert the recipient balance remains 250.

The final two tests call this function with `TokenKind::Spl` and
`TokenKind::Token2022`. The shared scenario is evidence that the payment logic
is token-program agnostic at the interface boundary, not evidence that every
Token-2022 extension is supported.

## SDK connection: how TypeScript reaches the program

The SDK never receives a keypair or seed phrase. It prepares instructions and
lets a wallet or approved signer own the signing step.

### `sdk/src/constants.ts`

This file centralizes the program ID, Devnet RPC, system/token program IDs,
instruction discriminators, account discriminators, PDA seed strings, and
receipt status. If a discriminator changes in Anchor, this file must change with
it.

### `sdk/src/pda.ts`

The four exported functions derive config, mandate, receipt, and asset addresses.
They must use the exact same seed order as the Rust account constraints.

### `sdk/src/encoding.ts`

Reusable functions do the following:

- validate and normalize public keys;
- validate exactly 32-byte hashes;
- encode/decode little-endian u64 values with `bigint`;
- check account discriminators and data lengths;
- read public keys, bytes32 values, u8 values, and u64 values;
- create account metadata with signer/writable flags;
- map `spl-token` and `token-2022` labels to program IDs;
- concatenate instruction byte segments;
- encode every ChainPay instruction and token delegate operation.

The `meta` helper is repeated everywhere because each instruction needs the same
three facts about an account: address, signer status, and writable status.

### `sdk/src/accounts.ts`

The decoders read raw program account bytes:

1. convert Buffer/Uint8Array to Uint8Array;
2. verify the correct eight-byte discriminator;
3. verify minimum length;
4. read fields at their documented offsets;
5. convert the values to friendly SDK objects.

`decodeMandate` also computes a convenient status:

1. revoked wins;
2. otherwise paused wins;
3. otherwise an expired slot is expired;
4. otherwise active.

`decodePaymentReceipt` maps on-chain status `1` to SDK status `confirmed` and
other values to `failed`.

### `sdk/src/mandate.ts`

#### `validateMandateInput`

Checks addresses, u64 ranges, positive per-payment limit, total-limit ordering,
positive expiry, and optional delegate amount.

#### `buildCreateMandateInstruction`

1. Validate input.
2. Generate or validate the mandate nonce, then derive config, asset, and the
   nonce-scoped mandate PDA.
3. Map the token label to a token program address.
4. Build the nine account metas in Rust's `CreateMandate` order.
5. Encode `MandateParams`, including the nonce used in the PDA seeds.

#### `buildRegisterAssetInstruction` and `buildSetAssetStatusInstruction`

Derive the config and asset PDAs, mark the correct mutable/signer accounts, and
encode the small asset instruction data.

#### `buildApproveDelegateInstruction`

Builds a token-program instruction, not a ChainPay instruction. It defaults the
delegate amount to the mandate total limit and approves the mandate PDA.

#### `buildRevokeDelegateInstruction`

Builds a token-program revoke instruction signed by the owner.

#### `buildCreateMandateTransaction`

Builds two instructions in one owner-signed transaction:

1. create the mandate PDA;
2. approve the mandate PDA as token delegate.

The owner is both signer and fee payer.

#### `buildUpdateMandateInstruction`, `buildPauseMandateInstruction`, and
`buildRevokeMandateInstruction`

Each derives the mandate PDA, sets account flags, encodes the matching
instruction, and returns a transaction plan requiring the owner signature.

### `sdk/src/payment.ts`

#### `preparePayment`

Validates addresses, all three 32-byte identifiers, and positive amount, then
copies byte arrays so callers cannot mutate the prepared request accidentally.

#### `buildExecutePaymentInstruction`

1. Validate the agent public key.
2. Confirm the request mandate equals the loaded mandate address.
3. Require a known token-program label.
4. Derive config, asset, mandate, and receipt addresses.
5. Build the ten account metas in the exact Rust order.
6. Encode the three identifiers and amount.

#### `preflightPayment`

Runs a friendly local checklist for status, agent, mint, recipient, amount,
limits, count, cooldown, expiry, non-zero identifiers, duplicate receipt, and
token program. It returns every check rather than stopping at the first one, so
an agent/UI can explain why a quote failed.

This is a convenience check, not the authority. The program repeats the critical
checks on-chain.

#### `preparedPaymentTransaction`

Wraps one payment instruction and marks the agent as signer and fee payer.

### `sdk/src/client.ts`

`ChainPayClient` is the orchestration object:

- constructor chooses an injected `Connection` or creates one from RPC options;
- `getCurrentSlot` reads the current slot;
- `getConfig` derives config, fetches the program-owned account, and decodes it;
- `getMandate` fetches and decodes a mandate, then inspects the source account to
  infer classic SPL versus Token-2022;
- `getSupportedAsset` derives and decodes an asset entry;
- `getPayment` accepts either a receipt address or mandate plus invoice hash;
- `getTokenProgram` inspects an account owner and rejects unsupported programs;
- `getMintDecimals` reads the mint owner and decimals byte;
- `buildCreateMandate` verifies mint/source use the requested token program before
  preparing the owner transaction;
- `buildUpdateMandate`, `buildRegisterAsset`, `buildSetAssetStatus`,
  `buildPauseMandate`, `buildRevokeMandate`, and `buildRevokeDelegate` wrap the
  lower-level builders and declare required signers;
- `preparePayment` loads the mandate, detects token program, constructs the
  request, derives the receipt, checks for an existing receipt, runs preflight,
  and returns instruction plus transaction plan;
- `simulate` calls the SDK Solana simulation helper;
- `executePayment` simulates first, stops on simulation failure, submits through
  an injected adapter, optionally confirms, and returns a structured result;
- private `getProgramAccount` ensures the account is actually owned by the
  ChainPay program before decoding it.

### `sdk/src/solana.ts`

This converts the SDK's neutral instruction format to `web3.js` objects, adds a
recent blockhash and fee payer, and calls `simulateTransaction`. It does not sign
or submit by itself.

### `sdk/src/payment-request.ts`

This is the merchant-signed request verifier used by `verify_payment_request`:

1. order payload fields into a canonical JSON object;
2. validate version, cluster, invoice/nonce, amount, decimals, token program,
   addresses, and optional expiry;
3. decode the Ed25519 signature;
4. verify it with the merchant public key;
5. hash the exact canonical bytes with SHA-256;
6. return the invoice hash or a readable failure.

The Rust backend implements the corresponding verification boundary. If a
request is sent to the backend, the MCP tool prefers the backend result.

### `sdk/src/receipt.ts`

Contains receipt reference creation, receipt PDA derivation, receipt decoding
re-export, and strict hex/byte conversion helpers.

### `sdk/src/token.ts`

Derives associated token accounts using owner, token program, and mint, and
builds the associated-token-account creation instruction. The token-program
seed is why classic SPL and Token-2022 addresses do not get accidentally mixed.

### `sdk/src/types.ts`

Defines the neutral transaction, mandate, payment, receipt, preflight, and
adapter shapes used by all SDK consumers. `bigint` is used for token amounts and
slots so JavaScript does not silently lose precision above `2^53 - 1`.

## Rust backend connection

The backend is an orchestration and relay boundary. It cannot override a failed
on-chain policy check.

### Startup: `backend/src/main.rs` and `lib.rs`

`main`:

1. reads `BackendConfig` from environment;
2. creates a `StatusStore` from the optional status file;
3. creates `BackendState`, including an RPC client;
4. starts Axum with graceful shutdown.

`lib.rs` declares the modules and re-exports the public API, backend state,
router, and payment status.

### `backend/src/server.rs`

#### Configuration

`BackendConfig::from_env` reads host, port, Devnet-only cluster, program ID, RPC
URL/commitment, confirmation timeout, poll interval, auth token, and CORS
origins. Invalid ports, non-Devnet clusters, and malformed durations return
`ConfigError`.

`parse_duration_secs` enforces at least one second. `parse_duration_ms` enforces
at least 50 milliseconds. `BackendState::new` constructs the RPC client.

#### `build_router`

Registers:

| Route | Purpose |
| --- | --- |
| `GET /healthz` | Health and cluster/program identity. |
| `GET /v1/config` | Backend cluster/program config. |
| `POST /v1/payment-requests/verify` | Verify merchant-signed payment demand. |
| `GET /v1/rpc/latest-blockhash` | Get a recent blockhash. |
| `POST /v1/payments` | Validate, simulate, submit, and finalize a payment. |
| `GET /v1/payments/{payment_id}` | Read stored payment status. |
| `POST /v1/transactions/submit` | Generic signed transaction relay. |
| `GET /v1/transactions/{transaction_id}` | Read generic transaction status. |
| `POST /rpc` | Allowlisted read/simulation RPC proxy. |

It also attaches authentication middleware, CORS, body limits, and request
tracing.

#### `auth_middleware`

Allows CORS preflight, health, signed RPC relay, and empty-token development mode.
For other routes with a configured token, it requires the exact
`Authorization: Bearer ...` value.

The wallet-signed relay routes are intentionally open to the relay middleware
because the transaction's cryptographic signatures are checked later.

#### `verify_payment_request`

1. Serialize the payload exactly as received.
2. Hash those canonical bytes for the returned invoice hash.
3. Reject unsupported version or cluster.
4. Require invoice and nonce.
5. Allow only `spl-token` or `token-2022`.
6. Require a positive u64 amount string.
7. Validate merchant, mint, and recipient as 32-byte base58 addresses.
8. Validate optional expiry against the current RPC slot.
9. Decode merchant public key and base64 Ed25519 signature.
10. Verify the signature over the canonical bytes.
11. Return `valid: true` and the hash, or `valid: false` with a reason.

This authenticates the merchant's request. It does not execute a payment.

#### `submit_payment`

1. Validate strings, invoice hash format, transaction size, transaction
   decoding, signatures, and ChainPay instruction fields.
2. Return an existing record if the idempotency key was already used.
3. Create a deterministic payment record in `prepared` state.
4. Simulate the already-signed transaction with signature verification.
5. If simulation fails, persist `failed` and return the diagnostic.
6. Send the signed transaction to Solana RPC.
7. Persist the returned transaction signature in `submitted` state.
8. Poll until finalized or an error/timeout.
9. Persist `confirmed` with slot, or `failed` with the error.

The backend sends `sendTransaction` with `skipPreflight: true` only after its own
explicit simulation step has succeeded. The chain program still validates the
transaction during actual execution.

#### `validate_payment_request`

Checks non-empty idempotency key, mandate, invoice hash, and signed transaction;
requires exactly 32-byte hex invoice hash; rejects oversized transactions; then
delegates to `validate_chainpay_transaction`.

#### `validate_chainpay_transaction`

1. Deserialize a versioned Solana transaction.
2. Sanitize its message.
3. Verify its signatures.
4. Scan instructions for the configured ChainPay program and the execute-payment
   discriminator.
5. Require the expected data length and account positions.
6. Compare the embedded mandate and invoice hash to the HTTP request.
7. If supplied, compare receipt, agent, mint, recipient, token program, and
   amount too.
8. Reject the request if no matching execute-payment instruction exists.

This binds the backend's JSON metadata to the wallet-signed bytes rather than
trusting the JSON alone.

#### Generic transaction relay

`submit_transaction` follows the same idempotent flow for a generic signed
transaction, but it validates only base64/size/transaction decoding. It does not
apply ChainPay payment-specific account binding.

#### Small server helpers

- `validate_transaction_request`: validates generic relay input;
- `validate_string`: rejects empty strings;
- `decode_transaction`: base64-decodes and enforces byte size;
- `simulation_summary`: converts RPC simulation data to API data;
- `fail_payment` and `fail_transaction`: set failed state, error, optional
  simulation, and update time;
- `deterministic_id`: hashes an idempotency key and adds a namespace prefix;
- `hex_encode`: renders bytes as lowercase hex;
- `now_ms`: returns Unix milliseconds;
- `to_blockhash_response`: maps RPC blockhash data to HTTP JSON naming.

`ApiError` maps bad input to 400, missing records to 404, auth failures to 401,
RPC failures to 502, and storage failures to 500.

### `backend/src/rpc/mod.rs`

`RpcClient` is a small JSON-RPC client:

- `new` creates an HTTP client;
- `config` exposes RPC settings;
- `latest_blockhash` calls `getLatestBlockhash`;
- `current_slot` calls `getSlot`;
- `simulate_signed_transaction` calls `simulateTransaction` with base64,
  signature verification, and the configured commitment;
- `send_transaction` calls `sendTransaction` with retries;
- `signature_status` calls `getSignatureStatuses`;
- `wait_for_finalized` polls until finalized, transaction error, or timeout;
- `forward_proxy` allows only the read/simulation method allowlist;
- private `call` creates the JSON-RPC envelope, handles HTTP/JSON/RPC errors,
  and requires a result field.

`RpcError` separates transport, decode, remote RPC, transaction failure,
confirmation timeout, unsupported proxy method, and missing-result errors.

### `backend/src/status/mod.rs`

Defines off-chain lifecycle statuses:

```text
prepared -> submitted -> confirmed
                    \-> failed
```

`PaymentRecord` adds public metadata, signature, slot, simulation, and timestamps
to a payment. `TransactionRecord` is the generic relay equivalent.

These statuses describe backend observation. The on-chain receipt's status byte
and the Solana transaction itself remain the settlement evidence.

### `backend/src/storage/mod.rs`

`StatusStore` keeps payment and transaction records in an async `RwLock`.

- `in_memory` creates a process-local store;
- `from_env` reads `CHAINPAY_STATUS_FILE`;
- `from_path` loads existing JSON if present;
- getters read by ID;
- idempotency finders scan records by key;
- `put_payment` and `put_transaction` update memory and persist a snapshot;
- private `persist` writes JSON to a temporary file and renames it atomically;
- `path` exposes the configured path.

The store deliberately contains public metadata and lifecycle state only. It
does not receive wallet keys or seed phrases.

## MCP connection

The MCP server is the agent-facing interface. It prepares data and transactions;
it does not magically sign them.

### `mcp-server/src/index.ts`

`createDefaultContext` constructs the SDK client from environment variables and
adds optional backend URL/auth. `callTool` maps a discovered tool name to the
corresponding implementation. Unknown names throw an error.

Current tools:

```text
get_mandate
get_protocol_config
get_asset
create_mandate
update_mandate
prepare_payment
quote_payment
verify_payment_request
prepare_x402_payment
execute_payment
wait_for_payment
get_payment
pause_mandate
revoke_mandate
```

### `mcp-server/src/server.ts`

`createMcpServer` handles JSON-RPC methods:

- `initialize`: negotiates protocol version and advertises tools;
- `ping`: returns an empty success object;
- `tools/list`: returns `TOOL_DEFINITIONS`;
- `tools/call`: validates a tool name and object arguments, then calls the tool;
- notifications return no body;
- unknown methods return JSON-RPC method-not-found;
- thrown tool errors become JSON-RPC internal errors.

`runStdioServer` reads one JSON-RPC object per line and writes one response per
line.

### `mcp-server/src/http.ts`

The HTTP server adds the deployed remote interface:

- `GET /` and `GET /docs` serve the documentation;
- `GET /healthz` reports transport health;
- `GET /tools` lists discoverable tools without a JSON-RPC request body;
- `GET /mcp` opens the streamable HTTP event stream;
- `POST /mcp` handles JSON-RPC MCP calls;
- `OPTIONS` handles CORS preflight;
- `/logo.svg` and `/og-image.png` serve branding assets.

It enforces body size, optional bearer auth, allowed origins, MCP header/request
consistency, and JSON-RPC object shape. `readJsonBody` is deliberately strict:
the endpoint expects one JSON-RPC object, not an arbitrary array or primitive.

### MCP tool pattern

Most tools use the same pattern:

1. parse and normalize input;
2. call the SDK or backend;
3. return JSON-safe data, converting `bigint` and byte arrays;
4. set `isError` when a policy or transport operation failed.

`common.ts` contains this shared behavior: required strings, Solana addresses,
u64 parsing, 32-byte hex parsing, token-program labels, JSON-safe conversion,
transaction serialization, and `toolResult`.

### Payment tools

- `quote_payment`: loads the mandate, runs SDK preflight, and returns the quote
  without signing or submitting;
- `prepare_payment`: returns the preflight and an agent-signature transaction;
- `execute_payment`: preflights, then either sends a supplied signed transaction
  to the Rust backend or uses an injected `PaymentSubmissionAdapter`;
- `wait_for_payment`: polls backend status until confirmed/failed or a bounded
  timeout;
- `get_payment`: fetches a receipt by address or mandate plus invoice hash.

If no signed transaction or adapter is supplied, execution returns a clear
“external signer required” result. That is a safety boundary, not a missing
automatic wallet.

### Owner and asset tools

- `create_mandate` returns a transaction containing owner-signed creation and
  delegate approval;
- `update_mandate` returns an owner-signed update plan;
- `pause_mandate` returns an owner-signed immediate pause plan;
- `revoke_mandate` returns an owner-signed permanent revocation plan;
- `get_protocol_config` and `get_asset` read public on-chain state.

### Merchant-signed request tool

`verify_payment_request` uses the Rust backend verifier when configured. Otherwise
it uses the SDK verifier and current slot. It authenticates payment demand before
the separate mandate/preflight/settlement path.

### x402 connector: `tools/x402.ts`

The current connector supports only Solana Devnet and the x402 `exact` scheme.
Its steps are:

1. accept a challenge;
2. normalize `network`, scheme, asset/mint, pay-to recipient, amount, resource,
   nonce, optional expiry, and token program;
3. reject unsupported networks or schemes;
4. create a deterministic canonical challenge string;
5. hash it into an invoice hash;
6. derive payment ID and signature reference from that invoice hash;
7. reject an expired challenge;
8. pass the resulting payment request to the normal SDK mandate/preflight path;
9. either relay an externally signed transaction through `/v1/payments` or return
   a transaction requiring an external signer.

The connector boundary is therefore:

```text
x402 challenge
    -> normalized deterministic ChainPay payment request
    -> mandate checks
    -> wallet/agent signature
    -> optional Rust backend relay
    -> ChainPay execute_payment
    -> receipt PDA
```

x402 does not bypass policy, custody keys, or become a hosted facilitator. It is
one connector translating payment demand into the same ChainPay primitive.

## One real payment, end to end

Here is the order to follow while debugging a direct payment:

1. The protocol authority initializes config.
2. The authority registers the mint and token-program binding.
3. The owner creates a mandate.
4. The owner approves the mandate PDA as a limited token delegate.
5. A merchant, agent, or connector creates a non-zero invoice hash, payment ID,
   and signature reference.
6. The agent calls MCP `quote_payment` or `prepare_payment`.
7. MCP calls the SDK.
8. SDK reads the mandate and source token account, derives receipt PDA, and runs
   local preflight.
9. An external wallet/signer signs the prepared payment transaction as the
   approved agent.
10. MCP can send that base64 transaction to the Rust backend.
11. Backend binds HTTP metadata to the signed instruction, simulates, sends, and
    polls finality.
12. Solana runs Anchor account constraints and `validate_payment` again.
13. ChainPay signs the token CPI with the mandate PDA.
14. SPL Token or Token-2022 moves the base units.
15. ChainPay increments counters and creates the receipt PDA.
16. Backend returns signature/status; SDK/MCP can read the receipt PDA directly.

### Where each rule is enforced

| Rule | SDK preflight | Backend binding | On-chain program |
| --- | :---: | :---: | :---: |
| approved agent | yes | optional metadata match | yes, signer + address |
| allowed mint | yes | optional metadata match | yes |
| per-payment recipient | yes | exact signed-transaction match | yes |
| token program | yes | optional metadata match | yes |
| amount positive/limits | yes | optional amount match | yes |
| pause/revoke/expiry | yes | simulation observes it | yes |
| cooldown/count/total | yes | simulation observes it | yes |
| duplicate invoice | yes, if receipt read | simulation/account init | yes, receipt PDA `init` |
| merchant signature | yes/backend verifier | yes/backend verifier | no; the program receives derived identifiers |

The repeated checks are intentional defense in depth. Only the on-chain checks
control whether funds move.

## Repeated patterns explained once

### `require!` everywhere

ELI5: a security guard asks one question at a time. If the answer is “no,” the
guard stops the visitor immediately. `require!` is that guard.

### `#[account(...)]` everywhere

ELI5: before a recipe starts, the kitchen checks that the ingredients are the
right ingredients. The handler can then cook with those verified ingredients.

### `Pubkey::default()` checks

ELI5: the all-zero address is an empty seat, not a real person. These checks stop
an important role from being assigned to an empty seat.

### `checked_add`

ELI5: the counter refuses to roll over from a huge number back to zero. If adding
would wrap, payment stops.

### `Box<Account<...>>` versus `Account<...>`

Boxing moves the larger account wrapper to the heap and can help stack usage. It
does not change authority or ownership semantics.

### `InterfaceAccount` and `TokenInterface`

ELI5: instead of building two almost-identical cash registers, the program uses
one socket shape that accepts either the classic token program or Token-2022,
then checks that every connected piece uses the same program.

### `bigint` and `u64`

Token amounts are integer base units. TypeScript uses `bigint`; Rust uses `u64`.
Never use ordinary JavaScript `number` for a large token amount.

### `toolResult`

Every MCP tool turns internal data into JSON-safe output. ELI5: it puts the
answer into a parcel that JSON can carry, replacing a bigint with text and bytes
with hex.

### Idempotency at two boundaries

The backend uses an HTTP idempotency key so retries return the same status record.
The program uses the receipt PDA so retries cannot settle the same invoice twice.
The backend protects service bookkeeping; the receipt protects funds.

## Important current-state observations

These are not guesses; they follow from reading the current files.

1. The program is Devnet-oriented. `BackendConfig` rejects a non-Devnet cluster,
   and the default RPC is Solana Devnet.
2. The program supports classic SPL Token and basic Token-2022 checked transfers.
   Token-2022 extension-heavy flows are not implemented.
3. The wallet owner remains responsible for mandate creation and token delegate
   approval. MCP does not hold a private key.
4. A payment's `signature_reference` is not automatically the enclosing Solana
   transaction signature. The caller supplies it; the backend later records the
   actual signature in off-chain status.
5. `payment_id` is stored but is not part of the receipt PDA seeds. The current
   replay barrier is the invoice hash, not payment ID uniqueness.
6. `ProtocolConfig.supported_mints` is validated and exposed, but
   `is_supported_mint` currently has no production caller. The enabled
   `SupportedAsset` PDA is the active asset gate.
7. The SDK's `decodeProtocolConfig` requires at least 145 bytes, while the Rust
   layout calculates a 137-byte full account. It reads the bump at the correct
   136 offset, but the minimum-length check is stricter than the account layout
   and should be reviewed.
8. Backend payment metadata fields such as agent, mint, token program, and amount
   are optional; when present, they are bound to the signed instruction. The
   recipient is required and is always bound to account position 7. The program
   remains the final check for all account relationships.
9. The generic `/v1/transactions/submit` route is broader than the payment route;
   it validates a signed transaction but does not require an execute-payment
   instruction.
10. x402 is implemented as a Devnet exact-scheme normalizer and relay path. The
    code does not make Stripe, PayPal, Visa, or other roadmap connectors live.

## Suggested reading order for a new design

Read these in order and keep the account tables above beside you:

1. `programs/chainpay/src/state.rs`
2. `programs/chainpay/src/errors.rs`
3. `programs/chainpay/src/instructions/create_mandate.rs`
4. `programs/chainpay/src/instructions/execute_payment.rs`
5. `programs/chainpay/src/policy.rs`
6. `programs/chainpay/src/lib.rs`
7. `programs/chainpay/tests/settlement.rs`
8. `sdk/src/pda.ts` and `sdk/src/encoding.ts`
9. `sdk/src/accounts.ts` and `sdk/src/payment.ts`
10. `sdk/src/client.ts`
11. `backend/src/server.rs` and `backend/src/rpc/mod.rs`
12. `mcp-server/src/index.ts`, `server.ts`, and the payment tools

After that, read the UI and docs as consumers of the boundaries above. If a new
design changes who can spend, what can be spent, where it can go, or how replay
is prevented, start with the on-chain account and constraint design before
changing the frontend or MCP wording.

## Verification commands

From the repository root:

```bash
cargo fmt --all -- --check
cargo test --workspace
cargo check --workspace
npm run check
npm --prefix sdk run test
npm --prefix mcp-server run test
```

For the real contract artifact and both token-program settlement tests, use the
matching Anchor binary configured by the repository:

```bash
make ANCHOR=/home/stephen/.avm/bin/anchor-1.1.2 contract-smoke
```

These commands build and test. They do not replace a separately approved Devnet
deployment or wallet-signing step.
