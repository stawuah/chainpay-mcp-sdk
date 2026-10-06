import { Connection } from "@solana/web3.js";
import {
  ChainPayClient,
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  deriveX402PaymentReferences,
  publicKey,
  readTokenAccountFields,
} from "@chainpayhq/sdk";
import { createMerchantApp, type MerchantApp } from "./app.js";
import { loadCardShopSettings, type CardShopSettings } from "./card-shops.js";
import {
  loadMerchantConfig,
  loadSellerPublishConfig,
  type MerchantConfig,
  type SellerPublishConfig,
} from "./config.js";
import { loadMandateRequestSettings, type MandateRequestSettings } from "./mandate-requests.js";
import { createRpcTransactionReader } from "./proof.js";
import { createAxumDeliveryPublisher } from "./publisher.js";

export type ConfiguredMerchant = {
  app: MerchantApp;
  config: MerchantConfig;
  sellerPublish?: SellerPublishConfig;
  mandateRequestSettings?: MandateRequestSettings;
  cardShopSettings?: CardShopSettings;
};

/** The parts of a token account the v2 recipient check reads. */
export type RecipientAccountInfo = { owner: string; data: Uint8Array } | null;

/**
 * In v2 mode, payers are told to pay `payTo`'s associated token account. Config
 * already checked the address derivation; this checks the live account: it
 * must exist, be held by the configured token program, hold the configured
 * mint, and be owned by the merchant owner. Without it the first payment
 * fails on chain instead of at deploy time.
 */
export function assertV2RecipientAccount(config: MerchantConfig, account: RecipientAccountInfo): void {
  if (config.challengeShape !== "v2") return;
  const where = "CHAINPAY_X402_RECIPIENT_TOKEN_ACCOUNT";
  if (!account) {
    throw new Error(`${where} does not exist yet: create the merchant owner's associated token account for the mint first`);
  }
  const expectedProgram = config.tokenProgram === "token-2022" ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
  if (account.owner !== expectedProgram) {
    throw new Error(`${where} is not held by the ${config.tokenProgram} token program`);
  }
  const fields = readTokenAccountFields(account.data);
  if (!fields) throw new Error(`${where} is not a token account`);
  if (fields.mint !== config.mint) throw new Error(`${where} holds a different mint than CHAINPAY_X402_MINT`);
  if (fields.owner !== config.merchantOwner) {
    throw new Error(`${where} is owned by ${fields.owner}, not CHAINPAY_X402_MERCHANT_OWNER`);
  }
}

/**
 * Load config, check the live registry and recipient, and build the Express
 * app. Shared by the local server (`server.ts`) and the Vercel function
 * (`vercel.ts`) so a hosted merchant runs exactly the checks a local one does.
 */
export async function createConfiguredMerchant(
  env: NodeJS.Dict<string> = process.env,
): Promise<ConfiguredMerchant> {
  const config = loadMerchantConfig(env);
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
  if (config.challengeShape === "v2") {
    const info = await new Connection(config.rpcUrl, "finalized").getAccountInfo(publicKey(config.recipient));
    assertV2RecipientAccount(
      config,
      info ? { owner: info.owner.toBase58(), data: new Uint8Array(info.data) } : null,
    );
  }

  const sellerPublish = loadSellerPublishConfig(env, config.programId);
  const mandateRequestSettings = loadMandateRequestSettings(env, config);
  const cardShopSettings = loadCardShopSettings(env);
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
  return {
    app,
    config,
    ...(sellerPublish ? { sellerPublish } : {}),
    ...(mandateRequestSettings ? { mandateRequestSettings } : {}),
    ...(cardShopSettings ? { cardShopSettings } : {}),
  };
}
