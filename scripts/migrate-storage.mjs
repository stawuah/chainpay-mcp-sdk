#!/usr/bin/env node
// Explicit operator commands only. This program never changes platform settings
// or submits a transaction. Snapshot files contain private operational records.
import { open, readdir, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parse, stringify, isLosslessNumber } from "lossless-json";
import pg from "pg";

export const TABLES = {
  receipt_requests: ["cluster", "program_id", "receipt_address"],
  observed_policies: ["cluster", "program_id", "receipt_address"],
  mandate_requests: ["mandate_pda"],
  payments: ["payment_id"], transactions: ["transaction_id"],
  agent_connections: ["connection_id"], inbox_messages: ["message_id"],
  x402_payments: ["x402_payment_id"], managed_signer_challenges: ["challenge_id"],
  managed_signers: ["signer_id"], owner_auth: ["key"],
  operation_claims: ["operation_id"],
  delivery_attestations: ["cluster", "program_id", "receipt_address", "seller"],
};
function canonical(value) {
  if (isLosslessNumber(value) || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}
export function rowDigest(row) { return createHash("sha256").update(stringify(canonical(parse(row)))).digest("hex"); }
export function rowKey(table, row) {
  if (!Object.hasOwn(TABLES, table)) throw new Error("Unknown snapshot table");
  const value = parse(row);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected SQL row object");
  return JSON.stringify(TABLES[table].map(key => {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`Invalid primary key in ${table}`);
    return value[key];
  }));
}
export function validateRow(table, row) {
  if (typeof row !== "string" || Buffer.byteLength(row) > 350_000) throw new Error(`Oversized/invalid source row in ${table}; no data was truncated`);
  return { key: rowKey(table, row), hash: rowDigest(row) };
}
function manifest(rows) {
  return Object.fromEntries(Object.keys(TABLES).map(table => {
    const entries = [...rows.get(table).entries()].sort(([a], [b]) => a.localeCompare(b));
    return [table, { count: entries.length, sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex") }];
  }));
}
function registry() { return new Map(Object.keys(TABLES).map(table => [table, new Map()])); }
async function* lines(file) {
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of reader) if (line.trim()) yield JSON.parse(line);
}
export async function inspect(file) {
  const rows = registry(); let header = false; let footer;
  for await (const entry of lines(file)) {
    if (entry.type === "header" && !header) { if (entry.version !== 1) throw new Error("Unsupported snapshot version"); header = true; continue; }
    if (!header || footer) throw new Error("Invalid snapshot ordering");
    if (entry.type === "manifest") { footer = entry.tables; continue; }
    if (entry.type !== "row") throw new Error("Unexpected snapshot entry");
    const { key, hash } = validateRow(entry.table, entry.row);
    if (rows.get(entry.table).has(key)) throw new Error(`Duplicate primary key in ${entry.table}`);
    rows.get(entry.table).set(key, hash);
  }
  const result = manifest(rows);
  if (!header || !footer || JSON.stringify(result) !== JSON.stringify(footer)) throw new Error("Incomplete snapshot or manifest mismatch");
  return result;
}
async function writer(file, source) {
  const handle = await open(file, "wx", 0o600);
  const rows = registry();
  await handle.writeFile(`${JSON.stringify({ type: "header", version: 1, source, createdAt: new Date().toISOString() })}\n`);
  return {
    async row(table, row) {
      const { key, hash } = validateRow(table, row);
      if (rows.get(table).has(key)) throw new Error(`Duplicate row in ${table}`);
      rows.get(table).set(key, hash);
      await handle.writeFile(`${JSON.stringify({ type: "row", table, row })}\n`);
    },
    async finish() { const tables = manifest(rows); await handle.writeFile(`${JSON.stringify({ type: "manifest", tables })}\n`); await handle.close(); return tables; },
    async close() { await handle.close(); },
  };
}
function required(name) { const value = process.env[name]; if (!value) throw new Error(`${name} is required`); return value; }
// Migration identities are checksummed: never reinterpret either branch's 0009.
// A source through 0008 is supported; unapplied new feature tables are empty.
const FEATURE_MIGRATIONS = { receipt_requests: 10, observed_policies: 11, mandate_requests: 12 };
export async function validateSchema(client, requireLatest = false) {
  const directory = new URL("../backend/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter(f => /^\d+_.+\.sql$/.test(f)).sort();
  const expected = await Promise.all(files.map(async file => ({ version: Number(file.split("_")[0]), checksum: createHash("sha384").update(await readFile(new URL(file, directory))).digest("hex") })));
  const applied = (await client.query("SELECT version::text, encode(checksum, 'hex') AS checksum, success FROM _sqlx_migrations ORDER BY _sqlx_migrations.version")).rows;
  if (applied.length < 8 || applied.length > expected.length || applied.some((row, i) => !row.success || Number(row.version) !== expected[i].version || row.checksum !== expected[i].checksum)) {
    throw new Error("Unsupported migration history: source must match canonical migrations beginning at 0001. Reconcile branch-specific 0009/checksums on an isolated copy before cutover; never edit live migration history.");
  }
  if (requireLatest && applied.length !== expected.length) throw new Error("Restore target must have all current migrations applied");
  const versions = new Set(applied.map(row => Number(row.version)));
  for (const [table, version] of Object.entries(FEATURE_MIGRATIONS)) {
    if (!versions.has(version) && (await client.query("SELECT to_regclass($1) AS relation", [`public.${table}`])).rows[0].relation !== null) {
      throw new Error(`Unsupported migration history: ${table} exists before its recorded migration ${version}; reconcile the schema on an isolated copy before cutover`);
    }
  }
  if (!versions.has(9) && (await client.query("SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='x402_payments' AND column_name IN ('connector','connector_reference') LIMIT 1")).rows.length) {
    throw new Error("Unsupported migration history: connector columns exist before recorded migration 9; reconcile the schema on an isolated copy before cutover");
  }
  return versions;
}
async function exportPostgres(file) {
  const client = new pg.Client({ connectionString: required("CHAINPAY_SOURCE_DATABASE_URL") });
  await client.connect(); const output = await writer(file, "postgres");
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    // row_to_json renders timestamptz in the session zone; pin it so the same
    // instants hash identically whatever the server's default zone is.
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const versions = await validateSchema(client);
    // Owner webhook rows (0013) are not carried across: sealed endpoint
    // secrets are tied to this relay's keys. Refuse rather than drop them.
    if (versions.has(13) && (await client.query("SELECT EXISTS (SELECT 1 FROM webhook_subscriptions) AS present")).rows[0].present) {
      throw new Error("Owner webhook endpoints exist: they are not migrated. Disable them and have owners re-register on the target before cutover");
    }
    for (const [table, keys] of Object.entries(TABLES)) {
      if (FEATURE_MIGRATIONS[table] && !versions.has(FEATURE_MIGRATIONS[table])) continue;
      await client.query(`DECLARE migration_rows NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM "${table}" t ORDER BY ${keys.map(k => `"${k}"`).join(",")}`);
      for (;;) { const batch = await client.query("FETCH 100 FROM migration_rows"); if (!batch.rows.length) break; for (const row of batch.rows) {
        // Legacy rows are x402 jobs. Export the canonical new-schema defaults
        // without changing the source, preserving full-width JSON numbers.
        const canonicalRow = table === "x402_payments" && !versions.has(9)
          ? stringify({ ...parse(row.row), connector: "x402", connector_reference: null })
          : row.row;
        await output.row(table, canonicalRow);
      } }
      await client.query("CLOSE migration_rows");
    }
    await client.query("COMMIT"); return await output.finish();
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); await output.close(); throw error; }
  finally { await client.end(); }
}
async function convex(operation, args) {
  const url = new URL(required("CHAINPAY_CONVEX_SITE_URL"));
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("A plain HTTPS Convex site origin is required");
  const response = await fetch(new URL("/internal/storage/v1", url), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${required("CHAINPAY_CONVEX_MIGRATION_SECRET")}` },
    body: JSON.stringify({ operation, args }),
  });
  if (!response.ok) throw new Error(`Migration request rejected (${response.status}); source rows and secrets omitted`);
  const body = await response.json(); if (!Object.hasOwn(body, "value")) throw new Error("Invalid migration response"); return body.value;
}
async function importConvex(file) {
  const expected = await inspect(file); // Validate the entire snapshot before writing anything.
  for (const table of Object.keys(TABLES)) {
    let batch = [];
    const flush = async () => { if (!batch.length) return; await convex("migration.import", { table, rows: batch }); batch = []; };
    for await (const entry of lines(file)) {
      if (entry.type !== "row" || entry.table !== table) continue;
      if (batch.length >= 100 || Buffer.byteLength(JSON.stringify({ operation: "migration.import", args: { table, rows: [...batch, entry.row] } })) > 850_000) await flush();
      batch.push(entry.row);
    }
    await flush();
  }
  // Import is resumable by rerunning the identical file while maintenance stays on.
  return expected;
}
async function exportConvex(file) {
  const output = await writer(file, "convex");
  try {
    for (const table of Object.keys(TABLES)) {
      let cursor = null;
      do {
        const result = await convex("migration.export", { table, cursor, limit: 50 });
        for (const row of result.rows) await output.row(table, row);
        if (result.done) break;
        if (!result.cursor || result.cursor === cursor) throw new Error("Migration pagination did not advance");
        cursor = result.cursor;
      } while (true);
    }
    return await output.finish();
  } catch (error) { await output.close(); throw error; }
}
async function restorePostgres(file) {
  await inspect(file);
  if (required("CHAINPAY_MIGRATION_TARGET_WRITE_PAUSED") !== "true") throw new Error("Restore requires an isolated, write-paused target");
  const client = new pg.Client({ connectionString: required("CHAINPAY_TARGET_DATABASE_URL") });
  await client.connect();
  try {
    await client.query("BEGIN");
    await validateSchema(client, true);
    await client.query(`LOCK TABLE ${Object.keys(TABLES).map(t => `"${t}"`).join(",")} IN ACCESS EXCLUSIVE MODE`);
    for (const table of Object.keys(TABLES)) {
      const { rows } = await client.query(`SELECT 1 FROM "${table}" LIMIT 1`);
      if (rows.length) throw new Error("Restore requires empty tables with the ChainPay migrations already applied; never overwrites live data");
    }
    for (const table of Object.keys(TABLES)) {
      const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table])).rows.map(r => r.column_name);
      for await (const entry of lines(file)) {
        if (entry.type !== "row" || entry.table !== table) continue;
        const fields = Object.keys(parse(entry.row));
        if (fields.some(k => !columns.includes(k))) throw new Error(`Schema mismatch in ${table}`);
        const names = fields.map(k => `"${k}"`).join(",");
        await client.query(`INSERT INTO "${table}" (${names}) SELECT ${names} FROM json_populate_record(NULL::"${table}",$1::json)`, [entry.row]);
      }
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { await client.end(); }
  return { restored: true };
}
async function main() {
  const [command, file, other] = process.argv.slice(2);
  if (!command || !file) throw new Error("Usage: migrate-storage.mjs inspect|export-postgres|import-convex|export-convex|restore-postgres|compare FILE [OTHER_FILE|--apply]");
  let result;
  if (command === "inspect") result = await inspect(file);
  else if (command === "compare") { const [a,b] = await Promise.all([inspect(file),inspect(other)]); if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error("Snapshot counts or record hashes differ"); result = { equal: true, tables: a }; }
  else if (command === "export-postgres") result = await exportPostgres(file);
  else if (command === "export-convex") result = await exportConvex(file);
  else if (command === "import-convex" || command === "restore-postgres") {
    if (other !== "--apply") result = { dryRun: true, tables: await inspect(file) };
    else result = command === "import-convex" ? await importConvex(file) : await restorePostgres(file);
  } else throw new Error("Unknown migration command");
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  // Database errors can contain SQL data; print only known, non-provider details.
  console.error(error.code ? `Migration failed (${error.code}); no credentials or row data logged` : error.message);
  process.exitCode = 1;
});
