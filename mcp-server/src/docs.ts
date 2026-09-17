import { NAV_ICONS, renderBrandLogoHtml } from "./logo.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";

type ToolDefinition = (typeof TOOL_DEFINITIONS)[number];

const PRODUCT_APP_URL = (process.env.CHAINPAY_APP_URL ?? "https://chainpay-frontend.onrender.com").replace(/\/$/, "");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderCode(code: string): string {
  return `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`;
}

function requiredFields(tool: ToolDefinition): string[] {
  const schema = tool.inputSchema as { required?: readonly string[] };
  return schema.required ? [...schema.required] : [];
}

function renderTool(tool: ToolDefinition, index: number): string {
  const required = requiredFields(tool);
  const slug = tool.name.replaceAll("_", "-");
  const requiredMarkup = required.length
    ? `<div class="tool-fields"><span>required</span>${required.map((field) => `<code>${escapeHtml(field)}</code>`).join("")}</div>`
    : `<div class="tool-fields"><span>input</span><code>none</code></div>`;

  return `<article class="tool-card" id="tool-${slug}">
    <div class="tool-card-top">
      <span class="tool-number">${String(index + 1).padStart(2, "0")}</span>
      <code class="tool-name">${escapeHtml(tool.name)}</code>
      <span class="tool-badge">MCP tool</span>
    </div>
    <p>${escapeHtml(tool.description)}</p>
    ${requiredMarkup}
  </article>`;
}

function renderToolReference(): string {
  return TOOL_DEFINITIONS.map(renderTool).join("\n");
}

function navLink(href: string, icon: string, label: string): string {
  return `<a class="nav-link" href="${href}"><span class="nav-icon">${icon}</span>${escapeHtml(label)}</a>`;
}

type UseCaseStep = {
  from: string;
  to: string;
  message: string;
};

type UseCase = {
  title: string;
  scenario: string;
  summary: string;
  outcome: string;
  steps: UseCaseStep[];
};

const USE_CASES: UseCase[] = [
  {
    title: "Inspect a payment request",
    scenario: "Check this invoice before asking me to approve a payment.",
    summary: "An authenticated assistant checks the invoice, reads an owned mandate, and reports whether the exact request fits its limits.",
    outcome: "A quote or a clear reason to stop. No funds move during inspection.",
    steps: [
      { from: "Agent", to: "ChainPay MCP", message: "Verify the request and inspect the selected mandate." },
      { from: "ChainPay MCP", to: "Policy", message: "Check asset, amount, recipient, expiry, and remaining limits." },
      { from: "ChainPay MCP", to: "Owner", message: "Show the quote or missing requirements before approval." },
    ],
  },
  {
    title: "Pay a custom x402 resource",
    scenario: "Prepare access to this trusted Devnet merchant resource.",
    summary: "A custom x402/1.0 challenge can become a mandate-checked payment. Human mode requires external wallet approval; delegated mode requires a provisioned mandate-bound signer.",
    outcome: "Settlement proof and a separate merchant delivery result. A paid delivery retry reuses the existing payment ID.",
    steps: [
      { from: "Agent", to: "Merchant", message: "Fetch the allowed resource and read its 402 challenge." },
      { from: "ChainPay MCP", to: "Policy", message: "Detect custom x402/1.0 and validate the exact request." },
      { from: "Wallet or provider", to: "Axum", message: "Sign through the selected authorized path." },
      { from: "Axum", to: "Solana", message: "Submit the validated transaction and verify finality." },
      { from: "ChainPay MCP", to: "Merchant", message: "Retry the original resource with signature and receipt PDA." },
    ],
  },
  {
    title: "Read a receipt",
    scenario: "Show the settlement evidence for this payment.",
    summary: "An authorized caller retrieves the receipt and backend settlement status. A receipt PDA is a program-derived account recording the payment.",
    outcome: "Exact amount, token, recipient, and settlement evidence. Delivery remains a separate claim.",
    steps: [
      { from: "Agent", to: "ChainPay MCP", message: "Look up the existing payment ID and receipt address." },
      { from: "ChainPay MCP", to: "Solana", message: "Read the program-owned receipt account." },
      { from: "ChainPay MCP", to: "Agent", message: "Return receipt fields and available persisted signature." },
    ],
  },
];

function renderUseCaseReference(): string {
  return USE_CASES.map((useCase, index) => {
    const slug = useCase.title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const steps = useCase.steps.map((step, stepIndex) => `<div class="uml-message"><span class="uml-number">${String(stepIndex + 1).padStart(2, "0")}</span><strong>${escapeHtml(step.from)}</strong><span class="uml-arrow" aria-hidden="true">→</span><strong>${escapeHtml(step.to)}</strong><p>${escapeHtml(step.message)}</p></div>`).join("\n");
    return `<details class="use-case-detail" id="use-case-${slug}">
      <summary><span class="usecase-index">${String(index + 1).padStart(2, "0")}</span><span class="use-case-summary"><strong>${escapeHtml(useCase.title)}</strong><small>${escapeHtml(useCase.scenario)}</small></span><span class="use-case-open">Open flow <span aria-hidden="true">↓</span></span></summary>
      <div class="use-case-body"><p class="use-case-description">${escapeHtml(useCase.summary)}</p><div class="uml-diagram" role="img" aria-label="${escapeHtml(useCase.title)} payment sequence diagram"><div class="uml-title"><span>AGENT SEQUENCE</span><span>CHAINPAY MCP · CONNECTOR · SOLANA</span></div>${steps}</div><div class="use-case-outcome"><strong>Result</strong><span>${escapeHtml(useCase.outcome)}</span></div></div>
    </details>`;
  }).join("\n");
}

