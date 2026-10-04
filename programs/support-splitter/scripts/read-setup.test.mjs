// node --test programs/support-splitter/scripts/read-setup.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { base58Decode, expectedMessage, resolve } from "./read-setup.mjs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  return out + digits.reverse().map((d) => B58[d]).join("");
}

function wallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  return { address: base58Encode(raw), privateKey };
}

const PR = "42";
const A = wallet();
const B = wallet();

function setupComment({ side, who, author, pr = PR, edited = false, message, signWith, at = "2026-10-03T00:00:00Z", signature: given }) {
  const text = message ?? expectedMessage(side, who.address, pr);
  const signature = given ?? base58Encode(sign(null, Buffer.from(text), (signWith ?? who).privateKey));
  return {
    html_url: `https://github.com/x/${Math.random()}`,
    user: { login: author },
    created_at: at,
    updated_at: edited ? "2026-10-03T23:59:59Z" : at,
    body: [
      "<!-- support-setup:v1 -->",
      `side: ${side}`,
      `address: ${who.address}`,
      `message: ${text}`,
      `signature: ${signature}`,
    ].join("\n"),
  };
}

test("base58 round-trips", () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 255, 7]);
  assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
});

test("both valid comments resolve", () => {
  const { verified, rejected } = resolve(
    [
      setupComment({ side: "A", who: A, author: "tantshirt" }),
      setupComment({ side: "B", who: B, author: "stawuah" }),
      { body: "lgtm", user: { login: "stawuah" } },
    ],
    PR,
  );
  assert.equal(verified.A.address, A.address);
  assert.equal(verified.B.address, B.address);
  assert.equal(rejected.length, 0);
});

test("rejects the wrong author, edits, replays, forged signatures", () => {
  const cases = [
    [setupComment({ side: "B", who: B, author: "tantshirt" }), /must be posted by @stawuah/],
    [setupComment({ side: "A", who: A, author: "tantshirt", edited: true }), /edited/],
    [setupComment({ side: "A", who: A, author: "tantshirt", pr: "41" }), /message must be exactly/],
    [setupComment({ side: "A", who: A, author: "tantshirt", signWith: B }), /does not verify/],
    [setupComment({ side: "C", who: A, author: "tantshirt" }), /unknown side/],
  ];
  for (const [comment, reason] of cases) {
    const { verified, rejected } = resolve([comment], PR);
    assert.equal(Object.keys(verified).length, 0);
    assert.match(rejected[0].reason, reason);
  }
});

test("a newer signed comment replaces a mistaken one, and the change is reported (review F5)", () => {
  const [x, y, z] = [wallet(), wallet(), wallet()];
  const comments = [
    setupComment({ side: "A", who: z, author: "tantshirt", at: "2026-10-03T03:00:00Z" }),
    setupComment({ side: "A", who: x, author: "tantshirt", at: "2026-10-03T01:00:00Z" }),
    setupComment({ side: "A", who: y, author: "tantshirt", at: "2026-10-03T02:00:00Z" }),
    setupComment({ side: "B", who: B, author: "stawuah" }),
  ];
  const { verified } = resolve(comments, PR);
  assert.equal(verified.A.address, z.address, "newest by time, not by list order");
  assert.deepEqual(verified.A.superseded, [x.address, y.address]);
  assert.equal(verified.B.address, B.address);
  assert.equal(verified.B.superseded, undefined);
});

test("a forged or edited newer comment doesn't replace a valid one", () => {
  const thief = wallet();
  const { verified } = resolve(
    [
      setupComment({ side: "A", who: A, author: "tantshirt", at: "2026-10-03T01:00:00Z" }),
      setupComment({ side: "A", who: thief, author: "stawuah", at: "2026-10-03T02:00:00Z" }),
      setupComment({ side: "A", who: thief, author: "tantshirt", at: "2026-10-03T03:00:00Z", edited: true }),
      setupComment({ side: "A", who: thief, author: "tantshirt", at: "2026-10-03T04:00:00Z", signWith: A }),
    ],
    PR,
  );
  assert.equal(verified.A.address, A.address);
});

test("two different addresses at the same second are a conflict that keeps both addresses", () => {
  const other = wallet();
  const { verified } = resolve(
    [
      setupComment({ side: "A", who: A, author: "tantshirt" }),
      setupComment({ side: "A", who: other, author: "tantshirt" }),
      setupComment({ side: "A", who: A, author: "tantshirt" }),
    ],
    PR,
  );
  assert.equal(verified.A.conflict, true);
  assert.equal(verified.A.address, undefined);
  assert.deepEqual(new Set(verified.A.addresses), new Set([A.address, other.address]));
});

// The PR tells maintainers to sign with `solana sign-offchain-message`. Check that
// exact path with a throwaway key made for this test (never a real wallet).
const hasSolanaCli = (() => {
  try {
    execFileSync("solana", ["--version"], { stdio: "ignore" });
    execFileSync("solana-keygen", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("accepts a signature from the Solana CLI's sign-offchain-message", { skip: !hasSolanaCli && "solana CLI not installed" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "support-setup-"));
  try {
    const keyFile = join(dir, "throwaway.json");
    execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "--force", "-o", keyFile], { stdio: "ignore" });
    const address = execFileSync("solana-keygen", ["pubkey", keyFile], { encoding: "utf8" }).trim();
    const who = { address };
    const message = expectedMessage("A", address, PR);
    // Offline: signing a message needs no network.
    const signature = execFileSync("solana", ["sign-offchain-message", "-k", keyFile, message], { encoding: "utf8" }).trim();
    const { verified, rejected } = resolve([setupComment({ side: "A", who, author: "tantshirt", signature })], PR);
    assert.deepEqual(rejected, []);
    assert.equal(verified.A.address, address);
    const wrongPr = resolve([setupComment({ side: "A", who, author: "tantshirt", pr: "41", signature })], PR);
    assert.match(wrongPr.rejected[0].reason, /message must be exactly/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both sides can't share one address", () => {
  const { verified, rejected } = resolve(
    [
      setupComment({ side: "A", who: A, author: "tantshirt" }),
      setupComment({ side: "B", who: A, author: "stawuah" }),
    ],
    PR,
  );
  assert.equal(verified.A, undefined);
  assert.equal(verified.B, undefined);
  assert.match(rejected.at(-1).reason, /same address/);
});
