import test from "node:test";
import assert from "node:assert/strict";
import { checkReleaseEnvironment } from "./check-release-env.mjs";
const env = { VERCEL_ENV: "preview", CHAINPAY_RELEASE_ENVIRONMENT: "preview", CHAINPAY_CONVEX_DEPLOYMENT_TYPE: "preview", CHAINPAY_RELEASE_GROUP: "pr-28", CHAINPAY_STORAGE: "convex", CHAINPAY_CONVEX_SITE_URL: "https://example.convex.site", CHAINPAY_CONVEX_BACKEND_SECRET: "b".repeat(32), CHAINPAY_ALLOWED_ORIGINS: "https://web.example.com", CHAINPAY_RPC_URL: "https://rpc.example.com" };
test("build refuses missing credentials, mixed environments, and wildcard CORS", () => {
  assert.equal(checkReleaseEnvironment("backend", env).environment, "preview");
  for (const change of [{CHAINPAY_CONVEX_BACKEND_SECRET:""}, {CHAINPAY_CONVEX_DEPLOYMENT_TYPE:"prod"}, {VERCEL_ENV:"production"}, {CHAINPAY_ALLOWED_ORIGINS:"https://*.vercel.app"}, {CHAINPAY_STORAGE:"postgres"}]) assert.throws(() => checkReleaseEnvironment("backend", {...env, ...change}));
});
test("frontend cannot build using implicit review-stack defaults", () => {
  assert.throws(() => checkReleaseEnvironment("frontend", env), /VITE_CHAINPAY_BACKEND_URL/);
  const frontend = {...env, VITE_CHAINPAY_BACKEND_URL:"https://relay.example.com", VITE_CHAINPAY_RPC_URL:"https://relay.example.com/rpc", VITE_CHAINPAY_MCP_URL:"https://mcp.example.com/mcp", VITE_CHAINPAY_AGENT_URL:"https://mcp.example.com/agent/chat"};
  assert.equal(checkReleaseEnvironment("frontend",frontend).service,"frontend");
  assert.throws(() => checkReleaseEnvironment("frontend",{...frontend,VITE_CHAINPAY_RPC_URL:"https://wrong.example.com/rpc"}), /one relay/);
  assert.throws(() => checkReleaseEnvironment("frontend",{...frontend,VITE_CHAINPAY_AGENT_URL:"https://wrong.example.com/agent/chat"}), /one relay/);
});
test("production cannot relabel a dev database or use unpaired service origins", () => {
  const production = {...env, VERCEL_ENV:"production", CHAINPAY_RELEASE_ENVIRONMENT:"production", CHAINPAY_CONVEX_DEPLOYMENT_TYPE:"prod", CHAINPAY_RELEASE_GROUP:"chainpay-production-v1", CHAINPAY_CONVEX_SITE_URL:"https://notable-bee-447.convex.site", CHAINPAY_ALLOWED_ORIGINS:"https://www.chainpayai.app,https://chainpayai.app,https://chainpay-web-kappa.vercel.app"};
  assert.equal(checkReleaseEnvironment("backend",production).environment,"production");
  for (const changes of [{CHAINPAY_CONVEX_SITE_URL:"https://dev-db.convex.site"},{CHAINPAY_RELEASE_GROUP:"different"},{CHAINPAY_ALLOWED_ORIGINS:"https://other.example.com"}]) assert.throws(()=>checkReleaseEnvironment("backend",{...production,...changes}), /reviewed production/);
  const mcp={...production, CHAINPAY_CONVEX_MCP_SECRET:"m".repeat(32),CHAINPAY_BACKEND_URL:"https://chainpay-relay.vercel.app",CHAINPAY_RPC_URL:"https://chainpay-relay.vercel.app/rpc",CHAINPAY_APP_URL:"https://www.chainpayai.app"};
  assert.equal(checkReleaseEnvironment("mcp",mcp).service,"mcp");
  assert.throws(()=>checkReleaseEnvironment("mcp",{...mcp,CHAINPAY_BACKEND_URL:"https://wrong.example.com",CHAINPAY_RPC_URL:"https://wrong.example.com/rpc"}),/reviewed production/);
});
test("card connector needs its secrets and runs on Devnet + Lithic sandbox only", () => {
  const cards = {...env, CARDS_CONNECTOR_ENABLED: "true", LITHIC_SANDBOX_API_KEY: "k", CARDS_AUTHORIZER_KEY: "a", CARDS_RECORD_KID: "k1", CARDS_RECORD_KEY_k1: "x", LITHIC_ASA_SECRET: "whsec_x", LITHIC_EVENTS_SECRET: "whsec_y", CRON_SECRET: "c".repeat(16)};
  assert.equal(checkReleaseEnvironment("backend", cards).service, "backend");
  for (const key of ["CARDS_AUTHORIZER_KEY", "LITHIC_ASA_SECRET", "CARDS_RECORD_KEY_k1", "CRON_SECRET"]) assert.throws(() => checkReleaseEnvironment("backend", {...cards, [key]: ""}));
  assert.throws(() => checkReleaseEnvironment("backend", {...cards, CRON_SECRET: "short"}), /16/);
  assert.throws(() => checkReleaseEnvironment("backend", {...cards, CARDS_CHECKOUT_RUNNER_SECRET: "short"}), /32/);
  assert.throws(() => checkReleaseEnvironment("backend", {...cards, CHAINPAY_CLUSTER: "mainnet-beta"}), /Devnet only/);
  assert.equal(checkReleaseEnvironment("backend", {...cards, CHAINPAY_CLUSTER: "devnet"}).service, "backend");
  assert.throws(() => checkReleaseEnvironment("backend", {...cards, CARDS_TEE_ATTESTATION_MODE: "off"}), /enforce or report/);
  assert.equal(checkReleaseEnvironment("backend", {...cards, CARDS_TEE_ATTESTATION_MODE: "report"}).service, "backend");
  for (const url of ["https://api.lithic.com", "https://api.lithic.com.", "https://API.LITHIC.COM:443", "http://sandbox.lithic.com"]) assert.throws(() => checkReleaseEnvironment("backend", {...cards, LITHIC_API_URL: url}), /sandbox\.lithic\.com/, url);
  assert.equal(checkReleaseEnvironment("backend", {...cards, LITHIC_API_URL: "https://sandbox.lithic.com."}).service, "backend");
});

