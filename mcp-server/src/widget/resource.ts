import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHAINPAY_LOGO_SVG } from "../logo.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** MCP Apps (io.modelcontextprotocol/ui) view for the payment card. */
export const PAYMENT_WIDGET_URI = "ui://chainpay/payment-widget.html";
/** The same view under the OpenAI Apps SDK template mime type. */
export const PAYMENT_WIDGET_OPENAI_URI = "ui://chainpay/payment-widget.openai.html";

export const MCP_APP_MIME = "text/html;profile=mcp-app";
export const OPENAI_WIDGET_MIME = "text/html+skybridge";
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

const FONT_DOMAINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];

/** `_meta` for a tool whose result renders as the payment card. */
export const PAYMENT_WIDGET_TOOL_META = {
  ui: { resourceUri: PAYMENT_WIDGET_URI },
  "openai/outputTemplate": PAYMENT_WIDGET_OPENAI_URI,
  "openai/widgetAccessible": true,
  "openai/toolInvocation/invoking": "Checking the payment",
  "openai/toolInvocation/invoked": "Payment checked",
} as const;

const TOKEN_ICON_FILES: Record<string, { file: string; mime: string }> = {
  USDC: { file: "assets/brands/usdc.svg", mime: "image/svg+xml" },
  EURC: { file: "assets/brands/eurc.svg", mime: "image/svg+xml" },
  USDG: { file: "assets/brands/usdg.svg", mime: "image/svg+xml" },
  PYUSD: { file: "assets/brands/pyusd.png", mime: "image/png" },
};

let cachedHtml: string | undefined;

function tokenIcons(): Record<string, string> {
  const icons: Record<string, string> = {};
  for (const [symbol, { file, mime }] of Object.entries(TOKEN_ICON_FILES)) {
    try {
      icons[symbol] = `data:${mime};base64,${readFileSync(join(PACKAGE_ROOT, file)).toString("base64")}`;
    } catch {
      // A missing icon leaves the amount without art rather than breaking the card.
    }
  }
  return icons;
}

/**
 * The card as one self-contained page: logo and token art are inlined so the
 * view makes no network request except the brand fonts declared in its CSP.
 * `previewScript` is used only by the local /widget/preview route.
 */
export function paymentWidgetHtml(previewScript = ""): string {
  cachedHtml ??= readFileSync(join(PACKAGE_ROOT, "assets/widget/payment-widget.html"), "utf8")
    .replace("__CHAINPAY_LOGO__", () => JSON.stringify(CHAINPAY_LOGO_SVG.replace("<svg ", '<svg class="cpw-logo" ')))
    .replace("__TOKEN_ICONS__", () => JSON.stringify(tokenIcons()));
  return cachedHtml.replace("__PREVIEW__", () => previewScript);
}

const resourceMeta = {
  ui: {
    csp: { connectDomains: [], resourceDomains: FONT_DOMAINS },
    permissions: { clipboardWrite: {} },
    prefersBorder: false,
  },
  "openai/widgetCSP": { connect_domains: [], resource_domains: FONT_DOMAINS },
  "openai/widgetPrefersBorder": false,
  "openai/widgetDescription": "A ChainPay payment card: amount, safeguards, live settlement progress and the receipt.",
};

const RESOURCES = [
  { uri: PAYMENT_WIDGET_URI, mimeType: MCP_APP_MIME },
  { uri: PAYMENT_WIDGET_OPENAI_URI, mimeType: OPENAI_WIDGET_MIME },
] as const;

export function listUiResources() {
  return {
    resources: RESOURCES.map(({ uri, mimeType }) => ({
      uri,
      name: "chainpay-payment-widget",
      title: "ChainPay payment",
      description: "Payment card for merchant-signed ChainPay payments.",
      mimeType,
      _meta: resourceMeta,
    })),
  };
}

/** `resources/read` result for a known UI resource, or undefined. */
export function readUiResource(uri: unknown) {
  const resource = RESOURCES.find((item) => item.uri === uri);
  if (!resource) return undefined;
  return {
    contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: paymentWidgetHtml(), _meta: resourceMeta }],
  };
}
