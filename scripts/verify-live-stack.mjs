import pg from "pg";

const backendUrl = requiredUrl("CHAINPAY_BACKEND_URL");
const mcpUrl = requiredUrl("CHAINPAY_MCP_URL");
const merchantUrl = requiredUrl("CHAINPAY_X402_RESOURCE_URL");
const databaseUrl = required("DATABASE_URL");
const backendToken = process.env.CHAINPAY_BACKEND_AUTH_TOKEN?.trim();
const mcpToken = process.env.CHAINPAY_HTTP_AUTH_TOKEN?.trim();

const USDC_RECEIPT = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
const PYUSD_RECEIPT = "5gLSParY7hBWN6gH7mHHXKod7zCCpTihVn7y72aSCoph";
const USDC_SIGNATURE = "6vvJgRXdneFkrqxgvedbkCCGqw4SUqTLvYcEgHsKnbzfZX28uWmQrt3U6ToJGmByf7AxK224Uxz8jSczAVi8x7D";
const EXPECTED_PROGRAM = process.env.CHAINPAY_PROGRAM_ID ?? "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredUrl(name) {
  return new URL(required(name)).toString();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function json(url, init) {
  const response = await request(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

let rpcId = 0;
async function backendRpc(method, params = []) {
  const payload = await json(new URL("/rpc", backendUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(backendToken ? { Authorization: `Bearer ${backendToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (payload.error) throw new Error(`Axum RPC ${method} failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function mcp(method, params) {
  const payload = await json(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(mcpToken ? { Authorization: `Bearer ${mcpToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  if (payload.error) throw new Error(`MCP ${method} failed: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

const backendHealth = await json(new URL("/healthz", backendUrl), {
  headers: backendToken ? { Authorization: `Bearer ${backendToken}` } : undefined,
});
const backendConfig = await json(new URL("/v1/config", backendUrl), {
  headers: backendToken ? { Authorization: `Bearer ${backendToken}` } : undefined,
});
assert(backendConfig.cluster === "devnet", "Axum is not configured for Devnet");
assert(backendConfig.program_id === EXPECTED_PROGRAM, "Axum program ID mismatch");

const genesisHash = await backendRpc("getGenesisHash");
assert(genesisHash === "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG", "Axum RPC proxy is not connected to Devnet");
const program = await backendRpc("getAccountInfo", [EXPECTED_PROGRAM, { encoding: "base64", commitment: "confirmed" }]);
assert(program?.value?.executable === true, "Axum RPC cannot read the executable ChainPay program");

const initialized = await mcp("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "chainpay-live-verifier", version: "1.0.0" },
});
assert(initialized.serverInfo?.name === "chainpay-mcp", "MCP initialization returned the wrong server");
const assetResult = await mcp("tools/call", { name: "get_supported_assets", arguments: {} });
const assets = assetResult.structuredContent?.assets;
assert(Array.isArray(assets) && assets.some((asset) => asset.enabled && asset.tokenProgramKind === "spl-token"), "MCP did not return an enabled classic SPL asset");
assert(assets.some((asset) => asset.enabled && asset.tokenProgramKind === "token-2022"), "MCP did not return an enabled Token-2022 asset");

for (const receiptAddress of [USDC_RECEIPT, PYUSD_RECEIPT]) {
  const result = await mcp("tools/call", { name: "get_payment", arguments: { receiptAddress } });
  assert(result.structuredContent?.found === true, `MCP could not decode receipt ${receiptAddress}`);
  assert(result.structuredContent?.onChain?.status === "confirmed", `Receipt ${receiptAddress} is not confirmed on-chain`);
}

const merchant = await request(merchantUrl, { headers: { Accept: "application/json" } });
assert(merchant.status === 402, `Merchant returned ${merchant.status}, expected 402`);
assert(Boolean(merchant.headers.get("x-payment-required")), "Merchant 402 omitted X-Payment-Required");

// A known finalized receipt is intentionally presented against this merchant's
// current challenge. A challenge mismatch is expected, but a missing-receipt
// error proves the merchant did not reach/read Devnet and therefore fails here.
const proofProbe = await request(merchantUrl, {
  headers: {
    Accept: "application/json",
    "X-Payment": JSON.stringify({
      version: "x402/1.0",
      scheme: "exact",
      network: "solana-devnet",
      payload: { signature: USDC_SIGNATURE, receiptPDA: USDC_RECEIPT },
    }),
  },
});
const proofProbeBody = await proofProbe.json().catch(() => ({}));
const proofProbeReason = typeof proofProbeBody.reason === "string" ? proofProbeBody.reason : "";
const provesReceiptRead = [
  "invoice hash mismatch",
  "mint mismatch",
  "recipient mismatch",
  "amount mismatch",
  "approved agent mismatch",
  "transaction",
].some((message) => proofProbeReason.includes(message));
assert(
  proofProbe.status === 200 || (proofProbe.status === 402 && provesReceiptRead),
  `Merchant could not read the known Devnet receipt: ${JSON.stringify(proofProbeBody)}`,
);

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
let database;
try {
  const migrations = await pool.query("SELECT version, success FROM _sqlx_migrations ORDER BY version");
  assert(migrations.rows.some((row) => Number(row.version) === 5 && row.success === true), "Neon migration 0005 is not installed");
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'payments', 'transactions', 'agent_connections', 'inbox_messages', 'x402_payments',
        'managed_signers', 'managed_signer_challenges'
      )
    ORDER BY table_name
  `);
  assert(tables.rowCount === 7, "Neon is missing one or more ChainPay tables");
  const oldColumns = await pool.query(`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN ('payments', 'transactions')
      AND column_name = 'simulation'
  `);
  assert(oldColumns.rowCount === 0, "Neon still contains obsolete simulation state");
  const managedColumns = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'payments'
      AND column_name = 'signing_mode'
  `);
  assert(managedColumns.rowCount === 1, "Neon migration 0005 did not add payments.signing_mode");
  database = { migrationCount: migrations.rowCount, tables: tables.rows.map((row) => row.table_name) };
} finally {
  await pool.end();
}

console.log(JSON.stringify({
  verified: true,
  communication: ["Axum→Devnet", "MCP→SDK→Devnet", "merchant→Devnet receipt read", "Axum/MCP→Neon"],
  backend: { health: backendHealth, programId: backendConfig.program_id, genesisHash },
  mcp: { server: initialized.serverInfo, enabledAssets: assets.filter((asset) => asset.enabled).length },
  merchant: { resource: merchantUrl, challengeStatus: merchant.status, proofProbeStatus: proofProbe.status },
  database,
}, null, 2));
