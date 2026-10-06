import type { ChainPayClient } from "@chainpayhq/sdk";

export type ChainPayMcpContext = {
  client: ChainPayClient;
  principal?: import("../authorization.js").Principal;
  assertActive?: () => Promise<void>;
  /** Optional approved-agent public identity; no signing key is stored by MCP. */
  agentAddress?: string;
  /** Optional Rust backend URL used for signed-transaction relay and status tracking. */
  backendUrl?: string;
  backendAuthToken?: string;
};
