// The table itself lives in the SDK so chat, the terminal, the embed and the
// dashboard all name a mint the same way. That module has no imports of its
// own, and vite.config.ts keeps it in the app-shared chunk for that reason.
export { KNOWN_ASSETS, UNKNOWN_ASSET_ORDER, assetLabel, assetOrder, knownAsset, type KnownAsset } from "@chainpay/sdk/known-assets";
