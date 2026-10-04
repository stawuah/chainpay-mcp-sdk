// node --test programs/support-splitter/scripts/check-release.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { releaseProblems, TEST_KEYS, USDC } from "./check-release.mjs";
import { base58Decode } from "./read-setup.mjs";

const key = (address) => Buffer.from(base58Decode(address));
const binary = (...addresses) => Buffer.concat([Buffer.alloc(64, 7), ...addresses.map(key), Buffer.alloc(64, 9)]);

test("refuses a test-config build (review F8)", () => {
  const problems = releaseProblems(binary(TEST_KEYS["test RECIPIENT_A"], TEST_KEYS["test RECIPIENT_B"], TEST_KEYS["test USDC mint"]));
  assert.equal(problems.filter((p) => /test-config build/.test(p)).length, 3);
  assert.ok(problems.some((p) => /mainnet USDC mint/.test(p)));
});

test("accepts a release build with the official mint for its cluster", () => {
  assert.deepEqual(releaseProblems(binary(USDC.mainnet)), []);
  assert.deepEqual(releaseProblems(binary(USDC.devnet), { cluster: "devnet" }), []);
  assert.match(releaseProblems(binary(USDC.devnet))[0], /mainnet USDC mint/);
});

test("the real test build in target/splitter-test is refused", { skip: !existsSync(new URL("../../../target/splitter-test/support_splitter.so", import.meta.url)) }, () => {
  const so = readFileSync(new URL("../../../target/splitter-test/support_splitter.so", import.meta.url));
  assert.ok(releaseProblems(so).some((p) => /test-config build/.test(p)));
});
