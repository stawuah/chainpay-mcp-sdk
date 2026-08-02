import type { ChainPayMcpContext } from "./context.js";
import { toolResult } from "./common.js";

export async function getProtocolConfig(context: ChainPayMcpContext) {
  const config = await context.client.getConfig();
  return config ? toolResult({ found: true, config }) : toolResult({ found: false }, true);
}
