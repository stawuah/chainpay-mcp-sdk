import { ChainPayClient } from "@chainpay/sdk";
import { createMandate } from "./tools/create_mandate.js";
import type { ChainPayMcpContext } from "./tools/context.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { executePayment } from "./tools/execute_payment.js";
import { getMandate } from "./tools/get_mandate.js";
import { getPayment } from "./tools/get_payment.js";
import { pauseMandate, revokeMandate } from "./tools/mandate-control.js";
import { preparePayment } from "./tools/prepare_payment.js";

export { TOOL_DEFINITIONS };
export type { ChainPayMcpContext };

export function createDefaultContext(): ChainPayMcpContext {
  return {
    client: new ChainPayClient({
      rpcUrl: process.env.CHAINPAY_RPC_URL,
      programId: process.env.CHAINPAY_PROGRAM_ID,
      commitment: "confirmed",
    }),
  };
}

export const tools = {
  getMandate,
  createMandate,
  preparePayment,
  executePayment,
  getPayment,
  pauseMandate,
  revokeMandate,
};

export async function callTool(
  context: ChainPayMcpContext,
  name: string,
  args: Record<string, unknown> = {},
) {
  switch (name) {
    case "get_mandate":
      return getMandate(context, args);
    case "create_mandate":
      return createMandate(context, args);
    case "prepare_payment":
      return preparePayment(context, args);
    case "execute_payment":
      return executePayment(context, args);
    case "get_payment":
      return getPayment(context, args);
    case "pause_mandate":
      return pauseMandate(context, args);
    case "revoke_mandate":
      return revokeMandate(context, args);
    default:
      throw new Error(`Unknown ChainPay tool: ${name}`);
  }
}

