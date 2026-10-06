import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, deriveAssociatedTokenAddress } from "@chainpayhq/sdk";
import { loadMerchantConfig, standardV2PaymentRequired } from "../dist/config.js";
import { assertV2RecipientAccount } from "../dist/bootstrap.js";
import { vercelMerchantEnvironment } from "../dist/vercel.js";

const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const address = () => Keypair.generate().publicKey.toBase58();

function v2Env(overrides = {}) {
  const owner = address();
  return {
    owner,
    env: {
      CHAINPAY_X402_CHALLENGE_SHAPE: "v2",
      CHAINPAY_X402_MINT: MINT,
      CHAINPAY_X402_ALLOWED_AGENT: address(),
      CHAINPAY_X402_MERCHANT_OWNER: owner,
      CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT: deriveAssociatedTokenAddress(owner, MINT, "spl-token"),
      ...overrides,
    },
  };
}

test("v2 mode refuses to start without an explicit merchant owner", () => {
  const { env } = v2Env();
  delete env.CHAINPAY_X402_MERCHANT_OWNER;
  // The old default paid the agent's own token account.
  assert.throws(() => loadMerchantConfig(env), /CHAINPAY_X402_MERCHANT_OWNER is required when CHAINPAY_X402_CHALLENGE_SHAPE=v2/);
});

test("v2 mode refuses the agent as merchant owner", () => {
  const { env } = v2Env();
  const agentOwned = {
    ...env,
    CHAINPAY_X402_MERCHANT_OWNER: env.CHAINPAY_X402_ALLOWED_AGENT,
    CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT: deriveAssociatedTokenAddress(env.CHAINPAY_X402_ALLOWED_AGENT, MINT, "spl-token"),
  };
  assert.throws(() => loadMerchantConfig(agentOwned), /not CHAINPAY_X402_ALLOWED_AGENT/);
});

test("v2 mode requires the recipient to be the merchant owner's ATA for the mint", () => {
  const { env, owner } = v2Env();
  assert.throws(
    () => loadMerchantConfig({ ...env, CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT: address() }),
    /must be the associated token account of CHAINPAY_X402_MERCHANT_OWNER/,
  );
  // Right owner, wrong token program: a different ATA.
  assert.throws(
    () => loadMerchantConfig({ ...env, CHAINPAY_X402_TOKEN_PROGRAM: "token-2022" }),
    /must be the associated token account/,
  );
  const config = loadMerchantConfig(env);
  assert.equal(config.merchantOwner, owner);
  assert.equal(config.recipient, env.CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT);
  assert.equal(standardV2PaymentRequired(config).accepts[0].payTo, owner);
});

test("custom mode needs no merchant owner", () => {
  const config = loadMerchantConfig({
    CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT: address(),
    CHAINPAY_X402_ALLOWED_AGENT: address(),
  });
  assert.equal(config.challengeShape, "custom");
  assert.equal(config.merchantOwner, undefined);
});

test("listen host defaults to loopback and is configurable", () => {
  const base = { CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT: address(), CHAINPAY_X402_ALLOWED_AGENT: address() };
  assert.equal(loadMerchantConfig(base).host, "127.0.0.1");
  assert.equal(loadMerchantConfig({ ...base, CHAINPAY_MERCHANT_HOST: "0.0.0.0" }).host, "0.0.0.0");
  assert.equal(loadMerchantConfig({ ...base, CHAINPAY_MERCHANT_HOST: "::" }).host, "::");
  assert.throws(() => loadMerchantConfig({ ...base, CHAINPAY_MERCHANT_HOST: "0.0.0.0 ; rm" }), /CHAINPAY_MERCHANT_HOST/);
});

function tokenAccountData({ mint, owner }) {
  const data = new Uint8Array(165);
  data.set(new PublicKey(mint).toBytes(), 0);
  data.set(new PublicKey(owner).toBytes(), 32);
  return data;
}

test("v2 startup checks the live recipient token account", () => {
  const { env, owner } = v2Env();
  const config = loadMerchantConfig(env);
  const good = { owner: SPL_TOKEN_PROGRAM_ID, data: tokenAccountData({ mint: MINT, owner }) };
  assert.doesNotThrow(() => assertV2RecipientAccount(config, good));
  assert.throws(() => assertV2RecipientAccount(config, null), /does not exist yet/);
  assert.throws(() => assertV2RecipientAccount(config, { ...good, owner: TOKEN_2022_PROGRAM_ID }), /spl-token token program/);
  assert.throws(
    () => assertV2RecipientAccount(config, { ...good, data: tokenAccountData({ mint: address(), owner }) }),
    /different mint/,
  );
  assert.throws(
    () => assertV2RecipientAccount(config, { ...good, data: tokenAccountData({ mint: MINT, owner: address() }) }),
    /not CHAINPAY_X402_MERCHANT_OWNER/,
  );
  assert.throws(() => assertV2RecipientAccount(config, { ...good, data: new Uint8Array(10) }), /not a token account/);
  // Custom mode never asks.
  const custom = { ...config, challengeShape: "custom" };
  assert.doesNotThrow(() => assertV2RecipientAccount(custom, null));
});

test("Vercel entry derives the resource URL only on production", () => {
  assert.equal(
    vercelMerchantEnvironment({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "merchant.example" }).CHAINPAY_X402_RESOURCE_URL,
    "https://merchant.example/data",
  );
  assert.equal(
    vercelMerchantEnvironment({ CHAINPAY_X402_RESOURCE_URL: "https://x.example/data", VERCEL_ENV: "preview" }).CHAINPAY_X402_RESOURCE_URL,
    "https://x.example/data",
  );
  assert.throws(() => vercelMerchantEnvironment({ VERCEL_ENV: "preview", VERCEL_PROJECT_PRODUCTION_URL: "merchant.example" }), /CHAINPAY_X402_RESOURCE_URL is required/);
});

test("web3.js resolves the pinned rpc-websockets (newer ones require ESM-only uuid)", () => {
  const require = createRequire(import.meta.url);
  const web3 = dirname(require.resolve("@solana/web3.js/package.json"));
  // rpc-websockets does not export ./package.json; find its root from its entry.
  const entry = createRequire(`${web3}/package.json`).resolve("rpc-websockets");
  const root = entry.slice(0, entry.lastIndexOf("/rpc-websockets/") + "/rpc-websockets".length);
  const { version } = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
  assert.equal(version, "9.3.7");
});
