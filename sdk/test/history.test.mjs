import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { ChainPayClient } from "../dist/index.js";

test("mandate metadata paginates within the bounded public proxy contract", async () => {
  const client = new ChainPayClient({ rpcUrl: "http://127.0.0.1:1" });
  const mandate = Keypair.generate().publicKey.toBase58();
  const data = Buffer.alloc(235);
  data.set([139, 106, 43, 122, 82, 211, 96, 162]);
  client.getCurrentSlot = async () => 1000n;
  client.getProgramAccount = async () => ({ data, address: mandate });
  client.connection.getAccountInfo = async () => null;
  let pages = 0;
  client.connection.getSignaturesForAddress = async (_address, options) => {
    assert.equal(options.limit, 100);
    pages++;
    if (pages === 1) return Array.from({ length: 100 }, (_, i) => ({ signature: `fixture-${i}`, slot: 200 - i, blockTime: 500 - i }));
    assert.equal(options.before, "fixture-99");
    return [{ signature: "creation", slot: 50, blockTime: 300 }];
  };
  const result = await client.getMandate(mandate);
  assert.equal(pages, 2);
  assert.equal(result.createdAtSlot, 50n);
  assert.equal(result.createdAt, 300);
});
