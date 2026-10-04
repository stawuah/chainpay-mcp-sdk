#!/usr/bin/env node
// card-sim: replay Lithic-shaped, correctly signed ASA requests and event
// webhooks against a ChainPay relay (contracts.md CD-7). The same scenario
// files run in CI through the Rust connector tests
// (backend/src/connectors/card_issuer/tests.rs).
//
//   node scripts/card-sim/card-sim.mjs --url http://127.0.0.1:8080 \
//     --scenario scripts/card-sim/scenarios/approve_decline_duplicate.json \
//     --card-token <lithic card token> [--agent-token <mcp connection token>] \
//     [--truth-port 4010]
//
// Secrets come from the environment only: LITHIC_ASA_SECRET and
// LITHIC_EVENTS_SECRET (whsec_...). Nothing secret is printed. With
// --truth-port the script also serves GET /v1/transactions[/:token] from the
// scenario's accumulated issuer truth; point the relay's LITHIC_API_URL at it
// to replay flows Lithic cannot simulate (force posts, disputes, reordering).
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const MERCHANTS = {
  "demo-approved": { acceptor: "DEMO-DATAAPI", descriptor: "DATA API CREDITS", mcc: "5734" },
  "demo-unapproved": { acceptor: "DEMO-OTHERSHOP", descriptor: "UNAPPROVED SHOP", mcc: "5999" },
};

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, all) => (value.startsWith("--") ? [...pairs, [value.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]] : pairs), []));
if (!args.url || !args.scenario || !args["card-token"]) {
  console.error("usage: card-sim.mjs --url <relay> --scenario <file> --card-token <token> [--agent-token <t>] [--truth-port <p>]");
  process.exit(2);
}

export function sign(secret, id, timestamp, raw) {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`).digest("base64");
}

async function post(path, secretName, id, body) {
  const secret = process.env[secretName];
  if (!secret) throw new Error(`${secretName} is not set`);
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetch(`${args.url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": sign(secret, id, timestamp, raw) },
    body: raw,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

const scenario = JSON.parse(readFileSync(args.scenario, "utf8"));
const run = randomUUID().slice(0, 8);
const tokens = new Map();
const tokenFor = (name) => tokens.get(name) ?? (tokens.set(name, randomUUID()), tokens.get(name));
const truth = new Map();
let clock = 0;
const created = () => new Date(Date.UTC(2026, 9, 4, 0, 0, 1) + ++clock).toISOString();

if (args["truth-port"]) {
  createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const match = url.pathname.match(/^\/v1\/transactions\/([^/]+)$/);
    if (match) return truth.has(match[1]) ? send(200, truth.get(match[1])) : send(404, { code: "not_found" });
    if (url.pathname === "/v1/transactions") return send(200, { data: [...truth.values()].filter((t) => t.card_token === url.searchParams.get("card_token")), has_more: false });
    send(404, { code: "not_found" });
  }).listen(Number(args["truth-port"]), "127.0.0.1");
}

function asaBody(token, amount, merchant, status) {
  const m = MERCHANTS[merchant];
  return {
    token, status,
    amounts: { cardholder: { amount, currency: "USD", conversion_rate: "1.0" }, merchant: { amount, currency: "USD" }, hold: null, settlement: null },
    acquirer_fee: 0, cash_amount: 0,
    merchant: { acceptor_id: m.acceptor, acquiring_institution_id: "191231", mcc: m.mcc, descriptor: m.descriptor, city: "NEW YORK", state: "NY", country: "USA" },
    card: { token: args["card-token"], last_four: "0000", memo: "card-sim", spend_limit: 0, spend_limit_duration: "TRANSACTION", state: "OPEN", type: "VIRTUAL" },
    transaction_initiator: "CARDHOLDER", avs: { address: "", zipcode: "" }, name_validation: null, service_location: null, created: created(),
  };
}

