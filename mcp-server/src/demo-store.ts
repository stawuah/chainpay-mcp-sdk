import { Keypair } from "@solana/web3.js";
import type { PaymentRequestPayload } from "@chainpayhq/sdk";
import type { ChainPayMcpContext } from "./tools/context.js";
import { assertRecipientTokenAccount, demoMerchant, signCanonicalPayload } from "./tools/demo-payment-request.js";
import { CHAINPAY_SYMBOL_SVG } from "./logo.js";
import { DEMO_MERCHANT_NAME, DEMO_PRODUCTS, type DemoProduct } from "./widget/merchants.js";

/** Canonical Devnet USDC (classic SPL Token). */
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export class DemoStoreError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function wholeToBaseUnits(whole: string, decimals: number): string {
  if (!/^\d+$/.test(whole)) throw new Error(`Invalid price: ${whole}`);
  return (BigInt(whole) * 10n ** BigInt(decimals)).toString();
}

export function demoStoreRecipient(): string | undefined {
  return process.env.CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT?.trim() || undefined;
}

/**
 * A merchant-signed Devnet USDC request for one store item. The signature
 * covers the amount, recipient, description and line item, so the agent can
 * verify every field it shows the owner and cannot change any of them.
 */
export async function createDemoStoreRequest(
  context: ChainPayMcpContext,
  productId: unknown,
  origin: string,
) {
  const product = DEMO_PRODUCTS.find((item) => item.id === productId);
  if (!product) throw new DemoStoreError("Unknown product", 400);
  const recipient = demoStoreRecipient();
  if (!recipient) {
    throw new DemoStoreError("This demo store has no USDC payout account yet. Set CHAINPAY_DEMO_MERCHANT_USDC_RECIPIENT to the merchant's Devnet USDC token account.", 503);
  }

  await assertRecipientTokenAccount(context, recipient, DEVNET_USDC_MINT, "spl-token");
  const merchant = demoMerchant();
  const decimals = await context.client.getMintDecimals(DEVNET_USDC_MINT);
  const currentSlot = await context.client.getCurrentSlot();
  const amount = wholeToBaseUnits(product.price, decimals);
  const payload: PaymentRequestPayload = {
    version: 1,
    cluster: "devnet",
    merchant: merchant.keypair.publicKey.toBase58(),
    invoice: `halden-${product.id}-${Date.now()}`,
    mint: DEVNET_USDC_MINT,
    tokenProgram: "spl-token",
    recipient,
    amount,
    decimals,
    nonce: Keypair.generate().publicKey.toBase58(),
    expiresAtSlot: (currentSlot + 5_000n).toString(),
    resource: `${origin}/demo/store#${product.id}`,
    description: product.name,
    lineItems: [{ label: product.name, amount, quantity: "1" }],
  };
  return {
    request: { payload, signature: signCanonicalPayload(payload, merchant.keypair) },
    product,
    persistentMerchant: merchant.persistent,
  };
}

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;
const recent = new Map<string, number[]>();

