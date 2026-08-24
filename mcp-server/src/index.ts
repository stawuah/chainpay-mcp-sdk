import { ChainPayClient, publicKey } from "@chainpay/sdk";
import { createMandate } from "./tools/create_mandate.js";
import { checkPaymentRequirements } from "./tools/check_payment_requirements.js";
import { createDemoPaymentRequest } from "./tools/demo-payment-request.js";
import type { ChainPayMcpContext } from "./tools/context.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { executePayment } from "./tools/execute_payment.js";
import { getMandate } from "./tools/get_mandate.js";
import { getPayment } from "./tools/get_payment.js";
import { getAsset } from "./tools/get_asset.js";
import { getSupportedAssets } from "./tools/get_supported_assets.js";
import { getProtocolConfig } from "./tools/get_protocol_config.js";
import { findCompatibleMandate, listMandates } from "./tools/list-mandates.js";
import { pauseMandate, revokeMandate } from "./tools/mandate-control.js";
import { preparePayment } from "./tools/prepare_payment.js";
import { quotePayment } from "./tools/quote_payment.js";
import { quotePaymentRequest } from "./tools/quote-payment-request.js";
import { updateMandate } from "./tools/update_mandate.js";
import { verifyPaymentRequest } from "./tools/verify_payment_request.js";
import { waitForPayment } from "./tools/wait_for_payment.js";
import { executeX402Payment, prepareX402Payment } from "./tools/x402.js";

export { TOOL_DEFINITIONS };
export type { ChainPayMcpContext };

const PRIVATE_KEY_FIELD = /^(?:delegated_?key|secret_?key|private_?key|seed_?phrase|mnemonic|keypair)$/i;

function assertNoPrivateKeyMaterial(value: unknown, path = "arguments"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateKeyMaterial(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (PRIVATE_KEY_FIELD.test(key)) {
      throw new Error(`Private key material is not accepted by ChainPay MCP (${path}.${key}). Sign outside the server and provide only signedTransaction.`);
    }
    assertNoPrivateKeyMaterial(item, `${path}.${key}`);
  }
}

export function createDefaultContext(): ChainPayMcpContext {
  const client = new ChainPayClient({
      rpcUrl: process.env.CHAINPAY_RPC_URL,
      programId: process.env.CHAINPAY_PROGRAM_ID,
      commitment: "confirmed",
    });
  const configuredPublicKey = process.env.CHAINPAY_AGENT_PUBLIC_KEY?.trim();
  const agentAddress = configuredPublicKey
    ? publicKey(configuredPublicKey).toBase58()
    : undefined;
  return {
    client,
    ...(agentAddress ? { agentAddress } : {}),
    backendUrl: process.env.CHAINPAY_BACKEND_URL,
    backendAuthToken: process.env.CHAINPAY_BACKEND_AUTH_TOKEN,
  };
}

export const tools = {
    getMandate,
    listMandates,
    findCompatibleMandate,
    createDemoPaymentRequest,
    quotePaymentRequest,
    createMandate,
    checkPaymentRequirements,
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
  assertNoPrivateKeyMaterial(args);
  switch (name) {
    case "get_mandate":
      return getMandate(context, args);
    case "list_mandates":
      return listMandates(context, args);
    case "find_compatible_mandate":
      return findCompatibleMandate(context, args);
    case "get_protocol_config":
      return getProtocolConfig(context);
    case "get_asset":
      return getAsset(context, args);
    case "get_supported_assets":
      return getSupportedAssets(context);
    case "create_demo_payment_request":
      return createDemoPaymentRequest(context, args);
    case "quote_payment_request":
      return quotePaymentRequest(context, args);
    case "create_mandate":
      return createMandate(context, args);
    case "check_payment_requirements":
      return checkPaymentRequirements(context, args);
    case "prepare_payment":
      return preparePayment(context, args);
    case "quote_payment":
      return quotePayment(context, args);
    case "verify_payment_request":
      return verifyPaymentRequest(context, args);
    case "prepare_x402_payment":
      return prepareX402Payment(context, args);
    case "execute_x402_payment":
      return executeX402Payment(context, args);
    case "execute_payment":
      return executePayment(context, args);
    case "wait_for_payment":
      return waitForPayment(context, args);
    case "get_payment":
      return getPayment(context, args);
    case "pause_mandate":
      return pauseMandate(context, args);
    case "revoke_mandate":
      return revokeMandate(context, args);
    case "update_mandate":
      return updateMandate(context, args);
    default:
      throw new Error(`Unknown ChainPay tool: ${name}`);
  }
}