const snapshots = new Map();
let failures = 0;
for (const [index, step] of scenario.steps.entries()) {
  const label = `${scenario.name}#${index}`;
  if (step.intent) {
    if (!args["agent-token"]) { console.log(`${label} skip intent (no --agent-token)`); continue; }
    const cardId = args["card-id"];
    const response = await fetch(`${args.url}/v1/cards/${cardId}/checkout-intents`, { method: "POST", headers: { authorization: `Bearer ${args["agent-token"]}`, "content-type": "application/json" }, body: JSON.stringify({ clientOperationId: `sim-${run}-${index}`, merchantRef: step.intent.merchant, amountCents: step.intent.amountCents, currency: "USD" }) });
    console.log(`${label} intent ${response.status}`);
  } else if (step.asa) {
    const token = tokenFor(step.asa.txn);
    const status = step.asa.status ?? "AUTHORIZATION";
    const result = await post("/v1/cards/lithic/asa", "LITHIC_ASA_SECRET", `asa_${run}_${index}`, asaBody(token, step.asa.amountCents, step.asa.merchant, status));
    const ok = !step.expect || result.body?.result === step.expect;
    failures += ok ? 0 : 1;
    console.log(`${label} asa ${step.asa.txn} -> ${result.status} ${result.body?.result}${ok ? "" : ` (expected ${step.expect})`}`);
    if (!truth.has(token)) {
      const approved = result.body?.result === "APPROVED";
      const m = MERCHANTS[step.asa.merchant];
      truth.set(token, { token, card_token: args["card-token"], status: approved ? "PENDING" : "DECLINED", result: approved ? "APPROVED" : "DECLINED", merchant: { acceptor_id: m.acceptor, descriptor: m.descriptor, mcc: m.mcc }, events: [{ token: randomUUID(), type: status, amount: step.asa.amountCents, amounts: { cardholder: { amount: step.asa.amountCents, currency: "USD" } }, result: approved ? "APPROVED" : "DECLINED", effective_polarity: "DEBIT", created: created() }] });
    }
  } else if (step.event || step.forcePost) {
    const e = step.event ?? { ...step.forcePost, type: "CLEARING" };
    const token = tokenFor(e.txn);
    if (!truth.has(token)) truth.set(token, { token, card_token: args["card-token"], status: "SETTLED", result: "APPROVED", merchant: { acceptor_id: MERCHANTS[e.merchant ?? "demo-unapproved"].acceptor }, events: [] });
    const t = truth.get(token);
    t.events.push({ token: randomUUID(), type: e.type, amount: e.amountCents, amounts: { cardholder: { amount: e.amountCents, currency: "USD" } }, result: "APPROVED", effective_polarity: e.polarity ?? "DEBIT", created: created() });
    console.log(`${label} truth ${e.txn} += ${e.type}`);
  } else if (step.snapshot) {
    snapshots.set(step.snapshot.as, structuredClone(truth.get(tokenFor(step.snapshot.txn))));
  } else if (step.deliver) {
    const body = { ...(step.deliver.snapshot ? snapshots.get(step.deliver.snapshot) : truth.get(tokenFor(step.deliver.txn))), event_type: "card_transaction.updated" };
    const result = await post("/v1/cards/lithic/events", "LITHIC_EVENTS_SECRET", `sim_${run}_${step.deliver.webhookId}`, body);
    console.log(`${label} deliver ${step.deliver.webhookId} -> ${result.status} ${JSON.stringify(result.body)}`);
  } else if (step.dispute) {
    const body = { event_type: "dispute.updated", token: randomUUID(), transaction_token: tokenFor(step.dispute.txn), status: step.dispute.status };
    const result = await post("/v1/cards/lithic/events", "LITHIC_EVENTS_SECRET", `sim_${run}_${step.dispute.webhookId}`, body);
    console.log(`${label} dispute ${step.dispute.status} -> ${result.status}`);
  } else {
    console.log(`${label} skip ${Object.keys(step)[0]} (checked by the Rust suite)`);
  }
}
console.log(failures ? `${failures} expectation(s) failed` : "replay complete");
if (!args["truth-port"]) process.exit(failures ? 1 : 0);
