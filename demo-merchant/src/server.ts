import { createConfiguredMerchant } from "./bootstrap.js";
import { sanitizedResourceLabel } from "./config.js";

async function main(): Promise<void> {
  const { app, config, sellerPublish, mandateRequestSettings, cardShopSettings } = await createConfiguredMerchant();

  app.listen(config.port, config.host, () => {
    process.stdout.write(
      `ChainPay ${config.challengeShape === "v2" ? "standard x402 v2 challenge, receipt-proof" : "custom receipt-proof"} demo merchant listening on ${config.host}:${config.port}, resource ${sanitizedResourceLabel(config.resource)}\n`,
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
