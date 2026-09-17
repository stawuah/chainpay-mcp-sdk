# How settlement works

ChainPay transfers tokens from an owner's source token account to a recipient
through Solana's token program. The owner approves a spending mandate; the
program checks that mandate before calling `transfer_checked` and recording a
receipt.

The implementation supports classic SPL Token and compatible Token-2022
transfers. Local settlement tests exercise both programs with demonstration
mints. This is not evidence of accepted mainnet USDC/PYUSD payments or merchant
delivery. See [implementation status](../project/implementation-status.md) for
the distinction between code, tests, deployment, and live verification.

## The payment path

```text
Owner approves mandate + token delegate
                ↓
Agent requests an exact amount, mint, and recipient
                ↓
SDK checks policy and live token-account capabilities
                ↓
Authorized wallet or managed provider signs
                ↓
Axum validates and relays → program checks policy → token transfer + receipt
```

A mint address identifies the token; its symbol is display metadata. ChainPay
handles integer token units. It does not issue stablecoins, establish a fiat
peg, or redeem tokens for dollars.

### 1. Register an asset

The protocol configuration PDA stores the authority and a legacy bootstrap mint
list. The active settlement gate is a separate `SupportedAsset` PDA for each
mint, derived from `["asset", mint]`. It binds that mint to its token program and
an enabled flag. Only the protocol authority can register or change its status.

The program checks the registry during mandate creation and payment execution.
An enabled entry is necessary; it does not guarantee that a Token-2022 asset's
extensions work with the supported transfer path. See [networks and assets](./networks.md).

### 2. Authorize the mandate and delegate

New mandates use `["mandate", owner, mint, nonce]`. The SDK generates the nonce;
legacy owner-scoped and older owner-plus-mint accounts remain supported. New
mandates choose a recipient per payment. Legacy fixed-recipient mandates keep
that restriction.

The mandate binds the owner, approved agent, source account, mint, spending
limits, expiry, and optional count/cooldown limits. The usual SDK creation plan
contains two owner-signed instructions: create the mandate, then approve its PDA
as the source token account's delegate.

**The agent signer and token delegate are different.** The agent signs the
payment request. The mandate PDA is the delegate that authorizes the token
program transfer. Tokens remain in the owner's account until settlement.

The SDK's default delegate allowance is `totalLimit`; callers can explicitly
set `delegateAmount`. The token allowance and mandate's remaining budget are
independent limits. Each token account has one active delegate, so approving
another mandate against that source can replace the previous delegation.

### 3. Prepare and sign

A request includes the mandate, invoice hash, payment ID, signature reference,
mint, recipient token account, and amount. Hash/reference fields are 32-byte
values. Amounts are unsigned base units: `1_250_000` represents 1.25 tokens only
when the verified mint has six decimals.

SDK preparation reads the registry, mandate, current slot, token capabilities,
and any existing receipt. Check `preflight.valid` before signing. Preflight is
advisory and cannot authorize a transaction that violates on-chain policy.

| Signing mode | Boundary |
| --- | --- |
| Human | The approved wallet signs externally; Axum validates and relays its signed transaction. The browser payment flow uses owner = approved agent. |
| Delegated | Authenticated Axum resolves the mandate-bound managed signer, validates an unsigned transaction, requests provider signing, revalidates, and submits. Provider setup and an authorized mandate are prerequisites. |

MCP requires an explicit mode and never accepts private keys. Delegated mode
rejects caller-supplied signed transactions. The approved agent normally pays
transaction fees and receipt-account rent in SOL; it need not hold the payment
tokens. See [agent integration](../guides/connect-an-agent.md).

### 4. Execute atomically

The program checks these groups before settlement:

- **Identity and accounts:** approved agent signature, expected source and mint,
  enabled asset, consistent token programs, and the supplied recipient.
- **Permission:** source owner, mandate PDA delegation, and enough token allowance.
- **Policy:** positive amount, per-payment and cumulative budgets, expiry,
  pause/revoke status, count cap, cooldown, and valid nonzero references.
- **Replay:** the receipt for this mandate and invoice hash must not already exist.

The handler selects the matching legacy, mint-scoped, or nonce-scoped PDA signer
seeds and invokes the selected token program's `transfer_checked`. After success,
it updates spent amount, payment count, and last payment slot, then writes the
receipt at `["receipt", mandate, invoice_hash]`.

If a check, token transfer, or later instruction fails, Solana rolls back the
transaction's token and account-state changes. A failed submitted transaction
can still incur a network fee. A duplicate receipt rejects another settlement
for the same mandate and invoice hash.

### 5. Confirm the result

Axum binds request metadata to the signed instruction, checks signatures and
transaction contents, tracks submission, and verifies finalized receipt state.
The service does not override the program's policy. Human relay uses
`POST /v1/payments`; managed signing uses `POST /v1/managed-payments`.

A transport timeout leaves the result uncertain. Recover the existing payment
operation and inspect its signature/receipt rather than preparing another
payment. See [settlement recovery](./settlement-recovery.md).

A receipt records the actual token amount, mint, source, recipient, approved
agent, slot, and references. `signature_reference` is a deterministic reference,
not the Solana transaction signature. Axum persists the latter separately.
A settlement receipt also does not prove delivery; see [receipt evidence](./receipts.md).

## Token and connector limits

The SDK scans the live mint, source, and recipient. It rejects active transfer
hooks, non-zero transfer fees, incompatible account state, and unknown
extensions. Confidential-token features are not a separate supported payment
rail; the implementation uses the transparent `transfer_checked` balance path.

The program can forward remaining accounts to its token CPI, but that plumbing
does not constitute a supported hook integration. The SDK rejects caller-supplied
`remainingAccounts`; no supported MCP field lets callers bypass capability checks.

The custom ChainPay `x402/1.0` adapter uses the same payment path and returns a
signature-plus-receipt proof. Standard x402 v2 exact SVM is recognized and
rejected before signing. See the [custom x402 boundary](../guides/connect-an-agent.md#custom-x402-boundary).

## Implementation and test reference

Read [the instruction account constraints](../../programs/chainpay/src/instructions/execute_payment.rs)
and [the transfer handler](../../programs/chainpay/src/lib.rs) for authoritative
account bindings and signer-seed handling. The
[settlement tests](../../programs/chainpay/tests/settlement.rs) execute the built
program in LiteSVM with classic SPL and basic Token-2022 demonstration mints,
then check balances, receipts, replay rejection, and limit rejection.

From the repository root, with the documented Anchor/Rust toolchain installed:

```bash
make contract-smoke
```

This builds the contract and runs local settlement tests. It does not submit a
live payment. The complete setup and check list is in
[development checks](../project/local-e2e-testing.md).
