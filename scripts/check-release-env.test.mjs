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
