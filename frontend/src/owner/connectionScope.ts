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

export function buildConnectionScope(mandateAddress: string, ownedAddresses: string[], allowPayments: boolean) {
  const trimmed = mandateAddress.trim();
  assertOwnedMandate(trimmed, ownedAddresses);
  return JSON.stringify({
    version: 1,
    mandates: [trimmed],
    agents: {},
    tools: [
      ...CONNECTION_READ_TOOLS,
      ...(allowPayments ? CONNECTION_PAYMENT_TOOLS : []),
    ],
  });
}
