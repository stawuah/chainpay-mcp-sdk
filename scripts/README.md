# ChainPay Devnet operations

Run commands below from the repository root after `npm ci --ignore-scripts`. These utilities
serve different purposes; service health, historical proof reads, and new
settlement acceptance are separate checks.

## Read-only regression verification

Install the SPL Token CLI (`spl-token` on PATH) and provide a reachable Devnet
RPC. Run the historical Devnet baseline check before and after settlement-path
changes:

```sh
npm run verify:devnet
```

`verify-devnet.mjs` is strictly read-only. It rejects non-Devnet RPCs and
verifies the deployed ChainPay program, USDC and PYUSD mint owners, enabled
asset PDAs, known confirmed settlements, and the current PYUSD transfer-fee and
transfer-hook configuration. It never loads a signer or submits a transaction.

## Legacy live-stack verifier

`npm run verify:stack` runs `verify-live-stack.mjs`. It reads backend health,
Solana state, MCP tools, and PostgreSQL schema, and presents a known historical
receipt to a merchant. It never submits a payment.

**Compatibility limitation:** its private `get_payment` calls use fixed receipt
addresses and the legacy `CHAINPAY_HTTP_AUTH_TOKEN` environment variable. The
current services require an actual owner/scoped caller credential with access
to each mandate. A deployment service token cannot satisfy that requirement.
The database assertions cover migration `0005` and selected older tables; they
do not validate all current migrations. A failure here can therefore mean an
outdated test assumption, not a broken service.

Use the current [acceptance runbook](../docs/project/local-e2e-testing.md) for
service and caller-aware checks. If maintaining the verifier, its inputs are
`CHAINPAY_BACKEND_URL`, `CHAINPAY_MCP_URL` (including `/mcp`),
`CHAINPAY_X402_RESOURCE_URL`, and `DATABASE_URL`. Optional legacy credential
variables are `CHAINPAY_BACKEND_AUTH_TOKEN` and `CHAINPAY_HTTP_AUTH_TOKEN`;
do not populate them with a shared deployment secret to bypass caller auth.

The merchant probe can return `200` if the historical proof matches the current
challenge. A configured merchant may then publish its response-served statement;
use a merchant with publication disabled for a strictly read-only test.

## Devnet bootstrap

`bootstrap-devnet.mjs` performs the real, idempotent ChainPay Devnet setup:

1. verifies the deployed ChainPay program and Devnet USDC mint;
2. initializes the config PDA with Devnet USDC when it does not exist;
3. registers Devnet USDC in the asset registry;
4. verifies the official Solana Devnet PYUSD Token-2022 mint; and
5. registers and verifies that Token-2022 mint.

Each transaction is submitted directly to Devnet and must reach finalized
status before the script continues. The script requires an explicit signer path
and never creates, prints, or stores a private key in the repository.

This is a **chain-writing operation**, not a setup or documentation check. Only
run after the authority has explicitly approved bootstrap, with a funded Devnet
authority:

```sh
CHAINPAY_KEYPAIR=/absolute/path/to/devnet-authority.json npm run bootstrap:devnet
```

Optional environment variables:

- `CHAINPAY_RPC_URL` — Devnet RPC URL; defaults to `https://api.devnet.solana.com`.
- `CHAINPAY_PROGRAM_ID` — deployed ChainPay program; defaults to the current Devnet program.
- `CHAINPAY_TOKEN_2022_MINT` — override the default Devnet PYUSD Token-2022 mint
  with another existing Token-2022 mint.

The default Devnet PYUSD mint is
`CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM`. The mint is registered only
after its account owner is verified as Token-2022.

The scalable registry is one PDA per mint, so any valid classic SPL Token or
Token-2022 mint can be enabled by the config authority. Registration alone does
not imply compatibility: the SDK scans the live mint plus source and recipient
accounts before every payment. The current transparent path rejects active
transfer hooks, non-zero fees, required memos, CPI guard conflicts,
non-transferable/frozen state, and unknown transfer-affecting extensions rather
than accepting caller-supplied extra accounts.

## Render keep-alive

The root `render.yaml` declares a Render Cron service named
`chainpay-keep-alive`. After the Blueprint is deployed, Render runs
scripts/keep-alive.mjs every minute and pings the public frontend, backend
health endpoint, and MCP health endpoint automatically.

The blueprint specifies the `starter` cron plan. Review current Render pricing
before provisioning it. The schedule is in UTC. Override CHAINPAY_FRONTEND_URL,
CHAINPAY_BACKEND_URL, CHAINPAY_MCP_URL, or
CHAINPAY_KEEPALIVE_TIMEOUT_SECONDS in the Render service environment when
using different public URLs.
