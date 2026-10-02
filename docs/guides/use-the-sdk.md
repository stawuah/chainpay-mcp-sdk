# Use the TypeScript SDK

Read protocol state and receipts, or build transaction plans for an external
wallet to sign. The SDK talks to Solana RPC; read-only use needs neither an MCP
connection nor a wallet. **Start by reading the protocol configuration.**

## 1. Build the workspace package

Run from the repository root with Node.js and npm installed:

```bash
npm ci --include=dev --ignore-scripts
npm --prefix sdk run build
```

`@chainpay/sdk` is a private workspace package. These commands build the checked-out
source and make the local package available; they do not install a published SDK.

**Expected:** `sdk/dist/index.js` exists and TypeScript finishes without errors.

## 2. Run your first read

From the same repository root:

```bash
node --input-type=module <<'JS'
import { ChainPayClient, deriveConfigAddress } from '@chainpay/sdk';

const client = new ChainPayClient({
  rpcUrl: process.env.CHAINPAY_RPC_URL ?? 'https://api.devnet.solana.com',
  ...(process.env.CHAINPAY_PROGRAM_ID
    ? { programId: process.env.CHAINPAY_PROGRAM_ID }
    : {}),
  commitment: 'confirmed',
});

console.log('Program:', client.programId);
console.log('Config account:', deriveConfigAddress(client.programId));
const config = await client.getConfig();
if (config === null) {
  console.error('No config account. Check the RPC cluster and program ID.');
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(config, (_, value) =>
    typeof value === 'bigint' ? value.toString() : value, 2));
}
JS
```

**Expected:** the program address, its configuration account address, and decoded
configuration. This sends an RPC account read only. There is no keypair, signer,
airdrop, or transfer. An RPC error or missing config is not a successful protocol
read; verify the selected cluster and program before continuing.

## 3. Choose your next operation

| Need | SDK entry point |
| --- | --- |
| Read an owner's mandates | `getMandatesByOwner(owner)` |
| Read spend, remaining, and recent receipts | `loadOpsSnapshot(client, { owner })` |
| Read one mandate | `getMandate(address)` |
| Inspect allowed assets | `getSupportedAssets()` or `getSupportedAsset(mint)` |
| Read a decoded payment receipt | `getPayment(receiptAddress)` |
| Verify a settled receipt for public display | `readPublicReceipt(receiptAddress)` |
| Prepare owner permission | `buildCreateMandate(input, owner)` |
| Check a merchant request against a receipt | `verifyReceiptPurchase(receipt, signedRequest)` |
| Export receipts as one CSV | `receiptsToCsv(rows)` |
| Prepare a payment and inspect policy | `preparePayment(input, approvedAgent)`; throws `DuplicateInvoiceError` when the invoice is already paid |
| Terminal without the dashboard | `npx --prefix sdk chainpay status --owner <wallet>` |
| Receipts CSV from the terminal | `npx --prefix sdk chainpay export --owner <wallet> --out receipts.csv` |

A PDA is a program-derived account address. A receipt PDA records a settlement;
its address is derived from the mandate and invoice hash. Use validated receipt
reads for public proof. `readPublicReceipt` inherits the client commitment; use
`commitment: 'finalized'` when finalized proof is required. The public receipt
page explicitly uses finalized reads. Keep current mandate state distinct from conditions
at the historical payment. See the [receipt reference](../reference/receipts.md).

Use the exported [types](../../sdk/src/types.ts) and
[client](../../sdk/src/client.ts) for exact signatures. SDK amounts and slots
use `bigint`; hashes are bytes. Amounts are base units, so `1_000_000n` is one
token only for a mint with six decimals. Avoid floating-point conversion.

## Signing and settlement

Transaction builders return plans and required signers. A wallet or approved
provider signs outside the SDK. The SDK does not accept a seed phrase or private
key. `executePayment(prepared, adapter)` invokes an injected submission adapter;
it is not a built-in wallet or a policy approval step.

