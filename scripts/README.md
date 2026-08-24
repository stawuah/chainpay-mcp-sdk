# ChainPay Devnet operations

## Read-only regression verification

Run the production baseline check before and after settlement-path changes:

```sh
npm run verify:devnet
```

`verify-devnet.mjs` is strictly read-only. It rejects non-Devnet RPCs and
verifies the deployed ChainPay program, USDC and PYUSD mint owners, enabled
asset PDAs, known confirmed settlements, and the current PYUSD transfer-fee and
transfer-hook configuration. It never loads a signer or submits a transaction.

## Live service communication verification

After starting Axum, HTTP MCP, the independent x402 merchant, and Neon, run:

```sh
CHAINPAY_BACKEND_URL=https://backend.example.com \
CHAINPAY_MCP_URL=https://mcp.example.com/mcp \
CHAINPAY_X402_RESOURCE_URL=https://merchant.example.com/data \
DATABASE_URL='postgresql://...' \
npm run verify:stack
```

The verifier requires real service endpoints. It follows Axum and MCP reads to
Devnet, presents a known finalized receipt to the merchant to prove the merchant
can read chain state, and queries the actual Neon schema. It does not use a
local settlement server or broadcast a transaction.

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

Run it with a funded Devnet authority:

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

The root render.yaml now declares a Render Cron service named
chainpay-keep-alive. After the Blueprint is deployed, Render runs
scripts/keep-alive.mjs every minute and pings the public frontend, backend
health endpoint, and MCP health endpoint automatically.

The service uses Render's starter cron plan, which has a paid minimum charge.
The schedule is in UTC. Override CHAINPAY_FRONTEND_URL,
CHAINPAY_BACKEND_URL, CHAINPAY_MCP_URL, or
CHAINPAY_KEEPALIVE_TIMEOUT_SECONDS in the Render service environment when
using different public URLs.
