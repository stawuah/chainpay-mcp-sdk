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
test("card connector needs its secrets and never runs in production", () => {
  const cards = {...env, CARDS_CONNECTOR_ENABLED: "true", LITHIC_SANDBOX_API_KEY: "k", CARDS_AUTHORIZER_KEY: "a", CARDS_RECORD_KID: "k1", CARDS_RECORD_KEY_k1: "x", LITHIC_ASA_SECRET: "whsec_x", LITHIC_EVENTS_SECRET: "whsec_y", CRON_SECRET: "c".repeat(16)};
  assert.equal(checkReleaseEnvironment("backend", cards).service, "backend");
  for (const key of ["CARDS_AUTHORIZER_KEY", "LITHIC_ASA_SECRET", "CARDS_RECORD_KEY_k1", "CRON_SECRET"]) assert.throws(() => checkReleaseEnvironment("backend", {...cards, [key]: ""}));
  assert.throws(() => checkReleaseEnvironment("backend", {...cards, CRON_SECRET: "short"}), /16/);
  assert.throws(() => checkReleaseEnvironment("backend", {...cards, CARDS_CHECKOUT_RUNNER_SECRET: "short"}), /32/);
  assert.throws(() => checkReleaseEnvironment("backend", {...cards, VERCEL_ENV: "production", CHAINPAY_RELEASE_ENVIRONMENT: "production", CHAINPAY_CONVEX_DEPLOYMENT_TYPE: "prod"}), /sandbox-only/);
  assert.throws(() => checkReleaseEnvironment("backend", {...cards, CARDS_TEE_ATTESTATION_MODE: "off"}), /enforce or report/);
  assert.equal(checkReleaseEnvironment("backend", {...cards, CARDS_TEE_ATTESTATION_MODE: "report"}).service, "backend");
  for (const url of ["https://api.lithic.com", "https://api.lithic.com.", "https://API.LITHIC.COM:443", "http://sandbox.lithic.com"]) assert.throws(() => checkReleaseEnvironment("backend", {...cards, LITHIC_API_URL: url}), /sandbox\.lithic\.com/, url);
  assert.equal(checkReleaseEnvironment("backend", {...cards, LITHIC_API_URL: "https://sandbox.lithic.com."}).service, "backend");
});
