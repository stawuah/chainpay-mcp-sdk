import { SPL_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@chainpay/sdk";
import type { ChainPayMcpContext } from "./context.js";
import { toolResult } from "./common.js";

export async function getSupportedAssets(context: ChainPayMcpContext) {
  const assets = await context.client.getSupportedAssets();
  return toolResult({
    assets: assets.map((asset) => ({
      ...asset,
      tokenProgramKind: asset.tokenProgram === TOKEN_2022_PROGRAM_ID
        ? "token-2022"
        : asset.tokenProgram === SPL_TOKEN_PROGRAM_ID
          ? "spl-token"
          : "unsupported",
    })),
  });
}
