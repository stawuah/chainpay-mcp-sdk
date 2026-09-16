# Devnet acceptance runbook

Use this runbook to record evidence for an **explicitly approved** end-to-end
Devnet flow. For installation or a first read-only result, start with
[local development](../getting-started/local-development.md).

A green health endpoint is not a successful payment. Record the deployment
revision, configured program, network, and exact outcome for each check.

## 1. Inspect service health

These public reads need no wallet or service token:

```bash
curl -fsS --max-time 30 https://chainpay-backend.onrender.com/healthz
curl -fsS --max-time 30 https://chainpay-backend.onrender.com/v1/config
curl -fsS --max-time 30 https://chainpay-mcp.onrender.com/healthz
curl -fsS --max-time 30 https://chainpay-mcp.onrender.com/tools
```

**Expected:** backend health reports `status: "ok"`, `cluster: "devnet"`, and
the intended program ID. MCP health names `/mcp`; the catalog contains tool
schemas. Read the returned catalog instead of relying on an old hardcoded count.

A timeout means the service was not verified in this attempt. Hosted versions
may differ from this branch. Use the local stack if you need to test this
exact code, with its own database and explicit allowed browser origin.

## 2. Check discovery and public protocol state

Follow the [agent guide](../guides/connect-an-agent.md) to send `tools/list`
and `get_protocol_config`. Discovery can succeed without RPC; a successful
protocol read must also return the expected on-chain configuration.

The optional historical verifier is:

```bash
npm run verify:devnet
```

It reads the deployed program, asset registry, and known historical USDC/PYUSD
transactions. It does not establish a fresh settlement through the current
fork. See [script limitations](../../scripts/README.md) before running
`verify:stack`: it has legacy caller-authentication and schema assumptions
and is not a complete readiness gate for this stack.

## 3. Establish an owner session and permission

Use the [product walkthrough](../getting-started/try-chainpay.md). Wallet
connection, message sign-in, mandate approval, and payment approval are
separate actions.

Private requests require an owner-session or scoped-connection bearer token.
Never substitute `CHAINPAY_HTTP_AUTH_TOKEN` or a wallet-address string. Keep
session tokens out of command transcripts and evidence files. The
[agent guide](../guides/connect-an-agent.md#3-authorize-private-reads) gives
the current authentication and connection contract.

Before approving a transaction, confirm the actual signer, source account,
mint, limits, expiry, and Devnet network. Keep the resulting mandate address
and transaction signature as public references, without wallet secrets.

## 4. Stranger verify (no wallet)

Test public receipt reading without signing in:

1. Copy a finalized Devnet receipt PDA from Explorer or a prior payment.
2. Open `/verify` and paste the PDA, or navigate to `/verify/<pda>`.
3. Confirm **Allowed** / **Paid** stamps and mandate summary render.

Optional readonly baseline (no new signing):

```text
Receipt PDA: 7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q
Settlement tx: 6vvJgRXdneFkrqxgvedbkCCGqw4SUqTLvYcEgHsKnbzfZX28uWmQrt3U6ToJGmByf7AxK224Uxz8jSczAVi8x7D
Program: 3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4
```

Optional local demo link (unlabeled until production use is confirmed):

```bash
VITE_CHAINPAY_DEMO_RECEIPT_PDA=7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q
```

## 5. Record the payment result

Perform only the transaction the owner explicitly approved. Record:

- The commit/deployment, program ID, mint, token program, and exact base-unit amount.
- The original payment ID, mandate, invoice reference/hash, and recipient token account.
- The finalized transaction signature and matching receipt address.
- The observed UI result and receipt verification result.
- Any remaining uncertainty, separately from passing checks.

For an x402 acceptance, capture the original **402 → finalized receipt → 200**
flow from the independent merchant. For delegated mode, capture the configured
provider and mandate-bound signer path; human approval does not verify that mode.

For persistence acceptance, restart the services through the normal operational
process and read the original record again. Do not repeat the payment to test
whether its record survived. A pending or lost response uses the
[recovery runbook](../reference/settlement-recovery.md).

## 6. Update the evidence record

Update [implementation status](implementation-status.md) with what was actually
verified, the revision, and remaining work. Keep local fixtures, historical
chain reads, and newly accepted settlements distinct. No screenshot, test
count, or health response substitutes for finalized payment evidence.