function renderAssetStrip(): string {
  const items = [
    { src: "/assets/brands/solana.svg", name: "Solana", role: "Network · Devnet" },
    { src: "/assets/brands/usdc.svg", name: "USDC", role: "Supported token · Devnet" },
    { src: "/assets/brands/pyusd.png", name: "PYUSD", role: "PayPal USD · Devnet" },
  ];
  return items.map((item) => `<div class="asset-item"><img class="asset-mark" src="${item.src}" alt="" width="36" height="36" loading="lazy" /><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.role)}</span></div></div>`).join("");
}

export function renderDocsHtml(): string {
  const connectionConfig = `{
  "mcpServers": {
    "chainpay": {
      "url": "https://YOUR_MCP_HOST/mcp"
    }
  }
}`;

  const demoPrompt = "List ChainPay tools, then call get_protocol_config with no arguments. Report the result or error. Do not prepare, sign, or submit a payment.";

  const quoteExample = `{
  "mandate": "MANDATE_PDA",
  "agent": "AGENT_PUBLIC_KEY",
  "invoiceHash": "32_BYTE_HEX_HASH",
  "paymentId": "32_BYTE_HEX_PAYMENT_ID",
  "signatureReference": "32_BYTE_HEX_REFERENCE",
  "mint": "TOKEN_MINT",
  "recipient": "RECIPIENT_TOKEN_ACCOUNT",
  "amount": "1000000",
  "tokenProgram": "spl-token"
}`;

  const brandLogo = renderBrandLogoHtml();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0052ff" />
    <meta name="description" content="Connect an agent to ChainPay MCP. Inspect spending permissions, prepare payments, and read receipts on Solana Devnet." />
    <link rel="icon" href="/brand/chainpay-icon.svg" type="image/svg+xml" />
    <link rel="canonical" href="https://chainpay-mcp.onrender.com/docs" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="ChainPay" />
    <meta property="og:url" content="https://chainpay-mcp.onrender.com/docs" />
    <meta property="og:title" content="Connect an agent. Keep the limits." />
    <meta property="og:description" content="MCP tools to inspect spending permissions, prepare payments, and read receipts on Solana Devnet." />
    <meta property="og:image" content="https://chainpay-mcp.onrender.com/og-image.png" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="https://chainpay-mcp.onrender.com/og-image.png" />
    <meta name="twitter:title" content="Connect an agent. Keep the limits." />
    <meta name="twitter:description" content="MCP tools to inspect spending permissions, prepare payments, and read receipts on Solana Devnet." />
    <title>ChainPay MCP docs</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap');
      :root {
        color-scheme: light;
        --ink: #14213d;
        --body: #56647d;
        --muted: #6a7183;
        --line: #dbe2ef;
        --line-soft: #edf0f4;
        --canvas: #ffffff;
        --soft: #f8f9fb;
        --strong: #eff4ff;
        --blue: #0052ff;
        --blue-active: #003ecc;
        --blue-soft: #edf3ff;
        --green: #05b169;
        --green-ink: #276347;
        --sidebar: 248px;
        --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;
        --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --radius-card: 12px;
        --radius-control: 8px;
        --shadow: 0 4px 12px rgba(20, 33, 61, .06);
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body { margin: 0; color: var(--ink); background: var(--soft); font: 14px/1.6 var(--sans); }
      a { color: inherit; text-decoration: none; }
      code, pre { font-family: var(--mono); }
      .cp-brand { display: inline-flex; align-items: center; gap: .32em; color: var(--ink); font-family: var(--sans); font-size: 23px; font-weight: 500; letter-spacing: -.035em; line-height: 1; white-space: nowrap; }
      .cp-brand-symbol { display: block; width: 1.42em; height: 1.42em; flex: none; color: var(--blue); }
      .cp-brand-wordmark { color: var(--ink); }
      .layout { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); min-height: 100vh; }
      .sidebar { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 24px 12px 16px; border-right: 1px solid var(--line); background: var(--canvas); }
      .brand-link { display: block; padding: 0 10px 28px; }
      .version { display: inline-flex; align-items: center; gap: 7px; margin: 0 10px 24px; padding: 7px 11px; border: 1px solid var(--line); border-radius: 100px; color: var(--ink); background: var(--soft); font: 500 10px var(--mono); }
      .version i { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }
      .nav-group { margin-top: 24px; }
      .nav-label { padding: 0 10px 8px; color: var(--muted); font: 600 10px var(--mono); letter-spacing: .08em; text-transform: uppercase; }
      .nav-link { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 10px 12px; border-radius: var(--radius-control); color: #5c6677; font-size: 14px; }
      .nav-link:hover, .nav-link.active { color: var(--blue); background: var(--blue-soft); font-weight: 500; }
      .nav-icon { display: inline-flex; align-items: center; justify-content: center; width: 20px; color: var(--blue); flex: none; }
      .sidebar-foot { margin: 32px 10px 0; padding-top: 16px; border-top: 1px solid var(--line); color: var(--body); font-size: 12px; line-height: 1.6; }
      .sidebar-foot a { color: var(--blue); font-weight: 500; }
      .main { min-width: 0; background: var(--canvas); }
      .topbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 78px; padding: 0 40px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.92); backdrop-filter: blur(12px); position: sticky; top: 0; z-index: 10; }
      .breadcrumbs { color: var(--body); font-size: 13px; }
      .breadcrumbs strong { color: #3f4958; font-weight: 500; }
      .top-links { display: flex; align-items: center; gap: 20px; color: var(--body); font-size: 13px; }
      .top-links a:hover { color: var(--blue); }
      .network { display: inline-flex; align-items: center; gap: 8px; padding: 0; border: 0; color: #5b6778; background: transparent; font: 500 12px var(--sans); }
      .network i { width: 6px; height: 6px; border-radius: 50%; background: #758298; }
      .content { max-width: 1100px; margin: 0 auto; padding: 0 40px 96px; }
      .hero { padding: 48px 0 32px; }
      .eyebrow { margin: 0; color: var(--blue); font: 600 12px var(--mono); letter-spacing: .08em; text-transform: uppercase; }
      h1, h2, h3 { margin: 0; letter-spacing: -.035em; font-weight: 500; }
      h1 { max-width: 18ch; margin-top: 20px; font-size: clamp(36px, 5vw, 52px); line-height: 1.08; text-wrap: balance; }
      h1 em { color: var(--blue); font-style: normal; }
      .hero-copy { max-width: 42rem; margin-top: 20px; color: var(--body); font-size: 16px; line-height: 1.65; }
      .hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; margin-top: 32px; }
      .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 12px 20px; border-radius: 100px; font-size: 15px; font-weight: 500; border: 0; cursor: pointer; }
      .button-primary { color: #fff; background: var(--blue); }
      .button-primary:hover { background: var(--blue-active); }
      .button-quiet { border: 1px solid var(--line); color: var(--ink); background: #fff; }
      .button-quiet:hover { border-color: var(--blue); color: var(--blue); }
      .endpoint-pill { display: inline-flex; align-items: center; gap: 8px; margin-top: 20px; padding: 9px 13px; border: 1px solid var(--line); border-radius: 100px; color: var(--body); background: var(--soft); font-size: 12px; }
      .endpoint-pill code { color: var(--ink); font-weight: 500; }
      .asset-strip { display: flex; flex-wrap: wrap; gap: 20px; margin-top: 32px; padding: 20px 0; border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); }
      .asset-item { display: flex; align-items: center; gap: 12px; min-width: 0; }
      .asset-mark { width: 36px; height: 36px; object-fit: contain; flex: none; }
      .asset-item strong { display: block; font-size: 14px; font-weight: 500; }
      .asset-item span { display: block; color: var(--body); font-size: 12px; }
      .hero-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(240px, .7fr); gap: 24px; align-items: stretch; margin-top: 40px; }
      .hero-panel, .info-card, .tool-card, .endpoint-card, .stat, .flow, .table-wrap, .use-case-detail, .usecase-card, .rail-card { border: 1px solid var(--line); border-radius: var(--radius-card); background: #fff; }
      .hero-panel { padding: 24px; box-shadow: var(--shadow); }
      .panel-kicker, .code-label, .section-index, .tool-number, .method, .uml-title, .usecase-index, .use-case-open { font-family: var(--mono); }
      .panel-kicker { color: var(--muted); font: 600 10px var(--mono); letter-spacing: .08em; text-transform: uppercase; }
      .hero-panel h2 { margin-top: 12px; font-size: 22px; }
      .hero-panel p { margin: 10px 0 0; color: var(--body); font-size: 14px; }
      .code-block { overflow-x: auto; margin: 16px 0 0; padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-control); color: var(--ink); background: var(--soft); }
      .code-block code { white-space: pre; font-size: 11px; }
      .code-label { display: flex; align-items: center; justify-content: space-between; margin-top: 20px; color: var(--muted); font: 600 10px var(--mono); text-transform: uppercase; }
      .copyable { padding: 0; border: 0; background: none; cursor: pointer; color: var(--blue); font: inherit; font-weight: 500; }
      .copyable:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; border-radius: 4px; }
      .stats-panel { display: grid; gap: 16px; }
      .stat { padding: 24px; }
      .stat strong { display: block; color: var(--ink); font: 500 28px var(--mono); }
      .stat span { display: block; margin-top: 4px; color: var(--body); font-size: 12px; }
      .section { padding-top: 72px; scroll-margin-top: 90px; }
      .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 24px; }
      .section-heading h2 { margin-top: 10px; font-size: clamp(28px, 4vw, 36px); line-height: 1.15; }
      .section-heading p { max-width: 620px; margin: 10px 0 0; color: var(--body); font-size: 15px; line-height: 1.65; }
      .section-index { color: var(--blue); font: 600 11px var(--mono); letter-spacing: .06em; text-transform: uppercase; }
      .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
      .info-card { padding: 24px; }
      .card-icon { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; color: var(--blue); background: var(--blue-soft); }
      .info-card h3 { margin-top: 18px; font-size: 18px; font-weight: 500; }
      .info-card p { margin: 10px 0 0; color: var(--body); font-size: 13px; line-height: 1.65; }
      .info-card a { display: inline-block; margin-top: 16px; color: var(--blue); font-size: 12px; font-weight: 500; }
      .flow { display: grid; grid-template-columns: repeat(5, 1fr); overflow: hidden; margin-top: 24px; }
      .flow-step { position: relative; min-height: 150px; padding: 20px; border-right: 1px solid var(--line); }
      .flow-step:last-child { border-right: 0; }
      .flow-step strong { color: var(--blue); font: 600 10px var(--mono); }
      .flow-step h3 { margin-top: 18px; font-size: 15px; font-weight: 500; }
      .flow-step p { margin: 8px 0 0; color: var(--body); font-size: 12px; line-height: 1.55; }
      .flow-step:not(:last-child)::after { content: "→"; position: absolute; z-index: 1; top: 48px; right: -8px; color: var(--blue); background: #fff; font-weight: 600; }
      .split { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; align-items: start; }
      .callout { padding: 18px 20px; border-left: 3px solid var(--green); border-radius: 0 var(--radius-control) var(--radius-control) 0; color: var(--body); background: #effaf5; font-size: 13px; line-height: 1.6; }
      .callout strong { color: #08784f; }
      .check-list { display: grid; gap: 10px; margin: 16px 0 0; padding: 0; list-style: none; }
      .check-list li { display: grid; grid-template-columns: 20px 1fr; gap: 8px; color: var(--body); font-size: 13px; }
      .check-list li::before { content: "✓"; color: var(--green-ink); font-weight: 600; }
      .table-wrap { overflow: hidden; }
      .endpoint-card { display: grid; grid-template-columns: 74px minmax(0, 1fr) 1fr; gap: 16px; align-items: center; padding: 18px 20px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; }
      .endpoint-card:last-child { border-bottom: 0; }
      .method { display: inline-block; width: fit-content; padding: 4px 8px; border-radius: 5px; color: var(--green-ink); background: #e8f8f0; font: 600 10px var(--mono); }
      .endpoint-card code { color: var(--ink); font-weight: 500; }
      .endpoint-card span:last-child { color: var(--body); font-size: 12px; }
      .tool-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
      .tool-card { padding: 20px; scroll-margin-top: 90px; }
      .tool-card-top { display: flex; align-items: center; gap: 10px; }
      .tool-number { color: var(--muted); font: 600 10px var(--mono); }
      .tool-name { color: var(--blue); font-size: 12px; font-weight: 600; }
      .tool-badge { margin-left: auto; padding: 4px 8px; border-radius: 100px; color: var(--body); background: var(--soft); font: 500 9px var(--mono); }
      .tool-card p { min-height: 40px; margin: 12px 0 0; color: var(--body); font-size: 12px; line-height: 1.6; }
      .tool-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
      .tool-fields span { margin-right: 2px; color: var(--muted); font: 600 9px var(--mono); text-transform: uppercase; }
      .tool-fields code { padding: 3px 8px; border-radius: 100px; color: var(--ink); background: var(--soft); font-size: 10px; }
      .footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 72px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--body); font-size: 12px; }
      .footer a { color: var(--blue); font-weight: 500; }
      .connector-flow, .settlement-flow { margin-top: 24px; }
      .connector-detail { align-items: stretch; }
      .connector-callout { display: grid; gap: 8px; min-height: 100%; }
      .connector-callout code { width: fit-content; padding: 6px 9px; border-radius: var(--radius-control); color: var(--ink); background: #fff; border: 1px solid var(--line); font-size: 11px; }
      .rail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 20px; }
      .rail-card { display: grid; grid-template-columns: 42px 1fr auto; align-items: start; gap: 14px; padding: 20px; }
      .rail-icon { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 50%; color: var(--blue); background: var(--blue-soft); font-weight: 600; }
      .rail-card h3 { font-size: 16px; font-weight: 500; }
      .rail-card p { margin-top: 6px; color: var(--body); font-size: 12px; line-height: 1.6; }
      .rail-card > code { align-self: center; padding: 6px 9px; border-radius: 100px; color: var(--body); background: var(--soft); font-size: 10px; }
      .use-case-reference { display: grid; gap: 12px; }
      .use-case-detail summary { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 20px; cursor: pointer; list-style: none; }
      .use-case-detail summary::-webkit-details-marker { display: none; }
      .use-case-detail summary:hover { background: var(--soft); }
      .use-case-detail[open] summary { border-bottom: 1px solid var(--line); background: var(--soft); }
      .use-case-detail[open] .use-case-open span { display: inline-block; transform: rotate(180deg); }
      .use-case-summary { display: grid; gap: 4px; min-width: 0; }
      .use-case-summary strong { font-size: 16px; font-weight: 500; }
      .use-case-summary small { overflow: hidden; color: var(--body); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .use-case-open { color: var(--blue); font: 500 11px var(--mono); white-space: nowrap; }
      .use-case-body { padding: 22px 24px 24px; }
      .use-case-description { max-width: 760px; color: var(--body); font-size: 14px; line-height: 1.65; }
      .uml-diagram { overflow: hidden; margin-top: 18px; border: 1px solid var(--line); border-radius: var(--radius-control); background: #fff; }
      .uml-title { display: flex; justify-content: space-between; gap: 14px; padding: 12px 16px; border-bottom: 1px solid var(--line); color: var(--muted); background: var(--soft); font: 600 9px var(--mono); letter-spacing: .07em; }
      .uml-message { display: grid; grid-template-columns: 32px 128px 28px 150px minmax(0, 1fr); align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line-soft); font-size: 11px; }
      .uml-message:last-child { border-bottom: 0; }
      .uml-number { color: var(--blue); font: 500 10px var(--mono); }
      .uml-message strong { font-size: 11px; font-weight: 600; }
      .uml-arrow { color: var(--blue); text-align: center; }
      .uml-message p { min-width: 0; margin: 0; color: var(--body); line-height: 1.5; }
      .use-case-outcome { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px; margin-top: 16px; border-left: 3px solid var(--green); border-radius: 0 var(--radius-control) var(--radius-control) 0; color: var(--body); background: #effaf5; font-size: 12px; }
      @media (max-width: 960px) {
        .layout { display: block; }
        .sidebar { position: static; height: auto; border-right: 0; border-bottom: 1px solid var(--line); }
        /* minmax(0, 1fr) not 1fr: a grid item defaults to min-width auto, so a wide
           code block stretches the track past the viewport and the page scrolls sideways. */
        .hero-grid { grid-template-columns: minmax(0, 1fr); }
        .cards, .split, .tool-grid, .rail-grid { grid-template-columns: minmax(0, 1fr); }
        .flow { grid-template-columns: minmax(0, 1fr); }
        .flow-step { min-height: 0; border-right: 0; border-bottom: 1px solid var(--line); }
        .flow-step:not(:last-child)::after { content: "↓"; top: auto; right: 20px; bottom: -11px; }
        .section-heading { display: block; }
        .topbar { padding: 0 20px; }
        .content { padding: 0 20px 72px; }
      }
      @media (max-width: 640px) {
        .top-links a:not(.network-wrap) { display: none; }
        .endpoint-card { grid-template-columns: 58px 1fr; }
        .endpoint-card span:last-child { grid-column: 2; }
        .uml-message { grid-template-columns: 28px minmax(0, max-content) 20px minmax(0, max-content); }
        .uml-message p { grid-column: 2 / -1; margin-top: 4px; }
      }
      /* docs/dashboard-redesign.md visual contract: 150-200ms transitions, with a
         reduced-motion alternative. Both sibling surfaces already do this. */
      .nav-link, .top-links a, .button, .use-case-detail summary, .copyable {
        transition: background-color .18s ease, border-color .18s ease, color .18s ease;
      }
      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after {
          animation-duration: .01ms !important;
          animation-iteration-count: 1 !important;
          transition-duration: .01ms !important;
          scroll-behavior: auto !important;
        }
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <aside class="sidebar">
        <a class="brand-link" href="#top" aria-label="ChainPay documentation home">${brandLogo}</a>
        <div class="version"><i></i> Solana Devnet · MCP</div>
        <nav aria-label="Documentation navigation">
          <div class="nav-group">
            <div class="nav-label">Start</div>
            ${navLink("#top", NAV_ICONS.overview, "Overview")}
            ${navLink("#quickstart", NAV_ICONS.quickstart, "Quickstart")}
          </div>
          <div class="nav-group">
            <div class="nav-label">Build</div>
            ${navLink("#authentication", NAV_ICONS.auth, "Authorize tools")}
            ${navLink("#agent-payments", NAV_ICONS.payments, "Payments")}
            ${navLink("#x402", NAV_ICONS.x402, "x402 connector")}
            ${navLink("#stablecoin-flow", NAV_ICONS.stablecoin, "Stablecoins")}
          </div>
          <div class="nav-group">
            <div class="nav-label">Learn</div>
            ${navLink("#use-cases", NAV_ICONS.useCases, "Use cases")}
            ${navLink("#spending-limits", NAV_ICONS.policy, "Spending limits")}
            ${navLink("#assets", NAV_ICONS.assets, "Assets")}
          </div>
          <div class="nav-group">
            <div class="nav-label">Reference</div>
            ${navLink("#tool-reference", NAV_ICONS.tools, "Tools")}
            ${navLink("#mcp-protocol", NAV_ICONS.protocol, "MCP protocol")}
            ${navLink("#endpoints", NAV_ICONS.endpoints, "HTTP routes")}
          </div>
        </nav>
        <div class="sidebar-foot">Your wallet holds the funds. The spending permission sets the boundary. <a href="${escapeHtml(PRODUCT_APP_URL)}">Open dashboard</a></div>
      </aside>

      <main class="main" id="top">
        <header class="topbar">
          <div class="breadcrumbs"><strong>ChainPay</strong> <span>/</span> MCP docs</div>
          <div class="top-links">
            <a href="${escapeHtml(PRODUCT_APP_URL)}">Dashboard</a>
            <a href="/tools">Tools</a>
            <a href="/healthz">Health</a>
            <span class="network-wrap"><span class="network"><i></i> Solana Devnet</span></span>
          </div>
        </header>

        <div class="content">
          <section class="hero" aria-labelledby="hero-title">
            <p class="eyebrow">Agent payments · Solana Devnet</p>
            <h1 id="hero-title">Connect an agent. <em>Keep the limits.</em></h1>
            <p class="hero-copy">Your wallet holds the funds. MCP gives the agent tools to inspect a spending permission, prepare a payment, and read the receipt. The on-chain program enforces the rules.</p>
            <div class="hero-actions">
              <a class="button button-primary" href="#quickstart">Copy the MCP address</a>
              <a class="button button-quiet" href="#tool-reference">Browse tools</a>
            </div>
            <div class="endpoint-pill"><span>MCP endpoint</span><code data-endpoint>/mcp</code></div>
            <div class="asset-strip" aria-label="Supported network and tokens">${renderAssetStrip()}</div>
          </section>

          <section class="hero-grid" id="quickstart" aria-labelledby="quickstart-title">
            <div class="hero-panel">
              <span class="panel-kicker">1 · Connect</span>
              <h2 id="quickstart-title">Start with a read-only result.</h2>
              <p>Replace YOUR_MCP_HOST with this server. Paste the config, list tools, then read protocol config. No token. No wallet. No money moves.</p>
              ${renderCode(connectionConfig)}
              <div class="code-label"><span>Client config</span><button type="button" class="copyable" data-copy="config" aria-label="Copy the client configuration">Copy</button></div>
              <div class="prompt-example"><span class="code-label"><span>Read-only prompt</span><button type="button" class="copyable" data-copy="prompt" aria-label="Copy the read-only prompt">Copy</button></span>${renderCode(demoPrompt)}</div>
            </div>
            <div class="stats-panel">
              <div class="stat"><strong>${TOOL_DEFINITIONS.length}</strong><span>MCP tools exposed</span></div>
              <div class="stat"><strong>2</strong><span>token programs supported</span></div>
              <div class="stat"><strong>0</strong><span>private keys held by MCP</span></div>
            </div>
          </section>

          <section class="section" id="authentication" aria-labelledby="authentication-title">
            <div class="section-heading"><div><h2 id="authentication-title">A wallet address is not a login.</h2><p>Sign the dashboard wallet-message challenge. Create a connection for your mandates and tools. Copy its one-time token into <code>headers.Authorization</code> as <code>Bearer YOUR_SCOPED_CONNECTION_TOKEN</code>. Never put credentials in a prompt or commit them.</p></div></div>
            <div class="callout"><strong>First private read:</strong> select <code>get_mandate</code> when creating the connection, then call it with <code>{"address":"YOUR_MANDATE_PDA"}</code>. Wrong mandate or unselected tool = rejected. Owner tools need an owner session. Login does not authorize spending.</div>
            <p style="margin-top:16px;color:var(--body);font-size:14px;line-height:1.65">For stdio, build <code>mcp-server/dist/server.js</code>. Private calls need <code>CHAINPAY_BACKEND_URL</code> and <code>CHAINPAY_CALLER_TOKEN</code>. Full guide: <code>docs/guides/connect-an-agent.md</code> in the repo.</p>
          </section>

          <section class="section" id="agent-payments" aria-labelledby="payments-title">
            <div class="section-heading"><div><span class="section-index">2 · Payments</span><h2 id="payments-title">Inspect. Quote. Prepare. Sign. Receipt.</h2><p>Check requirements first. Review exact fields. Use an authorized signer before submission. A quote is advisory — the program enforces the spending permission.</p></div></div>
            <div class="flow">
              <div class="flow-step"><strong>01</strong><h3>Inspect</h3><p>Read the mandate, protocol config, and asset registry.</p></div>
              <div class="flow-step"><strong>02</strong><h3>Quote</h3><p>Ask for a policy result without signing or submitting.</p></div>
              <div class="flow-step"><strong>03</strong><h3>Prepare</h3><p>Build a mandate-checked transaction plan.</p></div>
              <div class="flow-step"><strong>04</strong><h3>Sign</h3><p>Human wallet or delegated signer through Axum.</p></div>
              <div class="flow-step"><strong>05</strong><h3>Receipt</h3><p>Wait for status and fetch durable proof.</p></div>
            </div>
            <div class="split" style="margin-top: 20px">
              <div>${renderCode(quoteExample)}</div>
              <div class="callout"><strong>Safe default:</strong> use <code>quote_payment</code> while deciding. It returns the preflight result. It does not sign, submit, or move funds.</div>
            </div>
          </section>

          <section class="section" id="x402" aria-labelledby="x402-title">
            <div class="section-heading"><div><span class="section-index">3 · x402</span><h2 id="x402-title">Custom x402/1.0 can settle. Standard v2 is recognized and stopped.</h2><p>HTTP 402 from a merchant becomes a mandate-checked payment on the custom receipt-proof rail. Standard x402 v2 exact SVM returns <code>x402_unsupported_sponsor</code> before any wallet or settlement work.</p></div></div>
            <div class="flow connector-flow">
              <div class="flow-step"><strong>01</strong><h3>Challenge</h3><p>Custom <code>x402/1.0</code> uses <code>network: solana-devnet</code> and <code>payTo</code> as a recipient token account.</p></div>
              <div class="flow-step"><strong>02</strong><h3>Detect</h3><p>Protocol version or network must be explicit. Amounts are canonical decimal u64 strings.</p></div>
              <div class="flow-step"><strong>03</strong><h3>Preflight</h3><p>Only the custom rail continues. Mandate, mint, limits, and expiry are checked.</p></div>
              <div class="flow-step"><strong>04</strong><h3>Sign</h3><p>External wallet or delegated signer. MCP never receives a seed phrase.</p></div>
              <div class="flow-step"><strong>05</strong><h3>Proof</h3><p>Retry the resource with signature plus receipt PDA. Resume with <code>paymentId</code> for delivery only.</p></div>
            </div>
            <div class="split connector-detail" style="margin-top: 20px">
              <div class="info-card"><div class="card-icon">${NAV_ICONS.x402}</div><h3>How agents use it</h3><p>Call <code>execute_x402_payment</code> with <code>resource</code>, <code>mandate</code>, <code>agent</code>, and explicit <code>signingMode</code>. Human mode returns an unsigned transaction. Delegated mode uses Axum's mandate-bound signer.</p></div>
              <div class="callout connector-callout"><strong>Boundary</strong><span>Custom x402/1.0 does not bypass ChainPay limits.</span><span>Human mode relays a wallet-signed transaction.</span><span>Delegated mode uses Axum's managed signer.</span><span>Not a key custodian or standard x402 sponsor.</span></div>
            </div>
          </section>

          <section class="section" id="stablecoin-flow" aria-labelledby="stablecoin-title">
            <div class="section-heading"><div><span class="section-index">4 · Stablecoins</span><h2 id="stablecoin-title">One spending permission for every supported token.</h2><p>USDC and PYUSD on Devnet use the same mandate and receipt model. Classic SPL Token and Token-2022 both work when the asset registry and capability scan allow it.</p></div></div>
            <div class="flow settlement-flow">
              <div class="flow-step"><strong>01</strong><h3>Choose rail</h3><p>Set the mint and pick <code>spl-token</code> or <code>token-2022</code>.</p></div>
              <div class="flow-step"><strong>02</strong><h3>Set limits</h3><p>Bind source account, agent, per-payment and total limits.</p></div>
              <div class="flow-step"><strong>03</strong><h3>Quote</h3><p>Use <code>quote_payment</code> or <code>prepare_payment</code> before any signature.</p></div>
              <div class="flow-step"><strong>04</strong><h3>Transfer</h3><p>The program enforces the mandate on Solana.</p></div>
              <div class="flow-step"><strong>05</strong><h3>Reconcile</h3><p>Read the receipt PDA and backend status.</p></div>
            </div>
            <div class="rail-grid">
              <div class="rail-card"><span class="rail-icon">$</span><div><h3>Classic SPL Token</h3><p>Standard SPL stablecoins. Mint and token accounts must belong to the classic Token program.</p></div><code>spl-token</code></div>
              <div class="rail-card"><span class="rail-icon card-icon">${NAV_ICONS.assets}</span><div><h3>Token-2022</h3><p>Enabled registry mints only. Unsupported extensions fail closed.</p></div><code>token-2022</code></div>
            </div>
          </section>

          <section class="section" id="use-cases" aria-labelledby="use-cases-title">
            <div class="section-heading"><div><span class="section-index">5 · Use cases</span><h2 id="use-cases-title">Three flows to learn first.</h2><p>These match the implemented interfaces. You still need a deployed server, registered Devnet asset, wallet, and any required provider to run them live.</p></div></div>
            <div class="use-case-reference">${renderUseCaseReference()}</div>
          </section>

          <section class="section" id="spending-limits" aria-labelledby="limits-title">
            <div class="section-heading"><div><span class="section-index">6 · Spending limits</span><h2 id="limits-title">The spending permission is the boundary.</h2><p>An owner-approved mandate becomes a narrow spending rule enforced on-chain.</p></div></div>
            <div class="cards">
              <article class="info-card"><div class="card-icon">${NAV_ICONS.bot}</div><h3>Who can spend</h3><p>Bind one approved agent public key. Owner updates, pauses, and revocation stay wallet-signed.</p><a href="#tool-create-mandate">create_mandate →</a></article>
              <article class="info-card"><div class="card-icon">${NAV_ICONS.shield}</div><h3>Where funds go</h3><p>Lock the mint. Each payment supplies one destination. Transfer settles only there.</p><a href="#tool-prepare-payment">prepare_payment →</a></article>
              <article class="info-card"><div class="card-icon">${NAV_ICONS.payments}</div><h3>How much</h3><p>Per-payment and total limits, expiry, payment count, and cooldown slots.</p><a href="#tool-update-mandate">update_mandate →</a></article>
            </div>
          </section>

          <section class="section" id="assets" aria-labelledby="assets-title">
            <div class="section-heading"><div><span class="section-index">7 · Assets</span><h2 id="assets-title">SPL-compatible by design.</h2><p>Classic SPL Token and Token-2022 settlement with explicit program selection so an agent cannot mix account types.</p></div></div>
            <div class="asset-strip" style="margin-top:0;border-top:0">${renderAssetStrip()}</div>
            <div class="split" style="margin-top:20px">
              <div class="info-card"><div class="card-icon"><img class="asset-mark" src="/assets/brands/usdc.svg" alt="" width="28" height="28" /></div><h3>Classic SPL Token</h3><p>Set <code>tokenProgram</code> to <code>spl-token</code>. Mint, source, and destination must match the classic program.</p><a href="#tool-get-asset">Inspect an asset →</a></div>
              <div class="info-card"><div class="card-icon">${NAV_ICONS.assets}</div><h3>Token-2022</h3><p>Register a Token-2022 mint. ChainPay scans live extensions before every prepared payment. Unsupported transfer behavior is rejected.</p><a href="#tool-get-protocol-config">Read protocol config →</a></div>
            </div>
            <div class="callout" style="margin-top: 16px"><strong>Important:</strong> amounts are unsigned base units. The protocol validates mint and token program before settlement.</div>
          </section>

          <section class="section" id="tool-reference" aria-labelledby="tools-title">
            <div class="section-heading"><div><span class="section-index">8 · Tools</span><h2 id="tools-title">Same catalog as <code>tools/list</code>.</h2><p>Generated from live definitions. Required fields shown for orchestration.</p></div><a class="button button-quiet" href="/tools">Open JSON catalog</a></div>
            <div class="tool-grid">${renderToolReference()}</div>
          </section>

          <section class="section" id="mcp-protocol" aria-labelledby="mcp-protocol-title">
            <div class="section-heading"><div><span class="section-index">9 · MCP protocol</span><h2 id="mcp-protocol-title">Tested subset, not blanket conformance.</h2><p>Dual-era JSON-RPC verified against the <a href="https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts">2026-07-28 schema</a>. Wallet sessions are app auth, not MCP OAuth.</p></div></div>
            <div class="callout"><strong>Supported now:</strong> <code>server/discover</code>, <code>tools/list</code>, and <code>tools/call</code> on <code>2026-07-28</code> without initialize; legacy <code>2025-06-18</code> and <code>2024-11-05</code>; public discovery vs private owner tools on HTTP and stdio. GET/DELETE on <code>/mcp</code> returns 405 for current version. Capability metadata never authorizes a wallet.</div>
          </section>

          <section class="section" id="endpoints" aria-labelledby="endpoints-title">
            <div class="section-heading"><div><span class="section-index">10 · HTTP</span><h2 id="endpoints-title">Small surface area.</h2><p>Use <code>/mcp</code> for agents. Use the read-only routes for humans and health checks.</p></div></div>
            <div class="table-wrap">
              <a class="endpoint-card" href="/"><span class="method">GET</span><code>/</code><span>Documentation</span></a>
              <a class="endpoint-card" href="/mcp"><span class="method">POST</span><code>/mcp</code><span>Streamable HTTP JSON-RPC MCP transport</span></a>
              <a class="endpoint-card" href="/tools"><span class="method">GET</span><code>/tools</code><span>Read-only tool definitions and input schemas</span></a>
              <a class="endpoint-card" href="/healthz"><span class="method">GET</span><code>/healthz</code><span>Service health</span></a>
              <a class="endpoint-card" href="/logo.svg"><span class="method">GET</span><code>/logo.svg</code><span>ChainPay wordmark</span></a>
              <a class="endpoint-card" href="/brand/chainpay-icon.svg"><span class="method">GET</span><code>/brand/chainpay-icon.svg</code><span>App icon tile</span></a>
              <a class="endpoint-card" href="/og-image.png"><span class="method">GET</span><code>/og-image.png</code><span>Social preview image</span></a>
            </div>
          </section>

          <footer class="footer"><span>ChainPay MCP · Solana Devnet</span><span><a href="${escapeHtml(PRODUCT_APP_URL)}">Dashboard</a> · <a href="/mcp">Connect</a> · <a href="/tools">Tools</a> · <a href="/healthz">Status</a></span></footer>
        </div>
      </main>
    </div>
    <script>
      const endpoint = window.location.origin + "/mcp";
      document.querySelectorAll("[data-endpoint]").forEach((element) => { element.textContent = endpoint; });
      document.querySelectorAll("[data-copy]").forEach((element) => {
        element.addEventListener("click", async () => {
          const value = element.dataset.copy === "prompt"
            ? ${JSON.stringify(demoPrompt)}
            : ${JSON.stringify(connectionConfig)}.replace("https://YOUR_MCP_HOST", window.location.origin);
          if (!navigator.clipboard) {
            element.textContent = "Copy manually";
            window.setTimeout(() => { element.textContent = "Copy"; }, 1800);
            return;
          }
          try {
            await navigator.clipboard.writeText(value);
            element.textContent = "Copied";
          } catch {
            element.textContent = "Copy failed";
          }
          window.setTimeout(() => { element.textContent = "Copy"; }, 1400);
        });
      });
      const navLinks = [...document.querySelectorAll(".nav-link")];
      const sections = navLinks.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          navLinks.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === "#" + entry.target.id || (entry.target.id === "top" && link.getAttribute("href") === "#top")));
        });
      }, { rootMargin: "-30% 0px -60% 0px", threshold: 0 });
      sections.forEach((section) => observer.observe(section));
      document.querySelector('.nav-link[href="#top"]')?.classList.add("active");
    </script>
  </body>
</html>`;
}
