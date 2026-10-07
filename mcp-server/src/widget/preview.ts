/**
 * Illustrative fixtures for GET /widget/preview: every card state with sample
 * values, labelled as a preview. Never served as a tool result.
 */
const sig = "5Tq8sample1111111111111111111111111111111111111111111111111111111Wv2a";
const base = {
  version: 1,
  amount: "10",
  symbol: "USDC",
  merchant: "Halden Data Co.",
  product: "Market data report",
  cluster: "Solana Devnet",
  recipientShort: "9xQe…k3Fp",
  checks: ["Merchant signature verified", "Payment request has not been used", "Permission is active", "Token matches permission", "Recipient verified", "Request has not expired"],
  limits: { requested: "10", cap: "21", remaining: "30", after: "20", withinLimits: true },
};

export const WIDGET_PREVIEW_FIXTURES: Record<string, Record<string, unknown>> = {
  ready: { ...base, state: "ready" },
  paying: { ...base, state: "paying", currentStep: 3 },
  confirming: { ...base, state: "confirming", currentStep: 4, slow: true, signature: sig, explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet` },
  settled: {
    ...base, state: "settled", signature: sig, txShort: "5Tq8…Wv2a", receiptShort: "Rc7m…2bLp", receiptUrl: "https://example.invalid/verify/sample",
    explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`, limits: { requested: "10", cap: "21", remaining: "20" },
  },
  blocked: {
    ...base, state: "blocked", amount: "25", product: "Annual data license", reasonKind: "limits", rejectedBeforeBroadcast: true,
    reason: "Requested amount exceeds the 21 USDC per-payment cap.", limits: { requested: "25", cap: "21", remaining: "30", withinLimits: false },
  },
  unknown: { ...base, state: "unknown" },
};

export function widgetPreviewScript(state: string): string {
  const key = Object.hasOwn(WIDGET_PREVIEW_FIXTURES, state) ? state : "ready";
  const names = Object.keys(WIDGET_PREVIEW_FIXTURES);
  return `<style>.pv{max-width:560px;margin:16px auto 12px;padding:0 16px;font:400 13px/18px Inter,system-ui,sans-serif}.pv p{margin:0 0 8px;padding:8px 12px;border-radius:10px;background:#fef9c3;color:#854d0e;font-weight:600}.pv nav{display:flex;flex-wrap:wrap;gap:6px}.pv a{padding:6px 12px;border:1px solid #c6d1e6;border-radius:999px;color:#14213d;text-decoration:none}.pv a[aria-current]{border-color:#0052ff;color:#0052ff;background:#eff4ff}body{background:#f5f7fb}</style>
<div class="pv"><p>Illustrative preview. Sample values, not a real payment.</p><nav>${names.map((name) => `<a href="?state=${name}"${name === key ? ' aria-current="page"' : ""}>${name}</a>`).join("")}</nav></div>
<script>window.__CHAINPAY_WIDGET_PREVIEW__ = true;
window.addEventListener("DOMContentLoaded", () => { model = ${JSON.stringify(WIDGET_PREVIEW_FIXTURES[key])}; render(document.getElementById("root"), model); });</script>`;
}
