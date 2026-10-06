import express, { type Express, type Request, type Response } from "express";
import {
  CARD_SANDBOX_MERCHANTS,
  formatUsdCents,
  isCheckoutCapability,
  merchantIdHash,
  redactCardData,
  type CardSandboxMerchant,
} from "@chainpayhq/sdk";

/*
 * Workstream D fixture shops (contracts.md §3.4, §6). Two sandbox shops an
 * agent's `request_card_checkout` can target:
 *
 *   demo-approved   ChainPay demo shop   DEMO-DATAAPI    MCC 5734  (on the demo card's allowlist)
 *   demo-unapproved Unlisted test shop   DEMO-OTHERSHOP  MCC 5999  (a card should decline it)
 *
 * The ids, descriptors and MCCs come from the SDK registry, which mirrors the
 * Lithic connector byte for byte, so a card's allowlist hash is the hash the
 * card network reports for this shop.
 *
 * Card data never passes through here. The agent hands the shop an opaque
 * one-time capability (`cpcap_v1_…`); the shop acts as the checkout runner
 * and asks ChainPay to redeem it for this shop and this price. ChainPay holds
 * the card number in memory for that one call and the card's rules decide on
 * the private rollup. The shop gets back a run id and a state, nothing else,
 * and never returns, logs or renders a card number, CVV, expiry or embed URL.
 */

export type CardShopItem = { sku: string; name: string; amountCents: string };

export type CardShop = CardSandboxMerchant & { item: CardShopItem };

/** One fixed-price item per shop, so the amount an agent asks for is the amount the shop charges. */
const ITEMS: Record<string, CardShopItem> = {
  "demo-approved": { sku: "data-api-credits-2000", name: "Data API credits, 2,000 calls", amountCents: "2000" },
  "demo-unapproved": { sku: "other-thing-1000", name: "Something the card owner didn't approve", amountCents: "1000" },
};

export const CARD_SHOPS: readonly CardShop[] = CARD_SANDBOX_MERCHANTS.map((merchant) => {
  const item = ITEMS[merchant.ref];
  if (!item) throw new Error(`No fixture item for ${merchant.ref}`);
  return { ...merchant, item };
});

export function cardShopByRef(ref: string): CardShop | undefined {
  return CARD_SHOPS.find((shop) => shop.ref === ref);
}

export type CardShopSettings = {
  /** ChainPay Axum base URL, e.g. https://relay.example. */
  apiUrl: string;
  /** CARDS_CHECKOUT_RUNNER_SECRET shared with Axum. Never sent anywhere else, never logged. */
  runnerSecret: string;
};

export type CardShopDependencies = {
  /** Absent: the shop pages work, checkout answers 503. */
  settings?: CardShopSettings;
  fetch?: typeof fetch;
};

