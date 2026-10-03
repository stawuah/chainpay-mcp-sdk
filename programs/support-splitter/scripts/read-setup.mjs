#!/usr/bin/env node
// Reads the support-splitter setup comments on a GitHub PR and prints the
// recipient addresses that pass every check. This output is the ONLY source
// an agent or a person should use to fill RECIPIENT_A / RECIPIENT_B.
//
// A setup comment counts only if:
//   - it was posted by the GitHub account expected for that side,
//   - it has never been edited (created_at === updated_at),
//   - its ed25519 signature verifies for the posted address over the exact
//     message, which includes this PR number (so it can't be replayed).
//
// Usage:
//   node programs/support-splitter/scripts/read-setup.mjs <pr-number> [--apply]
// --apply writes the verified keys into programs/support-splitter/src/lib.rs.
// Needs `gh` logged in. No dependencies beyond Node 20+.

import { execFileSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REPO = "stawuah/chainpay-mcp-sdk";
export const SIDES = { A: "tantshirt", B: "stawuah" };
const MARKER = "<!-- support-setup:v1 -->";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(text) {
  let bytes = [0];
  for (const char of text) {
    const value = B58.indexOf(char);
    if (value < 0) throw new Error(`not base58: ${char}`);
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

export function expectedMessage(side, address, pr) {
  return `chainpay-support:v1 recipient=${side} address=${address} pr=${pr}`;
}

// The Solana CLI (`solana sign-offchain-message`) wraps the text in the
// off-chain message envelope; browser wallets (signMessage) sign raw bytes.
// Accept either, for the same exact text.
function signedPayloads(text, signer) {
  const message = Buffer.from(text, "utf8");
  const domain = Buffer.concat([Buffer.from([0xff]), Buffer.from("solana offchain", "ascii")]);
  const len = Buffer.alloc(2);
  len.writeUInt16LE(message.length);
  const format = /^[\x20-\x7e]*$/.test(text) ? 0 : 1;
  const legacy = Buffer.concat([domain, Buffer.from([0, format]), len, message]);
  const v0 = Buffer.concat([
    domain,
    Buffer.from([0]),
    Buffer.alloc(32),
    Buffer.from([format, 1]),
    Buffer.from(signer),
    len,
    message,
  ]);
  return [message, legacy, v0];
}

export function verifySignature(text, address, signature) {
  const key = base58Decode(address);
  const sig = base58Decode(signature);
  if (key.length !== 32 || sig.length !== 64) return false;
  const publicKey = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(key).toString("base64url") },
    format: "jwk",
  });
  return signedPayloads(text, key).some((payload) => verify(null, payload, publicKey, sig));
}

export function parseComment(body) {
  if (!body.includes(MARKER)) return null;
  const field = (name) => body.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, "m"))?.[1];
  return {
    side: field("side"),
    address: field("address"),
    message: field("message"),
    signature: field("signature"),
  };
}

/** Returns { side, address } or { reason } for one GitHub comment. */
export function checkComment(comment, pr) {
  const parsed = parseComment(comment.body ?? "");
  if (!parsed) return null;
  const { side, address, message, signature } = parsed;
  const author = comment.user?.login;
  if (!SIDES[side]) return { reason: `unknown side ${JSON.stringify(side)}` };
  if (author !== SIDES[side]) return { reason: `side ${side} must be posted by @${SIDES[side]}, not @${author}` };
  if (comment.created_at !== comment.updated_at) return { reason: "comment was edited; post a fresh one instead" };
  if (!address || !signature) return { reason: "missing address or signature" };
  const expected = expectedMessage(side, address, pr);
  if (message !== expected) return { reason: `message must be exactly: ${expected}` };
  let ok = false;
  try {
    ok = verifySignature(expected, address, signature);
  } catch (error) {
    return { reason: `bad encoding: ${error.message}` };
  }
  if (!ok) return { reason: "signature does not verify for this address and message" };
  return { side, address };
}

export function resolve(comments, pr) {
  const verified = {};
  const rejected = [];
  for (const comment of comments) {
    const result = checkComment(comment, pr);
    if (!result) continue;
    if (result.reason) {
      rejected.push({ url: comment.html_url, author: comment.user?.login, reason: result.reason });
      continue;
    }
    const previous = verified[result.side];
    if (previous && previous.address !== result.address) {
      // Two different valid addresses for one side: refuse to guess.
      verified[result.side] = { conflict: true, addresses: [previous.address, result.address] };
    } else if (!previous) {
      verified[result.side] = { address: result.address, url: comment.html_url };
    }
  }
  if (verified.A?.address && verified.A.address === verified.B?.address) {
    rejected.push({ reason: "A and B posted the same address" });
    delete verified.A;
    delete verified.B;
  }
  return { verified, rejected };
}

function applyToProgram(verified) {
  const path = fileURLToPath(new URL("../src/lib.rs", import.meta.url));
  let source = readFileSync(path, "utf8");
  for (const side of ["A", "B"]) {
    const pattern = new RegExp(
      `(#\\[cfg\\(not\\(feature = "test-config"\\)\\)\\]\\n    pub const RECIPIENT_${side}: Pubkey = )[^;]+;`,
    );
    if (!pattern.test(source)) throw new Error(`could not find RECIPIENT_${side} in lib.rs`);
    source = source.replace(pattern, `$1pubkey!("${verified[side].address}");`);
  }
  writeFileSync(path, source);
  return path;
}

function main() {
  const [pr, flag] = process.argv.slice(2);
  if (!/^\d+$/.test(pr ?? "")) {
    console.error("usage: read-setup.mjs <pr-number> [--apply]");
    process.exit(2);
  }
  const raw = execFileSync("gh", ["api", "--paginate", `repos/${REPO}/issues/${pr}/comments`], {
    encoding: "utf8",
  });
  // --paginate concatenates JSON arrays.
  const comments = JSON.parse(`[${raw.trim().replace(/\]\s*\[/g, ",").slice(1, -1)}]`);
  const { verified, rejected } = resolve(comments, pr);
  console.log(JSON.stringify({ pr: Number(pr), verified, rejected }, null, 2));

  const ready = ["A", "B"].every((side) => verified[side]?.address);
  if (!ready) {
    console.error("\nNot ready: both sides need one verified setup comment.");
    process.exit(1);
  }
  if (flag === "--apply") {
    console.error(`\nWrote verified recipients into ${applyToProgram(verified)}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