const productionBackend = {...env, VERCEL_ENV:"production", CHAINPAY_RELEASE_ENVIRONMENT:"production", CHAINPAY_CONVEX_DEPLOYMENT_TYPE:"prod", CHAINPAY_RELEASE_GROUP:"chainpay-production-v1", CHAINPAY_CONVEX_SITE_URL:"https://notable-bee-447.convex.site", CHAINPAY_ALLOWED_ORIGINS:"https://www.chainpayai.app,https://chainpayai.app,https://chainpay-web-kappa.vercel.app"};
const productionCards = {...productionBackend, CARDS_CONNECTOR_ENABLED:"true", CHAINPAY_CLUSTER:"devnet", LITHIC_API_URL:"https://sandbox.lithic.com", LITHIC_SANDBOX_API_KEY:"sandbox-key", CARDS_AUTHORIZER_KEY:"a", CARDS_RECORD_KID:"k1", CARDS_RECORD_KEY_k1:"x", LITHIC_ASA_SECRET:"whsec_x", LITHIC_EVENTS_SECRET:"whsec_y", CRON_SECRET:"c".repeat(16)};

test("the public Devnet MVP (Vercel production) allows cards only on Devnet + the Lithic sandbox", () => {
  assert.equal(checkReleaseEnvironment("backend", productionCards).environment, "production");
  // Default stays off: production without the flag, or with it false, needs none of the card config.
  assert.equal(checkReleaseEnvironment("backend", productionBackend).environment, "production");
  assert.equal(checkReleaseEnvironment("backend", {...productionBackend, CARDS_CONNECTOR_ENABLED: "false"}).environment, "production");
  assert.throws(() => checkReleaseEnvironment("backend", {...productionBackend, CARDS_CONNECTOR_ENABLED: "yes"}), /true or false/);
  assert.equal(checkReleaseEnvironment("backend", {...productionBackend, CARDS_NEW_ACTIVATION_ENABLED: "false"}).environment, "production");
  assert.throws(() => checkReleaseEnvironment("backend", {...productionBackend, CARDS_NEW_ACTIVATION_ENABLED: "off"}), /CARDS_NEW_ACTIVATION_ENABLED must be true or false/);
  assert.throws(() => checkReleaseEnvironment("backend", {...productionCards, CHAINPAY_CLUSTER: "mainnet-beta"}), /Devnet only/);
  // The sandbox host and the sandbox key must be explicit in production.
  assert.throws(() => checkReleaseEnvironment("backend", {...productionCards, LITHIC_API_URL: ""}), /LITHIC_API_URL is required/);
  assert.throws(() => checkReleaseEnvironment("backend", {...productionCards, LITHIC_API_URL: "https://example.com"}), /sandbox\.lithic\.com/);
  assert.throws(() => checkReleaseEnvironment("backend", {...productionCards, LITHIC_SANDBOX_API_KEY: ""}), /LITHIC_SANDBOX_API_KEY/);
  assert.throws(() => checkReleaseEnvironment("backend", {...productionCards, CARDS_TEE_ATTESTATION_MODE: "report"}), /enforce/);
  assert.equal(checkReleaseEnvironment("backend", {...productionCards, LITHIC_API_URL: "https://sandbox.lithic.com."}).environment, "production");
});