/** CHAINPAY_CARDS_API_URL + CHAINPAY_CARDS_RUNNER_SECRET (>= 32 chars), or undefined when card checkout is off. */
export function loadCardShopSettings(env: NodeJS.ProcessEnv): CardShopSettings | undefined {
  const apiUrl = env.CHAINPAY_CARDS_API_URL?.trim();
  const runnerSecret = env.CHAINPAY_CARDS_RUNNER_SECRET?.trim();
  if (!apiUrl && !runnerSecret) return undefined;
  if (!apiUrl || !runnerSecret) throw new Error("Set both CHAINPAY_CARDS_API_URL and CHAINPAY_CARDS_RUNNER_SECRET, or neither");
  if (runnerSecret.length < 32) throw new Error("CHAINPAY_CARDS_RUNNER_SECRET must be at least 32 characters");
  const url = new URL(apiUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("CHAINPAY_CARDS_API_URL must be https (http only on loopback)");
  return { apiUrl: url.toString().replace(/\/+$/, ""), runnerSecret };
}

async function publicShop(shop: CardShop) {
  return {
    merchantRef: shop.ref,
    displayName: shop.displayName,
    sells: shop.sells,
    fixture: shop.fixture,
    acceptorId: shop.acceptorId,
    descriptor: shop.descriptor,
    mcc: shop.mcc,
    merchantIdHash: Buffer.from(await merchantIdHash(shop.acceptorId)).toString("hex"),
    item: shop.item,
    display: { price: formatUsdCents(shop.item.amountCents) },
    checkout: {
      tool: "request_card_checkout",
      arguments: { merchantRef: shop.ref, amountCents: shop.item.amountCents, currency: "USD" },
      then: `POST /card-shops/${shop.ref}/checkout {"capability":"cpcap_v1_…"}`,
    },
  };
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function cardShopHtml(shop: CardShop): string {
  const price = formatUsdCents(shop.item.amountCents);
  const note = shop.fixture === "approved"
    ? "This shop is on the demo card's allowlist. A checkout for the exact price goes through."
    : "This shop is not on the demo card's allowlist. ChainPay refuses the checkout before the card is ever used.";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(shop.displayName)} · sandbox shop</title>
<style>
  :root { color-scheme: light; --ink: #0b1220; --body: #4a5568; --line: #e3e8f0; --blue: #0052ff; }
  body { margin: 0; font: 15px/1.5 Inter, system-ui, sans-serif; color: var(--ink); background: #f6f8fb; }
  main { max-width: 560px; margin: 0 auto; padding: 32px 16px; display: grid; gap: 16px; }
  .tag { display: inline-block; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); background: #fff; font-size: 12px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--body); }
  section { background: #fff; border: 1px solid var(--line); border-radius: 16px; padding: 20px; display: grid; gap: 8px; }
  h1 { margin: 0; font-size: 24px; letter-spacing: -.02em; }
  .price { font-size: 32px; font-weight: 600; font-variant-numeric: tabular-nums; }
  code { font: 13px/1.5 ui-monospace, Menlo, monospace; background: #f0f2f6; padding: 2px 6px; border-radius: 6px; overflow-wrap: anywhere; }
  p { margin: 0; color: var(--body); }
</style>
</head>
<body>
<main>
  <span class="tag">Sandbox shop · no real money</span>
  <section>
    <h1>${escapeHtml(shop.displayName)}</h1>
    <p>${escapeHtml(shop.item.name)}</p>
    <div class="price">${escapeHtml(price)}</div>
    <p>${escapeHtml(note)}</p>
  </section>
  <section>
    <strong>How an agent pays here</strong>
    <p>1. Call <code>request_card_checkout</code> with <code>merchantRef: "${escapeHtml(shop.ref)}"</code> and <code>amountCents: "${escapeHtml(shop.item.amountCents)}"</code>.</p>
    <p>2. Send the one-time capability to <code>POST /card-shops/${escapeHtml(shop.ref)}/checkout</code>.</p>
    <p>This shop never sees a card number, CVV or expiry, and there is nowhere to type one.</p>
  </section>
  <p>Card network id <code>${escapeHtml(shop.acceptorId)}</code> · category ${shop.mcc}</p>
</main>
</body>
</html>`;
}

const PAGE_CSP = ["default-src 'none'", "style-src 'unsafe-inline'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");

/** Plain words for every redeem outcome. Unknown codes fall back to a generic refusal; Axum's text is never forwarded. */
const OUTCOMES: Record<string, { status: number; message: string }> = {
  capability_used: { status: 409, message: "This checkout was already used. Ask ChainPay for a new one." },
  capability_expired: { status: 409, message: "This checkout expired. Ask ChainPay for a new one." },
  intent_refused: { status: 409, message: "The card's rules refused this checkout." },
  unknown_merchant: { status: 400, message: "ChainPay doesn't know this shop." },
  amount: { status: 400, message: "The amount isn't valid." },
  checkout_disabled: { status: 503, message: "Card checkout is switched off on ChainPay right now." },
};

type RedeemBody = { runId?: unknown; state?: unknown; code?: unknown };

function orderResponse(shop: CardShop, runId: string, state: string) {
  const submitted = state === "submitted";
  const body = {
    order: {
      shop: shop.displayName,
      merchantRef: shop.ref,
      item: shop.item.name,
      amountCents: shop.item.amountCents,
      currency: "USD",
      display: { amount: formatUsdCents(shop.item.amountCents) },
      state: submitted ? "sent_to_card_network" : "card_network_error",
    },
    runId,
    next: submitted
      ? "The card checks its rules when the network asks, in about a second. The card's owner sees the approval or decline in ChainPay."
      : "The card network didn't take the charge. Nothing was spent; ask ChainPay for a new checkout to try again.",
  };
  // Belt and braces: nothing card-shaped can leave, whatever Axum sent.
  return redactCardData(body).value;
}

export function mountCardShops(app: Express, deps: CardShopDependencies = {}): void {
  const doFetch = deps.fetch ?? globalThis.fetch;

  app.get("/card-shops", async (_request: Request, response: Response) => {
    response.set("Cache-Control", "no-store").json({ sandbox: true, shops: await Promise.all(CARD_SHOPS.map(publicShop)) });
  });

  app.get("/card-shops/:ref", (request: Request, response: Response) => {
    const shop = cardShopByRef(String(request.params.ref));
    if (!shop) return response.status(404).json({ error: "No such shop" });
    if (request.accepts(["html", "json"]) === "json") {
      return publicShop(shop).then((body) => response.set("Cache-Control", "no-store").json(body));
    }
    return response.set({ "Content-Security-Policy": PAGE_CSP, "Cache-Control": "no-store" }).type("html").send(cardShopHtml(shop));
  });

  app.post("/card-shops/:ref/checkout", express.json({ limit: "1kb" }), async (request: Request, response: Response) => {
    response.set("Cache-Control", "no-store");
    const shop = cardShopByRef(String(request.params.ref));
    if (!shop) return response.status(404).json({ error: "No such shop" });
    const body: unknown = request.body;
    // Closed body: only the capability. Anything else (a card number, an amount
    // override, a different shop) is refused before ChainPay is called.
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "capability")) {
      return response.status(400).json({ error: "Send only {\"capability\": \"cpcap_v1_…\"}. This shop never takes card details." });
    }
    const capability = (body as { capability?: unknown }).capability;
    if (!isCheckoutCapability(capability)) {
      return response.status(400).json({ error: "That isn't a ChainPay checkout capability." });
    }
    if (!deps.settings) {
      return response.status(503).json({ error: "Card checkout needs CHAINPAY_CARDS_API_URL and CHAINPAY_CARDS_RUNNER_SECRET on this host." });
    }
    let status: number;
    let parsed: RedeemBody;
    try {
      const reply = await doFetch(`${deps.settings.apiUrl}/v1/cards/checkout/redeem`, {
        method: "POST",
        headers: { authorization: `Bearer ${deps.settings.runnerSecret}`, "content-type": "application/json" },
        // The shop states where the checkout really happens and at what price.
        // A capability bound to another shop or amount fails on the private rollup and is consumed.
        body: JSON.stringify({ capability, merchantRef: shop.ref, amountCents: shop.item.amountCents }),
        signal: AbortSignal.timeout(15_000),
      });
      status = reply.status;
      parsed = await reply.json().catch(() => ({})) as RedeemBody;
    } catch {
      return response.status(502).json({ error: "Couldn't reach ChainPay. The checkout may still be unused; try again." });
    }
    if (status === 200 && typeof parsed.runId === "string" && /^[0-9a-f]{32}$/.test(parsed.runId) && typeof parsed.state === "string") {
      return response.json(orderResponse(shop, parsed.runId, parsed.state));
    }
    const code = typeof parsed.code === "string" ? parsed.code : "";
    const outcome = OUTCOMES[code] ?? (status === 404 ? { status: 404, message: "ChainPay doesn't recognise this checkout." } : { status: 502, message: "ChainPay couldn't run this checkout." });
    return response.status(outcome.status).json({ error: outcome.message, ...(OUTCOMES[code] ? { code } : {}) });
  });
}
