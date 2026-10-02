import assert from "node:assert/strict";
import test from "node:test";
import { rowDigest, validateRow, rowKey } from "./migrate-storage.mjs";

test("snapshot hashes retain integers above the JavaScript safe range", () => {
  const a = '{"payment_id":"p","amount":18446744073709551615}';
  const b = '{"amount":18446744073709551615,"payment_id":"p"}';
  assert.equal(rowDigest(a), rowDigest(b));
  assert.notEqual(rowDigest(a), rowDigest(a.replace("18446744073709551615", "18446744073709551614")));
  assert.equal(validateRow("payments", a).key, '["p"]');
});
test("snapshot preflight rejects unknown tables, missing IDs and oversized rows", () => {
  assert.throws(() => validateRow("unknown", '{}'), /Unknown/);
  assert.throws(() => validateRow("payments", '{}'), /primary key/);
  assert.throws(() => validateRow("inbox_messages", JSON.stringify({ message_id: "a", content: "a".repeat(350_000) })), /Oversized/);
  assert.equal(rowKey("delivery_attestations", '{"cluster":"devnet","program_id":"p","receipt_address":"r","seller":"s"}'), '["devnet","p","r","s"]');
});
