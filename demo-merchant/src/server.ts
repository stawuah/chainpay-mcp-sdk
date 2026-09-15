import {
  ChainPayClient,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  deriveX402PaymentReferences,
} from "@chainpay/sdk";
import { createMerchantApp } from "./app.js";
import { loadMerchantConfig, sanitizedResourceLabel } from "./config.js";
import { createRpcTransactionReader } from "./proof.js";

async function main(): Promise<void> {
  const config = loadMerchantConfig();
  const client = new ChainPayClient({
    rpcUrl: config.rpcUrl,
    programId: config.programId,
    commitment: "finalized",
  });
  const references = await deriveX402PaymentReferences({
    mint: config.mint,
    recipient: config.recipient,
    amount: config.amount,
    resource: config.resource,
    tokenProgram: config.tokenProgram,
    ...(config.nonce ? { nonce: config.nonce } : {}),
  });
  const expectedTokenProgram = config.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  const asset = await client.getSupportedAsset(config.mint);
  if (!asset?.enabled || asset.tokenProgram !== expectedTokenProgram) {
    throw new Error("Merchant asset is not enabled with the expected token program in ChainPay SupportedAsset");
  }

  const app = createMerchantApp(config, references, {
    getFinalizedReceipt: (address) => client.getPayment(address),
    getFinalizedTransaction: createRpcTransactionReader(config.rpcUrl),
  });

  app.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(
      `ChainPay custom receipt-proof demo merchant listening at ${sanitizedResourceLabel(config.resource)}\n`,
    );
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "startup failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
