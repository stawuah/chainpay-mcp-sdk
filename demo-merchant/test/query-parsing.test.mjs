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
