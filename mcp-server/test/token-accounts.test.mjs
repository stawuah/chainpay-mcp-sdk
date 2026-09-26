import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { callTool } from "../dist/index.js";
import { prepareTokenAccounts } from "../dist/tools/prepare_token_accounts.js";

const key = () => Keypair.generate().publicKey.toBase58();

function fixture(status = "missing") {
  const owner = key();
  const mint = key();
  const tokenAccount = key();
  const preparation = {
    asset: { address: key(), authority: key(), mint, tokenProgram: key(), enabled: true, bump: 255 },
    address: tokenAccount,
    owner,
    mint,
    tokenProgram: "spl-token",
    status,
    ...(status === "missing" ? {
      transaction: {
        feePayer: owner,
        requiredSigners: [owner],
        instructions: [{
          name: "create_associated_token_account",
          programId: SystemProgram.programId.toBase58(),
          keys: [{ address: owner, isSigner: true, isWritable: true }],
          data: new Uint8Array(),
        }],
      },
    } : {}),
  };
  return { owner, mint, tokenAccount, preparation };
}

test("prepares one missing enabled token account for explicit owner approval", async () => {
  const value = fixture();
  const result = await prepareTokenAccounts({
    client: { prepareRegisteredAssetTokenAccounts: async () => [value.preparation] },
  }, { owner: value.owner });

  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.action, "token_account_signature_required");
  assert.equal(result.structuredContent.tokenAccount, value.tokenAccount);
  assert.equal(result.structuredContent.mint, value.mint);
  assert.equal(result.structuredContent.transaction.requiredSigners[0], value.owner);
  assert.equal(result.structuredContent.transaction.instructions[0].name, "create_associated_token_account");
  assert.match(result.content[0].text, /does not fund the account/i);
});

test("reports ready without creating or returning a transaction", async () => {
  const value = fixture("ready");
  const result = await prepareTokenAccounts({
    client: { prepareAssociatedTokenAccount: async () => value.preparation },
  }, { owner: value.owner, mint: value.mint });

  assert.equal(result.structuredContent.action, "token_accounts_ready");
  assert.equal(result.structuredContent.transaction, undefined);
  assert.equal(result.structuredContent.accounts[0].status, "ready");
});

test("central authorization binds ATA preparation to the verified owner", async () => {
  const value = fixture();
  const context = {
    principal: { wallet: value.owner, scope: null },
    client: { prepareRegisteredAssetTokenAccounts: async (owner) => {
      assert.equal(owner, value.owner);
      return [value.preparation];
    } },
  };
  await assert.rejects(
    callTool(context, "prepare_token_accounts", { owner: key() }),
    /Wallet differs from verified owner/,
  );
  const result = await callTool(context, "prepare_token_accounts", { owner: value.owner });
  assert.equal(result.structuredContent.action, "token_account_signature_required");

  await assert.rejects(
    callTool({ ...context, principal: { wallet: value.owner, scope: { version: 1, mandates: [key()], tools: ["prepare_token_accounts"], agents: {} } } }, "prepare_token_accounts", { owner: value.owner }),
    /not permitted/,
  );
});
