# Working on ChainPay

ChainPay is a policy-controlled stablecoin payment rail on Solana Devnet.
This file guides coding agents editing the repository. Agents using payment
tools should read [Connect an agent](docs/guides/connect-an-agent.md).

## Read first

1. [README](README.md): product and user journey.
2. [Scope](docs/scope.md): authoritative product boundaries.
3. [Architecture](docs/reference/architecture.md) and [implementation status](docs/project/implementation-status.md): current code and evidence limits.
4. The README in the component you will change. For frontend work, also read
   [design guidance](frontend/skill/design.md) and [brand rules](frontend/src/brand/README.md).

Historical proposals under `docs/archive/` do not override current scope,
source, tests, or the live on-chain state.

## Repository map

| Location | Responsibility |
| --- | --- |
| `programs/chainpay/` | Anchor policy, token transfer, and receipt accounts |
| `sdk/` and `mcp-server/` | TypeScript protocol client and agent tools |
| `backend/` | Axum authentication, relay, recovery, PostgreSQL migrations |
| `frontend/` | Runnable React/Vite dashboard, landing, and public verification |
| `demo-merchant/` | Independent custom x402 payment verifier and resource server |

`app/` is a lightweight contract scaffold, not the runnable dashboard.
The frontend has a separate dependency install; it is not in the root npm workspace.

## Setup and checks

Run from the repository root:

```bash
npm ci --ignore-scripts
npm --prefix frontend ci --ignore-scripts
npm --prefix sdk run build
npm run check
```

Use [local development](docs/getting-started/local-development.md) for prerequisites
and service startup. Root `npm run check` requires both dependency installs.

Run checks for the changed component:

| Change | Checks |
| --- | --- |
| SDK | `npm --prefix sdk test` |
| MCP | `npm --prefix mcp-server test` |
| Frontend | `npm --prefix frontend test` and `npm --prefix frontend run build` |
| Backend / program | `cargo fmt --all -- --check` and `cargo test --workspace` |
| Program settlement | `make contract-smoke` with the documented Anchor toolchain |

Do not run authority bootstrap, migrations against a shared database, provider
provisioning, deployment, or payment scripts as routine checks. A local HTTP
stack needs a dedicated PostgreSQL database; Axum applies migrations at startup.

## Invariants

- The Anchor program is the final payment authority. Preserve Axum, PostgreSQL,
  the SDK, and wallet authentication; no replacement backend, lending, or escrow.
- Derive private-route identity from verified wallet sessions or scoped
  connections. A supplied address or shared service token is not caller authorization.
- Preserve exact amounts as strings or integers. Do not turn amounts into
  floating-point numbers or equate an RPC timeout with payment failure.
- Separate settled payment evidence from optional off-chain seller statements.
  See [receipt semantics](docs/reference/receipts.md).
- Software implementation permission does not authorize financial actions.
  Never collect wallet keys or seed phrases. Payment signing stays in the
  owner's wallet or approved external signer provider.

## Working practice

Inspect `git status` and preserve unrelated work. Keep changes focused and
update affected documentation alongside the implementation. Use the
[contribution guide](CONTRIBUTING.md) for fork/upstream PR targeting.

State what you tested and what you did not. Fixtures and passing tests are
regression evidence; a live-payment claim requires a finalized transaction
and a verified matching receipt. Preserve unresolved operations and use the
[recovery guide](docs/reference/settlement-recovery.md) instead of creating a
new payment to work around uncertainty.