/** A small per-address limit: each request reads Devnet twice. */
export function allowDemoStoreRequest(key: string, now = Date.now()): boolean {
  const hits = (recent.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
  if (hits.length >= RATE_LIMIT) {
    recent.set(key, hits);
    return false;
  }
  hits.push(now);
  recent.set(key, hits);
  if (recent.size > 5_000) recent.clear();
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function productCard(product: DemoProduct): string {
  return `<article class="item" id="${product.id}">
      <div>
        <h2>${escapeHtml(product.name)}</h2>
        <p>${escapeHtml(product.blurb)}</p>
      </div>
      <div class="buy">
        <p class="price"><b>${product.price}</b> USDC</p>
        <button type="button" data-product="${product.id}">Generate payment request</button>
      </div>
    </article>`;
}

export function renderDemoStoreHtml(): string {
  const configured = Boolean(demoStoreRecipient());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DEMO_MERCHANT_NAME}</title>
<meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
:root { --ink: #1c1917; --body: #57534e; --line: #e7e5e4; --soft: #fafaf9; --accent: #14532d; --blue: #0052ff; --sans: Inter, ui-sans-serif, system-ui, sans-serif; --mono: "JetBrains Mono", ui-monospace, Menlo, monospace; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: var(--ink); font: 400 15px/22px var(--sans); }
main { max-width: 760px; margin: 0 auto; padding: 40px 16px 64px; }
header { display: flex; align-items: center; gap: 12px; }
.mark { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 10px; background: var(--accent); color: #fff; font: 600 18px var(--sans); }
header h1 { margin: 0; font: 600 22px/28px var(--sans); letter-spacing: -0.01em; }
header p { margin: 2px 0 0; color: var(--body); font-size: 13px; }
.intro { margin: 28px 0 20px; color: var(--body); }
.items { display: grid; gap: 12px; }
.item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; padding: 20px; border: 1px solid var(--line); border-radius: 14px; }
.item h2 { margin: 0; font: 600 17px/24px var(--sans); }
.item p { margin: 4px 0 0; color: var(--body); font-size: 14px; }
.buy { display: flex; align-items: center; gap: 16px; }
.price { margin: 0 !important; color: var(--ink) !important; font: 500 15px var(--mono) !important; white-space: nowrap; }
.price b { font-size: 22px; font-weight: 500; }
button { min-height: 44px; padding: 0 16px; border: 1px solid var(--ink); border-radius: 10px; background: var(--ink); color: #fff; font: 500 14px var(--sans); cursor: pointer; }
button.secondary { border-color: var(--line); background: #fff; color: var(--ink); }
button:disabled { opacity: .6; cursor: progress; }
button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.out { margin-top: 24px; padding: 20px; border: 1px solid var(--line); border-radius: 14px; background: var(--soft); }
.out[hidden] { display: none; }
.out h3 { margin: 0; font: 600 15px/22px var(--sans); }
.out p { margin: 4px 0 12px; color: var(--body); font-size: 14px; }
.out pre { max-height: 280px; margin: 0 0 12px; padding: 14px; overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: #fff; font: 500 12px/18px var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.status { color: var(--body); font-size: 13px; }
.error { color: #b91c1c; }
.note { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; background: #fef9c3; color: #854d0e; font-size: 13px; }
footer { display: flex; align-items: center; gap: 8px; margin-top: 40px; color: var(--body); font-size: 13px; }
footer svg { width: 18px; height: 18px; color: var(--blue); }
@media (max-width: 520px) { .buy { width: 100%; justify-content: space-between; } }
</style>
</head>
<body>
<main>
  <header>
    <span class="mark" aria-hidden="true">H</span>
    <div><h1>${DEMO_MERCHANT_NAME}</h1><p>Demo merchant · Solana Devnet</p></div>
  </header>
  <p class="intro">Market data for teams. Pick an item to get a payment request signed by this store. Hand it to your agent; your agent pays it through your ChainPay spending permission. Devnet USDC only, no real money.</p>
  ${configured ? "" : '<p class="note">This store has no Devnet USDC payout account configured yet, so it can\'t sign requests.</p>'}
  <section class="items" aria-label="Products">
    ${DEMO_PRODUCTS.map(productCard).join("\n    ")}
  </section>
  <section class="out" hidden aria-live="polite">
    <h3 id="out-title">Payment request</h3>
    <p>Signed by this store. Paste it into your agent and ask it to verify and quote the request before paying.</p>
    <pre id="out-json" tabindex="0"></pre>
    <div class="row"><button type="button" class="secondary" id="copy">Copy request</button><span class="status" id="copy-status" role="status"></span></div>
  </section>
  <p class="status error" id="error" role="alert"></p>
  <footer>${CHAINPAY_SYMBOL_SVG.replace("<svg ", '<svg aria-hidden="true" ')}<span>Agents pay with ChainPay</span></footer>
</main>
<script>
const out = document.querySelector(".out");
const pre = document.getElementById("out-json");
const error = document.getElementById("error");
const copyStatus = document.getElementById("copy-status");
document.querySelectorAll("[data-product]").forEach((button) => button.addEventListener("click", async () => {
  const label = button.textContent;
  button.disabled = true; button.textContent = "Signing…"; error.textContent = "";
  try {
    const response = await fetch("/demo/store/requests", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product: button.dataset.product }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "The store couldn't sign this request.");
    document.getElementById("out-title").textContent = "Payment request · " + body.product.name + " · " + body.product.price + " USDC";
    pre.textContent = JSON.stringify(body.request, null, 2);
    out.hidden = false; copyStatus.textContent = "";
    out.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  } catch (cause) {
    error.textContent = cause.message;
  } finally {
    button.disabled = false; button.textContent = label;
  }
}));
document.getElementById("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(pre.textContent); copyStatus.textContent = "Copied"; }
  catch { const range = document.createRange(); range.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); copyStatus.textContent = "Selected. Press Ctrl or Cmd + C."; }
});
</script>
</body>
</html>`;
}
