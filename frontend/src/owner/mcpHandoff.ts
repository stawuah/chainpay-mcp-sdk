export type McpConnectionHandoff = {
  agentName: string;
  mandateAddress: string;
  mandateLabel?: string;
  paymentsPermitted: boolean;
};

export function connectionAccessLabel(paymentsPermitted: boolean): string {
  return paymentsPermitted ? "Payments permitted" : "Read and prepare";
}

/** Copyable first prompt for any MCP client after dashboard connection setup. */
export function buildMcpFirstPrompt(handoff: McpConnectionHandoff): string {
  const permissionLabel = handoff.mandateLabel?.trim() || "the connected spending permission";
  const accessLine = handoff.paymentsPermitted
    ? "You may read, prepare, and execute payments within this permission when I ask."
    : "You may read and prepare payments only. Do not execute a payment on this connection.";

  return [
    `You are connected to ChainPay as "${handoff.agentName}".`,
    "",
    "Start read-only:",
    "1. Confirm ChainPay tools are available (tools/list).",
    "2. Call get_spend_overview. If that tool is missing, call get_mandate"
      + ` with address "${handoff.mandateAddress}" for ${permissionLabel}.`,
    "3. Report in plain language: mandate status, token, remaining allowance, per-payment cap, recent receipts, and what I can ask next.",
    "4. Offer to call list_receipts or prepare a pause. Pause and revoke still need my wallet in the dashboard.",
    "",
    accessLine,
    "Do not prepare, sign, or submit a payment until I explicitly ask.",
  ].join("\n");
}

export function buildMcpClientConfig(serverUrl: string, token?: string) {
  return JSON.stringify({
    mcpServers: {
      chainpay: {
        url: serverUrl,
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      },
    },
  }, null, 2);
}
