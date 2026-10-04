#!/usr/bin/env node
// Refuses a support-splitter .so that must never be deployed. Run it on the exact
// file you are about to deploy (DEPLOY.md gates 2 and 3):
//   node programs/support-splitter/scripts/check-release.mjs <file.so> [--devnet]
//
// It fails when the file:
//   - contains a throwaway test-config key (the public test seeds [11;32], [22;32], [33;32]),
//   - doesn't contain the official USDC mint for the cluster.
// The compiler may inline the recipient keys, so they can't be found reliably in
// the bytes; gate 3 checks them on the initialized vault instead.
// It reads bytes only; it never signs or sends anything.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { base58Decode } from "./read-setup.mjs";

export const TEST_KEYS = {
  "test RECIPIENT_A": "7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9",
  "test RECIPIENT_B": "6TcyBfPdBt1kjsvDZLzmBFnuMaLWiTaAt4RjUr9VA5YD",
  "test USDC mint": "AB3FQHskSYuWVw4M9EpGdxNzrAjBNiYGpbH4CVzLFene",
};
export const USDC = { mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" };

const contains = (bytes, address) => Buffer.from(bytes).indexOf(Buffer.from(base58Decode(address))) >= 0;

/** Returns the reasons this binary must not be deployed (empty when it's fine). */
export function releaseProblems(bytes, { cluster = "mainnet" } = {}) {
  const problems = [];
  for (const [label, address] of Object.entries(TEST_KEYS)) {
    if (contains(bytes, address)) problems.push(`contains the ${label} (${address}): this is a test-config build`);
  }
  if (!contains(bytes, USDC[cluster])) problems.push(`doesn't contain the ${cluster} USDC mint ${USDC[cluster]}`);
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  if (!file || file.startsWith("--")) {
    console.error("usage: check-release.mjs <file.so> [--devnet]");
    process.exit(2);
  }
  const problems = releaseProblems(readFileSync(file), { cluster: args.includes("--devnet") ? "devnet" : "mainnet" });
  if (problems.length) {
    console.error(`REFUSED ${file}:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`OK ${file}: no test keys, official USDC mint present.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
