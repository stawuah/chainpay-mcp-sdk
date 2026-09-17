import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import test from "node:test";
import express from "express";

const require = createRequire(import.meta.url);
const qs = require("qs");
const qsPackage = require("qs/package.json");

test("workspace qs is the official 6.16.0 array-limit patch", () => {
  assert.equal(qsPackage.version, "6.16.0");
});

// A version string alone is not a regression test: 6.15.3 satisfies every
// happy-path assertion below it. These two pin the behaviour the advisory is
// actually about (GHSA-x5fp-wj9c-mxmx), so a downgrade fails here rather than
// silently reintroducing the array-limit bypass.
test("qs enforces the array limit on the advisory's comma path", () => {
  const overLimit = `a=${Array.from({ length: 30 }, (_, index) => index).join(",")}`;

  assert.throws(
    () => qs.parse(overLimit, { comma: true, arrayLimit: 5, throwOnLimitExceeded: true }),
    /Array limit exceeded/,
    "comma expansion must respect arrayLimit when the caller asks it to throw",
  );

  // Without throwOnLimitExceeded the limit still holds: the result degrades to a
  // string-keyed object rather than allocating an array past the limit.
  const parsed = qs.parse(overLimit, { comma: true, arrayLimit: 5 });
  assert.equal(Array.isArray(parsed.a), false);
  assert.equal(Object.keys(parsed.a).length, 30);
});

test("qs enforces the array limit on explicit indices", () => {
  assert.throws(
    () => qs.parse("a[0]=x&a[25]=y", { arrayLimit: 5, throwOnLimitExceeded: true }),
    /Array limit exceeded/,
  );

  // body-parser's defaults do not set throwOnLimitExceeded, so confirm the
  // non-throwing shape the merchant would actually see is still bounded.
  const parsed = qs.parse("a[0]=x&a[25]=y", { arrayLimit: 5 });
  assert.equal(Array.isArray(parsed.a), false);
  assert.deepEqual(parsed.a, { 0: "x", 25: "y" });
});

test("qs keeps ordinary payment-shaped query objects", () => {
  const parsed = qs.parse(
    "mint=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU&amount=100000&resource=https%3A%2F%2Fmerchant.example%2Fdata",
    { allowPrototypes: true },
  );
  assert.deepEqual(parsed, {
    mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    amount: "100000",
    resource: "https://merchant.example/data",
  });
});

test("Express extended query parser keeps the same ordinary objects", async () => {
  const app = express();
  app.set("query parser", "extended");
  app.get("/probe", (request, response) => {
    response.json(request.query);
  });

  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/probe?mint=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU&amount=100000`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      amount: "100000",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
