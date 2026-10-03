import { merchantIdHash } from "./hash.js";

/*
 * Sandbox shop registry (contracts.md §3.4 checkout-intents: `merchantRef`
 * must resolve to a registered fixture merchant). One list shared by the
 * dashboard, MCP and Axum so a card's allowlist hashes match what checkout
 * opens. Acceptor ids are the values the Lithic simulator sends as
 * `merchant_acceptor_id`; changing one changes every card's allowlist hash.
 */

export type CardSandboxMerchant = {
  ref: string;
  displayName: string;
  acceptorId: string;
  mcc: number;
  /** Fixture role: the approved shop and the one a card should decline. */
  fixture: "approved" | "unapproved";
};

export const CARD_SANDBOX_MERCHANTS: readonly CardSandboxMerchant[] = [
  { ref: "demo-approved", displayName: "ChainPay demo shop", acceptorId: "CHAINPAY-DEMO-001", mcc: 5734, fixture: "approved" },
  { ref: "demo-unapproved", displayName: "Unlisted test shop", acceptorId: "CHAINPAY-DEMO-002", mcc: 5999, fixture: "unapproved" },
];

/** Plain names for the merchant categories the dashboard offers. */
export const CARD_MCC_NAMES: Readonly<Record<number, string>> = {
  4816: "Online services",
  5045: "Computers and electronics",
  5734: "Software",
  5817: "Digital goods",
  5942: "Books",
  5999: "Other retail",
  7372: "Data and computer services",
  4121: "Rides",
};

export function cardMerchantByRef(ref: string): CardSandboxMerchant | undefined {
  return CARD_SANDBOX_MERCHANTS.find((merchant) => merchant.ref === ref);
}

/** Allowlist hashes for `set_policy`. Throws on an unknown shop so nothing is silently dropped. */
export async function merchantIdHashesForRefs(refs: readonly string[]): Promise<Uint8Array[]> {
  return Promise.all(refs.map((ref) => {
    const merchant = cardMerchantByRef(ref);
    if (!merchant) throw new Error(`"${ref}" isn't a registered shop`);
    return merchantIdHash(merchant.acceptorId);
  }));
}

export function mccLabel(mcc: number): string {
  return CARD_MCC_NAMES[mcc] ? `${CARD_MCC_NAMES[mcc]} (${String(mcc).padStart(4, "0")})` : `Category ${String(mcc).padStart(4, "0")}`;
}
