// node --test programs/support-splitter/scripts/read-setup.test.mjs
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
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

function setupComment({ side, who, author, pr = PR, edited = false, message, signWith }) {
  const text = message ?? expectedMessage(side, who.address, pr);
  const signature = base58Encode(sign(null, Buffer.from(text), (signWith ?? who).privateKey));
  return {
    html_url: `https://github.com/x/${Math.random()}`,
    user: { login: author },
    created_at: "2026-10-03T00:00:00Z",
    updated_at: edited ? "2026-10-03T00:05:00Z" : "2026-10-03T00:00:00Z",
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

test("two different valid addresses for one side is a conflict, not a pick", () => {
  const other = wallet();
  const { verified } = resolve(
    [
      setupComment({ side: "A", who: A, author: "tantshirt" }),
      setupComment({ side: "A", who: other, author: "tantshirt" }),
    ],
    PR,
  );
  assert.equal(verified.A.conflict, true);
  assert.equal(verified.A.address, undefined);
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
