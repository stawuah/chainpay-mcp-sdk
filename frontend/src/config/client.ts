import { ChainPayClient } from "@chainpay/sdk";
import { configureSession } from "../session";
import { AGENT_URL, BACKEND_URL, MCP_URL, PROGRAM_ID, RPC_URL } from "./public";

export const chainpayClient = new ChainPayClient({ rpcUrl: RPC_URL, programId: PROGRAM_ID });

export const publicReceiptClient = new ChainPayClient({
  rpcUrl: RPC_URL,
  programId: PROGRAM_ID,
  commitment: "finalized",
});

configureSession(BACKEND_URL, MCP_URL);

export { AGENT_URL, BACKEND_URL, MCP_URL, PROGRAM_ID, RPC_URL };
