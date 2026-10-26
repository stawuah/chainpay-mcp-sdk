/** Credential-free browser entrypoint. No imports from the agent or Solana SDK. */
export const PAYPAL_SERVICE_IDS = ["document-extract-v1", "document-compare-v1", "requirements-check-v1"] as const;
export type PayPalServiceId = typeof PAYPAL_SERVICE_IDS[number];
export function paypalWorkspaceUrl(workspaceOrigin: string, serviceId: PayPalServiceId): string {
  if (!PAYPAL_SERVICE_IDS.includes(serviceId)) throw new Error("Unknown registered service");
  // Check the raw form as URL parsing would otherwise normalize path traversal.
  if (!/^https?:\/\/[^/?#\\\s]+\/?$/.test(workspaceOrigin)) throw new Error("Supply an explicit workspace origin without paths or credentials");
  const url = new URL(workspaceOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.hostname.endsWith(".") || url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.hostname === "chainpay-relay.vercel.app" || url.hostname === "chainpayai.app" || url.hostname.endsWith(".chainpayai.app")) throw new Error("Use a separate HTTPS PayPal workspace origin (localhost HTTP for development)");
  return `${url.origin}/paypal/?service=${encodeURIComponent(serviceId)}`;
}
export function createPayPalServiceLink(workspaceOrigin: string, serviceId: PayPalServiceId, label = "Continue in ChainPay"): HTMLAnchorElement {
  const href = paypalWorkspaceUrl(workspaceOrigin, serviceId);
  const link = document.createElement("a");
  link.href = href; link.textContent = label;
  link.target = "_blank"; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer";
  return link;
}
