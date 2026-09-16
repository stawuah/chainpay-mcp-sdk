# Run ChainPay locally

Start with a read-only check. Add the browser or local services when you need
them. All commands below run from the **repository root** unless stated otherwise.

## 1. Install the JavaScript packages

Use Git, Node.js **22.12 or newer**, and npm. The deployment image uses Node 22;
the frontend requires a Node version compatible with Vite 7.

```bash
git clone --branch dre/pr-21-readme-and-docs https://github.com/tantshirt/chainpay-mcp-sdk.git
cd chainpay-mcp-sdk
npm ci --ignore-scripts
npm --prefix sdk run build
```

Use this fork and branch until the stack is merged; upstream’s default branch
may have different setup and authorization behavior. `--ignore-scripts` matches
the verified clean install and skips dependency lifecycle scripts.

The root workspace installs the SDK, MCP server, merchant, and `app/` scaffold.
The working web application lives in `frontend/`, which has a separate lockfile.

## 2. Check MCP without a database or wallet

Build the server, then send a tool-discovery request over standard input:

```bash
npm --prefix mcp-server run build
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node mcp-server/dist/server.js
```

**Success:** a JSON response with `result.tools`, including
`get_protocol_config`. Discovery does not query Solana or submit a transaction.
The stdio server waits for input when launched without a pipe; that is normal.

Next: [connect an agent](../guides/connect-an-agent.md) for a live protocol read
and authenticated calls.

## 3. Preview the frontend

```bash
npm --prefix frontend ci --ignore-scripts
cp frontend/.env.example frontend/.env.local
npm --prefix frontend run dev -- --host localhost --port 5173 --strictPort
```

Open **http://localhost:5173**. The example environment points to the hosted
Devnet services. Loading the landing page needs no wallet; live reads depend on
those services being reachable. Wallet login also requires the deployed services
to allow the exact `http://localhost:5173` origin. Hosted code may differ from
your checkout; use the local services below to exercise this branch's behavior.

Vite loads `frontend/.env.local` automatically. Restart it after changing values.
Every `VITE_*` value is public browser configuration; keep credentials out of it.

## 4. Run backend and HTTP MCP locally (optional)

You need a current Rust toolchain capable of compiling the locked dependencies
and Rust 2024 edition, plus a running PostgreSQL database. Anchor and the Solana
CLI are unnecessary for these services. There is no Rust toolchain pin in this
repository.

Use a **dedicated local development database**. Axum startup applies all bundled
`backend/migrations/` files and records the migration history; these modify the
database schema, including removing obsolete columns. HTTP MCP uses the same
database and requires those tables to exist. Neither service falls back to an
in-memory database during normal startup.

Your local PostgreSQL server must accept TCP connections at `127.0.0.1:5432`.
Have a development role named `chainpay`, its password, and permission to create
a database (or ask the database owner to create one for that role). With that
role configured, create the database; `createdb` prompts for its password:

```bash
createdb -h 127.0.0.1 -U chainpay -W chainpay_dev
```

In **both** examples below, replace `LOCAL_PASSWORD` with that role's password
(URL-encode reserved characters) and retain the quotes. If your database already
exists elsewhere, replace both URLs with the same development TCP connection
URL. Do not use a production URL.

**Terminal A — backend:**

```bash
DATABASE_URL='postgresql://chainpay:LOCAL_PASSWORD@127.0.0.1:5432/chainpay_dev' \
CHAINPAY_HTTP_HOST=127.0.0.1 CHAINPAY_HTTP_PORT=8080 \
CHAINPAY_RPC_URL=https://api.devnet.solana.com \
CHAINPAY_ALLOWED_ORIGINS=http://localhost:5173 \
cargo run -p chainpay-backend
```

Before starting MCP, verify startup from another terminal:

```bash
curl -fsS http://127.0.0.1:8080/healthz
```

**Success:** JSON reports `status: "ok"` and `cluster: "devnet"`.
This checks service startup, not payment settlement or all upstream RPC methods.

**Terminal B — HTTP MCP:**

```bash
DATABASE_URL='postgresql://chainpay:LOCAL_PASSWORD@127.0.0.1:5432/chainpay_dev' \
CHAINPAY_HTTP_HOST=127.0.0.1 CHAINPAY_HTTP_PORT=3000 \
CHAINPAY_BACKEND_URL=http://127.0.0.1:8080 \
CHAINPAY_RPC_URL=https://api.devnet.solana.com \
CHAINPAY_ALLOWED_ORIGINS=http://localhost:5173 \
npm --prefix mcp-server run dev:http
```

**Success:** stderr prints `ChainPay MCP HTTP listening on http://127.0.0.1:3000/mcp`.
Check `curl -fsS http://127.0.0.1:3000/tools` for the public tool catalog.
Axum, MCP, and the merchant read the process environment; merely copying a
`.env.example` does not load it. These commands set the required values explicitly.

**Terminal C — frontend using local services:**

```bash
VITE_CHAINPAY_BACKEND_URL=http://127.0.0.1:8080 \
VITE_CHAINPAY_RPC_URL=http://127.0.0.1:8080/rpc \
VITE_CHAINPAY_MCP_URL=http://127.0.0.1:3000/mcp \
VITE_CHAINPAY_AGENT_URL=http://127.0.0.1:3000/agent/chat \
npm --prefix frontend run dev -- --host localhost --port 5173 --strictPort
```

This serves the local UI and services against **Solana Devnet**, not a local
validator. The conversational agent additionally needs an AI-provider key in
the MCP process. Managed signing requires backend Privy configuration and owner
enrollment; the basic setup above does not provision or fund a signer.

Private calls require an actual owner session or scoped agent connection.
A deployment service token is not a substitute. Wallet login proves identity;
each transaction still follows its approval and signing flow. See
[backend configuration](../../backend/README.md) and
[merchant setup](../../demo-merchant/README.md) for optional capabilities.

## 5. Check a change

After both npm installs, these commands exercise local code without submitting
payments:

```bash
npm run check
npm --prefix sdk test
npm --prefix mcp-server test
npm --prefix demo-merchant test
npm --prefix frontend test
npm --prefix frontend run build
```

For Rust changes:

```bash
cargo fmt --all -- --check
cargo test -p chainpay-backend
cargo test -p chainpay
```

Cargo may download dependencies on its first run. Ordinary program unit tests
do not build or execute the SBF contract. For that separate check, follow
[program verification](../../programs/chainpay/README.md#local-verification).
Browser tests have additional setup in [the frontend test guide](../../frontend/test/README.md).

**Next:** [troubleshoot a setup problem](troubleshooting.md), or follow the
[Devnet acceptance runbook](../project/local-e2e-testing.md) when an explicitly
approved transaction is part of your task.
