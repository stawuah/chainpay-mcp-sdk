import {
  ChainPayClient,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  deriveX402PaymentReferences,
} from "@chainpay/sdk";
import { createMerchantApp } from "./app.js";
import { loadCardShopSettings } from "./card-shops.js";
import { loadMerchantConfig, loadSellerPublishConfig, sanitizedResourceLabel } from "./config.js";
import { loadMandateRequestSettings } from "./mandate-requests.js";
import { createRpcTransactionReader } from "./proof.js";
import { createAxumDeliveryPublisher } from "./publisher.js";

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

  const sellerPublish = loadSellerPublishConfig(process.env, config.programId);
  const mandateRequestSettings = loadMandateRequestSettings(process.env, config);
  const cardShopSettings = loadCardShopSettings(process.env);
  const app = createMerchantApp(config, references, {
    getFinalizedReceipt: (address) => client.getPayment(address),
    getFinalizedTransaction: createRpcTransactionReader(config.rpcUrl),
    ...(sellerPublish ? { publisher: createAxumDeliveryPublisher(sellerPublish) } : {}),
    cardShops: cardShopSettings ? { settings: cardShopSettings } : {},
    ...(mandateRequestSettings
      ? {
        mandateRequests: {
          settings: mandateRequestSettings,
          lookup: {
            getCurrentSlot: () => client.getCurrentSlot(),
            getMintDecimals: (mint: string) => client.getMintDecimals(mint),
          },
        },
      }
      : {}),
  });

  app.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(
      `ChainPay custom receipt-proof demo merchant listening at ${sanitizedResourceLabel(config.resource)}\n`,
    );
    if (mandateRequestSettings) {
      process.stdout.write(
        mandateRequestSettings.throwawayKey
          ? "Mandate requests signed with a throwaway key for this process (set CHAINPAY_SELLER_SECRET_KEY to keep one)\n"
          : `Mandate requests signed by ${mandateRequestSettings.requester}\n`,
      );
    }
    process.stdout.write(
      cardShopSettings
        ? "Sandbox card shops at /card-shops (checkout redeems through ChainPay)\n"
        : "Sandbox card shops at /card-shops (checkout off: set CHAINPAY_CARDS_API_URL and CHAINPAY_CARDS_RUNNER_SECRET)\n",
    );
    if (sellerPublish) {
      process.stdout.write(
        `Seller response-served attestations enabled for ${sellerPublish.seller}\n`,
      );
    }
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "startup failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