test("real Lithic production endpoints and keys are refused in every environment", () => {
  const productionUrls = ["https://api.lithic.com", "https://api.lithic.com/v1", "https://API.LITHIC.COM:443", "https://api.lithic.com.", "api.lithic.com"];
  for (const base of [productionCards, productionBackend, {...env}]) {
    for (const url of productionUrls) {
      for (const name of ["LITHIC_API_URL", "LITHIC_BASE_URL", "CARDS_ISSUER_URL"]) {
        assert.throws(() => checkReleaseEnvironment("backend", {...base, [name]: url}), /Lithic production API|sandbox\.lithic\.com/, `${name}=${url}`);
      }
    }
    for (const name of ["LITHIC_PRODUCTION_API_KEY", "LITHIC_LIVE_API_KEY", "LITHIC_PROD_KEY"]) {
      assert.throws(() => checkReleaseEnvironment("backend", {...base, [name]: "k"}), /production Lithic key/, name);
    }
  }
  // The generic LITHIC_API_KEY name is refused in production (it is how Lithic names live keys).
  assert.throws(() => checkReleaseEnvironment("backend", {...productionCards, LITHIC_API_KEY: "k"}), /production Lithic key/);
  // Lookalike hosts are not the production API.
  assert.equal(checkReleaseEnvironment("backend", {...env, SOME_URL: "https://sandbox.lithic.com"}).service, "backend");
  assert.equal(checkReleaseEnvironment("backend", {...env, SOME_URL: "https://myapi.lithic.company"}).service, "backend");
  // Frontend and MCP builds get the same scan.
  assert.throws(() => checkReleaseEnvironment("frontend", {...env, VITE_LITHIC_URL: "https://api.lithic.com"}), /Lithic production API/);
});
test("owner webhooks need a sealing key, the dispatcher secret and the public origin", () => {
  const hooks = {...env, OWNER_WEBHOOKS_ENABLED: "true", OWNER_WEBHOOKS_SECRET_KID: "w1", OWNER_WEBHOOKS_SECRET_KEY_w1: Buffer.alloc(32, 7).toString("base64"), CRON_SECRET: "c".repeat(16), CHAINPAY_APP_URL: "https://web.example.com"};
  assert.equal(checkReleaseEnvironment("backend", hooks).service, "backend");
  assert.equal(checkReleaseEnvironment("backend", {...env, OWNER_WEBHOOKS_ENABLED: "false"}).service, "backend");
  assert.throws(() => checkReleaseEnvironment("backend", {...hooks, OWNER_WEBHOOKS_ENABLED: "yes"}), /true or false/);
  for (const key of ["OWNER_WEBHOOKS_SECRET_KID", "OWNER_WEBHOOKS_SECRET_KEY_w1", "CRON_SECRET", "CHAINPAY_APP_URL"]) assert.throws(() => checkReleaseEnvironment("backend", {...hooks, [key]: ""}), undefined, key);
  assert.throws(() => checkReleaseEnvironment("backend", {...hooks, OWNER_WEBHOOKS_SECRET_KEY_w1: "c2hvcnQ="}), /32 bytes/);
  assert.throws(() => checkReleaseEnvironment("backend", {...hooks, CRON_SECRET: "short"}), /16/);
  assert.throws(() => checkReleaseEnvironment("backend", {...hooks, CHAINPAY_APP_URL: "http://web.example.com"}), /HTTPS/);
});

