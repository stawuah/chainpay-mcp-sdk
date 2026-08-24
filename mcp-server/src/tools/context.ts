import type { ChainPayClient } from "@chainpay/sdk";

export type ChainPayMcpContext = {
  client: ChainPayClient;
  /** Optional approved-agent public identity; no signing key is stored by MCP. */
  agentAddress?: string;
  /** Optional Rust backend URL used for signed-transaction relay and status tracking. */
  backendUrl?: string;
  backendAuthToken?: string;
};
