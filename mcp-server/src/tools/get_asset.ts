import type { ChainPayMcpContext } from "./context.js";
import { solanaAddress, toolResult } from "./common.js";

export async function getAsset(context: ChainPayMcpContext, args: Record<string, unknown>) {
  const mint = solanaAddress(args.mint, "mint");
  const asset = await context.client.getSupportedAsset(mint);
  return asset
    ? toolResult({ found: true, asset })
    : toolResult({ found: false, mint }, true);
}