const frontendBase = {...env, VITE_CHAINPAY_BACKEND_URL:"https://relay.example.com", VITE_CHAINPAY_RPC_URL:"https://relay.example.com/rpc", VITE_CHAINPAY_MCP_URL:"https://mcp.example.com/mcp", VITE_CHAINPAY_AGENT_URL:"https://mcp.example.com/agent/chat"};
const supportLive = {...frontendBase, VITE_SUPPORT_LIVE:"true", VITE_SUPPORT_CLUSTER:"devnet", VITE_SUPPORT_PROGRAM_ID:"D1DvnVq37696mcFB5JeVWZy22wjxZ5xPJmZazbfPK7BH", VITE_SUPPORT_TRACKER_URL:"https://example-123.convex.site/support/v1", VITE_SUPPORT_RECIPIENT_A:"3yS1JFVT284y8z1LC9MRoWxZjzFrdoD5axKsZiyMsfC7", VITE_SUPPORT_RECIPIENT_B:"4iYFsZcZXQLTfykuzRwY19SxRja53Vm6jSf6CuTx6Kjt"};

test("support tips stay closed unless fully configured for Devnet; mainnet support is refused", () => {
  // Off (unset or false) needs none of the support config.
  assert.equal(checkReleaseEnvironment("frontend", frontendBase).service, "frontend");
  assert.equal(checkReleaseEnvironment("frontend", {...frontendBase, VITE_SUPPORT_LIVE:"false"}).service, "frontend");
  assert.equal(checkReleaseEnvironment("frontend", supportLive).service, "frontend");
  assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_LIVE:"yes"}), /true or false/);
  // Mainnet (or anything but devnet) is refused, live or not; an absent cluster can't go live.
  for (const cluster of ["mainnet", "mainnet-beta", "Devnet", "testnet"]) {
    assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_CLUSTER:cluster}), /Devnet only/, cluster);
    assert.throws(() => checkReleaseEnvironment("frontend", {...frontendBase, VITE_SUPPORT_CLUSTER:cluster}), /Devnet only/, `${cluster} while off`);
  }
  assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_CLUSTER:undefined}), /VITE_SUPPORT_CLUSTER=devnet/);
  // Program, tracker and both recipients are required, real and distinct.
  for (const key of ["VITE_SUPPORT_PROGRAM_ID", "VITE_SUPPORT_TRACKER_URL", "VITE_SUPPORT_RECIPIENT_A", "VITE_SUPPORT_RECIPIENT_B"]) {
    assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, [key]:""}), new RegExp(key), key);
  }
  for (const bad of ["11111111111111111111111111111111", "7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9", "not-a-key", "0OIl"]) {
    assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_RECIPIENT_A:bad}), /real public key/, bad);
    assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_PROGRAM_ID:bad}), /real public key/, bad);
  }
  assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_RECIPIENT_B:supportLive.VITE_SUPPORT_RECIPIENT_A}), /must differ/);
  for (const url of ["http://example-123.convex.site/support/v1", "https://example-123.convex.site/support", "https://evil.example.com/support/v1", "https://example-123.convex.site/support/v1?x=1"]) {
    assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_TRACKER_URL:url}), /convex\.site\/support\/v1/, url);
  }
  // An RPC override must be keyless and Devnet: everything in VITE_* ships to the browser.
  assert.equal(checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_RPC_URL:"https://api.devnet.solana.com"}).service, "frontend");
  assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_RPC_URL:"https://devnet.helius-rpc.com/?api-key=secret"}), /keyless/);
  assert.throws(() => checkReleaseEnvironment("frontend", {...supportLive, VITE_SUPPORT_RPC_URL:"https://api.mainnet-beta.solana.com"}), /Devnet RPC/);
});
