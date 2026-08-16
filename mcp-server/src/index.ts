import { createHash } from "node:crypto";
import { ChainPayClient, publicKey, toWeb3Transaction, type PaymentSubmissionAdapter, type PreparedTransaction } from "@chainpay/sdk";
import { Keypair } from "@solana/web3.js";
import { createMandate } from "./tools/create_mandate.js";
import { checkPaymentRequirements } from "./tools/check_payment_requirements.js";
import { createDemoPaymentRequest } from "./tools/demo-payment-request.js";
import type { ChainPayMcpContext } from "./tools/context.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";
import { executePayment } from "./tools/execute_payment.js";
import { getMandate } from "./tools/get_mandate.js";
import { getPayment } from "./tools/get_payment.js";
import { getAsset } from "./tools/get_asset.js";
import { getProtocolConfig } from "./tools/get_protocol_config.js";
import { findCompatibleMandate, listMandates } from "./tools/list-mandates.js";
import { pauseMandate, revokeMandate } from "./tools/mandate-control.js";
import { preparePayment } from "./tools/prepare_payment.js";
import { quotePayment } from "./tools/quote_payment.js";
import { quotePaymentRequest } from "./tools/quote-payment-request.js";
import { updateMandate } from "./tools/update_mandate.js";
import { verifyPaymentRequest } from "./tools/verify_payment_request.js";
import { waitForPayment } from "./tools/wait_for_payment.js";
import { prepareX402Payment } from "./tools/x402.js";

export { TOOL_DEFINITIONS };
export type { ChainPayMcpContext };

function configuredAgentKeypair() {
  const encoded = process.env.CHAINPAY_AGENT_SECRET_KEY?.trim();
  if (!encoded) return undefined;
  try {
    const parsed = encoded.startsWith("[") ? JSON.parse(encoded) as unknown : undefined;
    if (parsed !== undefined && (!Array.isArray(parsed) || parsed.some((item) => !Number.isInteger(item) || item < 0 || item > 255))) {
      throw new Error("JSON secret key must be an array of byte values");
    }
    const secret = parsed !== undefined
      ? Uint8Array.from(parsed as number[])
      : Uint8Array.from(Buffer.from(encoded, "base64"));
    if (secret.length !== 64) throw new Error("expected a 64-byte Solana secret key");
    return Keypair.fromSecretKey(secret);
  } catch (error) {
    throw new Error(`CHAINPAY_AGENT_SECRET_KEY is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createAgentPaymentExecutor(
  client: ChainPayClient,
  keypair: Keypair,
  backendUrl?: string,
  backendAuthToken?: string,
): PaymentSubmissionAdapter {
  const signerAddress = keypair.publicKey.toBase58();
  return {
    simulate: (prepared: PreparedTransaction) => client.simulate(prepared),
    submit: async (prepared: PreparedTransaction) => {
      if (prepared.feePayer !== signerAddress || !prepared.requiredSigners.includes(signerAddress)) {
        throw new Error("The prepared payment is not addressed to the configured approved-agent signer.");
      }
      const latest = await client.connection.getLatestBlockhash("confirmed");
      const transaction = toWeb3Transaction(prepared, latest.blockhash);
      transaction.sign(keypair);
      const encoded = transaction.serialize().toString("base64");
      if (backendUrl) {
        const response = await fetch(`${backendUrl.replace(/\/$/, "")}/v1/transactions/submit`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(backendAuthToken ? { Authorization: `Bearer ${backendAuthToken}` } : {}),
          },
          body: JSON.stringify({
            idempotency_key: `agent:${signerAddress}:${createHash("sha256").update(encoded).digest("hex")}`,
            signed_transaction: encoded,
          }),
        });
        const payload = await response.json() as { status?: string; signature?: string; slot?: number; error?: string };
        if (!response.ok || payload.status === "failed" || !payload.signature) {
          throw new Error(payload.error ?? `Approved-agent relay failed (${response.status})`);
        }
        return {
          signature: payload.signature,
          status: payload.status === "confirmed" ? "confirmed" : "submitted",
          ...(payload.slot === undefined ? {} : { slot: BigInt(payload.slot) }),
        };
      }
      const signature = await client.connection.sendRawTransaction(transaction.serialize(), { preflightCommitment: "confirmed" });
      const confirmation = await client.connection.confirmTransaction({
        signature,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }, "confirmed");
      if (confirmation.value.err) throw new Error(`Agent payment confirmation failed: ${JSON.stringify(confirmation.value.err)}`);
      return { signature, status: "confirmed", slot: BigInt(await client.getCurrentSlot()) };
    },
  };
}

export function createDefaultContext(): ChainPayMcpContext {
  const client = new ChainPayClient({
      rpcUrl: process.env.CHAINPAY_RPC_URL,
      programId: process.env.CHAINPAY_PROGRAM_ID,
      commitment: "confirmed",
    });
  const agentKeypair = configuredAgentKeypair();
  const configuredPublicKey = process.env.CHAINPAY_AGENT_PUBLIC_KEY?.trim();
  let agentAddress = agentKeypair?.publicKey.toBase58();
  if (configuredPublicKey) {
    const normalizedPublicKey = publicKey(configuredPublicKey).toBase58();
    if (agentKeypair && normalizedPublicKey !== agentKeypair.publicKey.toBase58()) {
      throw new Error("CHAINPAY_AGENT_PUBLIC_KEY does not match CHAINPAY_AGENT_SECRET_KEY");
    }
    agentAddress = normalizedPublicKey;
  }
  return {
    client,
    ...(agentAddress ? { agentAddress } : {}),
    backendUrl: process.env.CHAINPAY_BACKEND_URL,
    backendAuthToken: process.env.CHAINPAY_BACKEND_AUTH_TOKEN,
    ...(agentKeypair ? {
      paymentExecutor: createAgentPaymentExecutor(
        client,
        agentKeypair,
        process.env.CHAINPAY_BACKEND_URL,
        process.env.CHAINPAY_BACKEND_AUTH_TOKEN,
      ),
    } : {}),
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
