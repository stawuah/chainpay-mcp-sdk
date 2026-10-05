// Run through `npm run test:migration:integration`: Vitest supplies convex-test.
// Every database and TLS certificate lives in a fresh temporary directory.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:https";
import { createHash } from "node:crypto";
import pg from "pg";
import { TABLES } from "./migrate-storage.mjs";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");

export async function runMigrationIntegration(convexFetch) {
  const dir = await mkdtemp(join(tmpdir(), "chainpay-migration-integration-"));
  const data = join(dir, "postgres");
  let started = false, server;
  const clients = [];
  try {
    await exec("initdb", ["-D", data, "-U", "chainpay_fixture", "-A", "trust", "--no-locale", "--encoding=UTF8"]);
    await exec("pg_ctl", ["-D", data, "-l", join(dir, "postgres.log"), "-o", `-k ${dir} -h ''`, "-w", "start"]);
    started = true;
    const connect = async (database) => {
      const client = new pg.Client({ host: dir, database, user: "chainpay_fixture" });
      await client.connect(); clients.push(client); return client;
    };
    const admin = await connect("postgres");
    const source = await connect("postgres");
    await admin.query('CREATE DATABASE restored');
    const target = await connect("restored");
    const files = (await readdir(join(root, "backend/migrations"))).filter(f => f.endsWith(".sql")).sort();
    const migrate = async (client, through = Infinity) => {
      await client.query('CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMPTZ NOT NULL DEFAULT now(), success BOOLEAN NOT NULL, checksum BYTEA NOT NULL, execution_time BIGINT NOT NULL)');
      for (const name of files.filter(name => Number(name.split("_")[0]) <= through)) {
        const sql = await readFile(join(root, "backend/migrations", name));
        await client.query(sql.toString());
        await client.query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES ($1,$2,true,decode($3,'hex'),0)", [Number(name.split("_")[0]), name, createHash("sha384").update(sql).digest("hex")]);
      }
    };
    await migrate(source); await migrate(target);
    await source.query(await readFile(join(root, "scripts/fixtures/migration-records.sql"), "utf8"));
    const cert = join(dir, "cert.pem"), key = join(dir, "key.pem");
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"]);
    let importCalls = 0, interrupted = false, interrupt = true;
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const call = JSON.parse(body);
        // Commit a batch then lose its response: the CLI must safely resume.
        const response = await convexFetch(req.url, { method: req.method, headers: req.headers, body });
        if (call.operation === "migration.import") importCalls++;
        if (interrupt && call.operation === "migration.import" && call.args.table === "payments" && call.args.rows.length === 100 && response.ok) { interrupted = true; res.writeHead(503); res.end('interrupted after commit'); return; }
        res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
      } catch (error) { res.writeHead(500); res.end(String(error)); }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const databaseUrl = (database) => `postgresql://chainpay_fixture@localhost/${database}?host=${encodeURIComponent(dir)}`;
    const env = { ...process.env, NODE_EXTRA_CA_CERTS: cert, CHAINPAY_SOURCE_DATABASE_URL: databaseUrl("postgres"), CHAINPAY_TARGET_DATABASE_URL: databaseUrl("restored"), CHAINPAY_MIGRATION_TARGET_WRITE_PAUSED: "true", CHAINPAY_CONVEX_SITE_URL: `https://127.0.0.1:${server.address().port}`, CHAINPAY_CONVEX_MIGRATION_SECRET: "integration-only-".repeat(3) };
    const cli = async (args, changes = {}) => JSON.parse((await exec(process.execPath, [join(root, "scripts/migrate-storage.mjs"), ...args], { cwd: root, env: { ...env, ...changes }, timeout: 30_000 })).stdout);
    const original = join(dir, "source.ndjson"), imported = join(dir, "convex.ndjson"), restored = join(dir, "restored.ndjson");
    // Export identical timestamps from deliberately different session defaults.
    await admin.query("ALTER ROLE chainpay_fixture SET timezone TO 'Pacific/Honolulu'");
    // Owner webhook endpoints hold relay-sealed secrets and are never carried across.
    await source.query(`INSERT INTO webhook_subscriptions(subscription_id,owner_wallet,url,status,secrets,created_at_ms,updated_at_ms) VALUES ('hook-1','owner','https://hooks.invalid/x','active','[]',0,0)`);
    await assert.rejects(cli(["export-postgres", join(dir, "refused.ndjson")]), /Owner webhook endpoints exist/);
    await source.query("DELETE FROM webhook_subscriptions");
    const exported = await cli(["export-postgres", original]);
    await admin.query("ALTER ROLE chainpay_fixture SET timezone TO 'Asia/Tokyo'");
    const otherZone = join(dir, "other-zone.ndjson");
    await cli(["export-postgres", otherZone]);
    assert.equal((await cli(["compare", original, otherZone])).equal, true);
    assert.equal(Object.keys(exported).length, 13);
    for (const table of Object.keys(TABLES)) assert.ok(exported[table].count > 0, `${table} must have representative records`);
    assert.equal(exported.payments.count, 105, "exercises multiple import batches and export pages");
    await assert.rejects(cli(["import-convex", original, "--apply"]), /503/);
    assert.equal(interrupted, true, "interruption occurred after committing 100 payment rows");
    assert.ok(importCalls >= 1);
    interrupt = false;
    await cli(["import-convex", original, "--apply"]);
    await cli(["import-convex", original, "--apply"]);
    await cli(["export-convex", imported]);
    assert.equal((await cli(["compare", original, imported])).equal, true);

    // A late-table constraint fails after earlier tables were inserted. Verify
    // rollback from actual SQL rows, rather than trusting the command result.
    await target.query("ALTER TABLE delivery_attestations ADD CONSTRAINT fixture_reject CHECK (seller <> 'seller')");
    await assert.rejects(cli(["restore-postgres", imported, "--apply"]), /23514/);
    for (const table of Object.keys(TABLES)) assert.equal((await target.query(`SELECT count(*) FROM "${table}"`)).rows[0].count, "0", `${table}: partial restore must roll back`);
    await target.query("ALTER TABLE delivery_attestations DROP CONSTRAINT fixture_reject");
    await cli(["restore-postgres", imported, "--apply"]);
    await cli(["export-postgres", restored], { CHAINPAY_SOURCE_DATABASE_URL: databaseUrl("restored") });
    assert.equal((await cli(["compare", original, restored])).equal, true);
    assert.equal((await target.query("SELECT amount::text FROM payments WHERE payment_id='payment-1'")).rows[0].amount, "18446744073709551615");
    assert.equal((await target.query("SELECT connector_reference FROM x402_payments WHERE connector='crossmint'")).rows[0].connector_reference, "order-unresolved");
    assert.equal((await target.query("SELECT initial_record->>'status' AS status FROM operation_claims")).rows[0].status, "unknown");
    await assert.rejects(cli(["restore-postgres", imported, "--apply"]), /empty tables/);
    await admin.query('CREATE DATABASE legacy');
    await admin.query('CREATE DATABASE legacy_restored');
    const legacy = await connect("legacy"), legacyTarget = await connect("legacy_restored");
    await migrate(legacy, 8); await migrate(legacyTarget);
    await legacy.query("INSERT INTO x402_payments(x402_payment_id,idempotency_key,resource,status,challenge,proof) VALUES ('legacy-job','owner:legacy','https://merchant.invalid/legacy','submitted','{\"amount\":18446744073709551615}','{\"slot\":9007199254740993}')");
    const legacyFile = join(dir, "legacy.ndjson"), legacyRestored = join(dir, "legacy-restored.ndjson");
    const legacyEnv = { CHAINPAY_SOURCE_DATABASE_URL: databaseUrl("legacy"), CHAINPAY_TARGET_DATABASE_URL: databaseUrl("legacy_restored") };
    const legacyManifest = await cli(["export-postgres", legacyFile], legacyEnv);
    for (const table of ["receipt_requests", "observed_policies", "mandate_requests"]) assert.equal(legacyManifest[table].count, 0);
    await cli(["restore-postgres", legacyFile, "--apply"], legacyEnv);
    await cli(["export-postgres", legacyRestored], { CHAINPAY_SOURCE_DATABASE_URL: databaseUrl("legacy_restored") });
    assert.equal((await cli(["compare", legacyFile, legacyRestored])).equal, true);
    assert.deepEqual((await legacyTarget.query("SELECT connector, connector_reference, challenge->>'amount' AS amount, proof->>'slot' AS slot FROM x402_payments")).rows[0], { connector: "x402", connector_reference: null, amount: "18446744073709551615", slot: "9007199254740993" });
    // A branch's unrelated migration 0009 must not be silently reinterpreted.
    await legacy.query("INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES (9,'branch receipt migration',true,decode(repeat('00',48),'hex'),0)");
    await assert.rejects(cli(["export-postgres", join(dir, "conflict.ndjson")], legacyEnv), /Unsupported migration history/);
    await legacy.query("DELETE FROM _sqlx_migrations WHERE version=9");
    // A physical feature table cannot be silently omitted merely because its
    // migration is absent from the ledger, even if the table happens to be empty.
    await legacy.query("CREATE TABLE receipt_requests (receipt_address TEXT)");
    await assert.rejects(cli(["export-postgres", join(dir, "rogue.ndjson")], legacyEnv), /receipt_requests exists before its recorded migration/);
    return { tables: 13, paymentRows: 105, interruptedImportResumed: true, failedRestoreRolledBack: true };
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const client of clients) await client.end();
    if (started) await exec("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    await rm(dir, { recursive: true, force: true });
  }
}