Before invoking any signing/submission adapter, require
`prepared.preflight.valid`, review the exact fields and supported token
capabilities, and obtain the required user approval or existing mandate
authorization. A successful preparation does not mean the payment settled.
Verify the receipt and finality after submission. The program remains the final
policy authority.

Classic SPL Token and compatible Token-2022 assets must be enabled in the
on-chain registry. The SDK checks live mint and account extensions. Unsupported
transfer behavior, including active hooks, non-zero fees, and confidential-only
paths, is rejected. Registry membership alone does not establish compatibility.

## Transaction codecs

`decodeSupportedTransaction(bytes)` reads legacy, v0, and v1 wires using the
Solana 8.3 codecs, with bounds and canonical transaction/message checks.
Construction remains legacy by default. `compileV1TransactionBytes` requires
explicit compute-unit and loaded-account budgets.

Codec tests and generated local transactions establish implementation behavior.
They do not establish acceptance by a deployed provider or Jupiter. See
[implementation status](../project/implementation-status.md) for
evidence and remaining live verification.

## Terminal without the dashboard

After the SDK build, the same snapshot the MCP cards use is available as a
read-only CLI. It never stores keys or submits a transaction, and the read
commands never sign. Pause and revoke print
the owner-approval next step; with `--json` they also print the unsigned
transaction (the same shape the MCP `pause_mandate` tool returns) for a wallet
flow to sign.

```bash
node sdk/dist/cli.js status --owner <wallet>
node sdk/dist/cli.js receipts --owner <wallet>
node sdk/dist/cli.js receipt <receipt-pda>
node sdk/dist/cli.js pause <mandate> --owner <wallet>
```

`CHAINPAY_OWNER`, `CHAINPAY_RPC_URL`, `CHAINPAY_PROGRAM_ID`, and
`CHAINPAY_APP_URL` are optional environment defaults. Add `--json` for the
machine snapshot. Token symbols come from the same table the dashboard uses,
`sdk/src/known-assets.ts`, so an asset named once is named everywhere.

### Ask an owner for a spending permission

A vendor, or a builder who wants their agent funded, can send an owner a signed
request link. The request moves no money and creates nothing on chain. The
owner opens the link, may change every limit, and signs the mandate in their
own wallet.

```bash
node sdk/dist/cli.js request-mandate --keypair vendor.json --mint <mint> \
  --recipient <payee-token-account> --per-payment 5 --total 50 --days 30 \
  --description "Market data API" --po PO-1042 --name "Acme Data"

node sdk/dist/cli.js request-budget --keypair builder.json --agent <agent-key> \
  --mint <mint> --total 50 --days 14 --description "Hackathon API credits"
```

These two commands sign an off-chain request with the keypair file and print
the link and a summary, for example "Asks for up to 5 USDC per payment, 50 USDC
total, 30 days. Payee DobH…jY42. Link valid 7 days." The key is never printed.
Amounts are whole tokens converted exactly with the mint decimals (read over
RPC, or `--decimals`). Days are estimated from 400 ms slots. The link is
`<app>/app/requests/permission#req=<base64url>`; the fragment never reaches a
server. `signMandateRequest`, `verifyMandateRequest`, and the link helpers live
in `sdk/src/mandate-request.ts`.

The expected payee in a vendor request is checked when receipts are matched to
the request. Solana does not block a payment to someone else under a nonce
mandate. The owner's side, Order match and the Statement are in
[ask an owner for a spending permission](request-a-permission.md).

A compact public widget also lives at `/embed/overview/<owner>` — spend meters
and the latest receipt card, no wallet.

## Check your integration

```bash
npm --prefix sdk run typecheck
npm --prefix sdk run test
```

The tests use local fixtures for instructions, policy, receipt validation, token
capabilities, and transaction codecs. They do not make a live payment.
