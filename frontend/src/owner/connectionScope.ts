export const CONNECTION_READ_TOOLS = [
  "get_protocol_config",
  "get_asset",
  "get_supported_assets",
  "get_mandate",
  "list_mandates",
  "find_compatible_mandate",
  "quote_payment",
  "quote_payment_request",
  "prepare_payment",
  "check_payment_requirements",
  "verify_payment_request",
  "get_payment",
  "wait_for_payment",
] as const;

export const CONNECTION_PAYMENT_TOOLS = [
  "execute_payment",
  "prepare_x402_payment",
  "execute_x402_payment",
] as const;

export type ScopedMandate = {
  address: string;
  owner: string;
  status: string;
  approvedAgent: string;
};

export function ownedMandateAddresses(mandates: ScopedMandate[], owner: string) {
  return mandates
    .filter((mandate) => mandate.owner === owner && mandate.status !== "revoked")
    .map((mandate) => mandate.address);
}

export function assertOwnedMandate(mandateAddress: string, ownedAddresses: string[]) {
  if (!ownedAddresses.includes(mandateAddress)) {
    throw new Error("Choose one of your mandates. Connections cannot be scoped to another owner's mandate.");
  }
}

export function buildConnectionScope(
  mandateAddress: string,
  ownedMandates: ScopedMandate[],
  allowPayments: boolean,
) {
  const trimmed = mandateAddress.trim();
  assertOwnedMandate(trimmed, ownedMandates.map((mandate) => mandate.address));
  const mandate = ownedMandates.find((candidate) => candidate.address === trimmed);
  if (!mandate?.approvedAgent) {
    throw new Error("This mandate has no approved agent yet. Approve one before connecting.");
  }
  return JSON.stringify({
    version: 1,
    mandates: [trimmed],
    // The MCP server pins scope.agents[mandate] against the mandate's current
    // approvedAgent (mcp-server/src/authorization.ts). An empty map made that
    // comparison `undefined !== <agent>`, so every mandate-scoped tool threw
    // "Mandate agent changed" and no connection this dialog created could ever
    // call one. Recording the agent is also what makes the check meaningful:
    // if the owner later approves a different agent, the connection stops
    // working until they reconnect, which is the intended behaviour.
    agents: { [trimmed]: mandate.approvedAgent },
    tools: [
      ...CONNECTION_READ_TOOLS,
      ...(allowPayments ? CONNECTION_PAYMENT_TOOLS : []),
    ],
  });
}
