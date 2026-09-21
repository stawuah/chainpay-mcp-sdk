/*
  Grouping and canonical order for the MCP tool surface.

  The tools tab previously rendered every tool as a full-width card in whatever
  order the live list arrived in, so the page ran past 2,700px, reshuffled
  between reads, and repeated an identical "All connected agents" chip on each
  card. PRODUCT.md names "repeated generic feature cards" as an anti-reference.

  Groups mirror the layers in chainpay/docs/scope.md.
*/
export type ToolGroupId = "discover" | "policy" | "check" | "pay" | "x402";

export const TOOL_GROUPS: { id: ToolGroupId; label: string; blurb: string }[] = [
  { id: "discover", label: "Discover", blurb: "Read mandates and supported assets. No state changes." },
  { id: "policy", label: "Policy", blurb: "Create and change a mandate. Each one needs the owner's wallet signature." },
  { id: "check", label: "Quote and check", blurb: "Evaluate a request against policy before anything is signed." },
  { id: "pay", label: "Pay", blurb: "Build, relay and read back a settlement." },
  { id: "x402", label: "x402", blurb: "Normalize an HTTP 402 challenge into a ChainPay payment." },
];

const MEMBERSHIP: Record<string, ToolGroupId> = {
  list_mandates: "discover",
  find_compatible_mandate: "discover",
  get_spend_overview: "discover",
  get_mandate: "discover",
  list_receipts: "pay",
  get_supported_assets: "discover",
  create_mandate: "policy",
  update_mandate: "policy",
  pause_mandate: "policy",
  resume_mandate: "policy",
  revoke_mandate: "policy",
  check_payment_requirements: "check",
  quote_payment_request: "check",
  create_demo_payment_request: "check",
  prepare_payment: "pay",
  execute_payment: "pay",
  get_payment: "pay",
  prepare_x402_payment: "x402",
  execute_x402_payment: "x402",
};

/** Anything unrecognised sorts last rather than disappearing from the surface. */
export function toolGroup(name: string): ToolGroupId | "other" {
  return MEMBERSHIP[name] ?? "other";
}

/** Required params, read off the tool's own input schema. */
export function requiredParams(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) ? required.filter((value): value is string => typeof value === "string") : [];
}
