import { createPrivateKey, sign } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { getTransactionEncoder } from "@solana/transactions";
import {
  V1_COMPUTE_UNIT_LIMIT,
  V1_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  compileV1TransactionBytes,
  decodeSupportedTransaction,
  systemTransferInstruction,
} from "../dist/index.js";

test("v1 compile requires explicit budgets and encodes a signable version 1 wire", () => {
  const payer = Keypair.generate();
  const recipient = Keypair.generate();
  const prepared = {
    instructions: [systemTransferInstruction(payer.publicKey.toBase58(), recipient.publicKey.toBase58(), 10_000n)],
    requiredSigners: [payer.publicKey.toBase58()],
    feePayer: payer.publicKey.toBase58(),
  };
  const lifetime = { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1n };
  assert.throws(
    () => compileV1TransactionBytes(prepared, {
      version: 1,
      lifetime,
      computeUnitLimit: 0,
      loadedAccountsDataSizeLimit: V1_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
    }),
    /compute unit limit/,
  );
  const unsigned = compileV1TransactionBytes(prepared, {
    version: 1,
    lifetime,
    computeUnitLimit: V1_COMPUTE_UNIT_LIMIT,
    loadedAccountsDataSizeLimit: V1_LOADED_ACCOUNTS_DATA_SIZE_LIMIT,
  });
  assert.equal(unsigned[0], 0x81);
  const decoded = decodeSupportedTransaction(unsigned);
  assert.equal(decoded.message.version, 1);

  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(payer.secretKey.subarray(0, 32))]),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, decoded.transaction.messageBytes, privateKey);
  const signed = getTransactionEncoder().encode({
    messageBytes: decoded.transaction.messageBytes,
    signatures: { [payer.publicKey.toBase58()]: signature },
  });
  assert.equal(decodeSupportedTransaction(signed).message.version, 1);
});
