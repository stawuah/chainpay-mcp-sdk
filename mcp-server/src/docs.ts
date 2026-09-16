import { CHAINPAY_LOGO_SVG } from "./logo.js";
import { TOOL_DEFINITIONS } from "./tools/definitions.js";

type ToolDefinition = (typeof TOOL_DEFINITIONS)[number];

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

  const pageLogo = CHAINPAY_LOGO_SVG.replace('<svg ', '<svg class="brand-logo" ');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0a0b0d" />
    <meta name="description" content="Spending limits and payment receipts for AI agents. ChainPay enforces owner-approved spending limits on Solana Devnet and records payment receipts." />
    <link rel="icon" href="/logo.svg" type="image/svg+xml" />
    <link rel="canonical" href="https://chainpay-mcp.onrender.com/docs" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="ChainPay" />
    <meta property="og:url" content="https://chainpay-mcp.onrender.com/docs" />
    <meta property="og:title" content="Spending limits and payment receipts for AI agents." />
    <meta property="og:description" content="Read mandates, prepare authorized payments, and verify receipts on Solana Devnet." />
    <meta property="og:image" content="https://chainpay-mcp.onrender.com/og-image.png" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="https://chainpay-mcp.onrender.com/og-image.png" />
    <meta name="twitter:title" content="Spending limits and payment receipts for AI agents." />
    <meta name="twitter:description" content="Read mandates, prepare authorized payments, and verify receipts on Solana Devnet." />
    <title>Spending limits and payment receipts for AI agents. · ChainPay</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
      :root {
        color-scheme: light;
        --ink: #0b1020;
        --ink-soft: #31394d;
        --muted: #697287;
        --subtle: #8d96a9;
        --line: #e8ebf1;
        --surface: #ffffff;
        --canvas: #f7f8fb;
        --blue: #5e72ee;
        --blue-soft: #eef0ff;
        --purple: #9945ff;
        --green: #14f195;
        --sidebar: 264px;
        --shadow: 0 20px 60px rgba(21, 31, 63, .07);
      }
      * { box-sizing: border-box; }
      html { scroll-behavior: smooth; }
      body { margin: 0; color: var(--ink); background: var(--canvas); font: 14px/1.6 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      a { color: inherit; text-decoration: none; }
      code, pre { font: 12px/1.65 "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
      .layout { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); min-height: 100vh; }
      .sidebar { position: sticky; top: 0; height: 100vh; overflow-y: auto; padding: 27px 18px 24px; border-right: 1px solid var(--line); background: var(--surface); }
      .brand-link { display: block; padding: 0 13px 30px; }
      .brand-logo { display: block; width: 184px; height: auto; }
      .version { display: inline-flex; align-items: center; gap: 7px; margin: 0 13px 28px; padding: 5px 9px; border: 1px solid #dfe3ec; border-radius: 999px; color: var(--ink-soft); background: #fafbfe; font: 600 10px/1 "SFMono-Regular", Consolas, monospace; }
      .version i { width: 6px; height: 6px; border-radius: 50%; background: var(--green); box-shadow: 0 0 0 3px rgba(20, 241, 149, .15); }
      .nav-group { margin-top: 25px; }
      .nav-label { padding: 0 13px 8px; color: #a0a8b8; font: 700 10px/1.2 "SFMono-Regular", Consolas, monospace; letter-spacing: .11em; text-transform: uppercase; }
      .nav-link { display: flex; align-items: center; gap: 9px; padding: 8px 13px; border-radius: 7px; color: var(--muted); font-size: 12px; }
      .nav-link:hover, .nav-link.active { color: var(--ink); background: var(--blue-soft); }
      .nav-link.active { font-weight: 700; }
      .nav-link span { width: 15px; color: var(--blue); text-align: center; font-size: 13px; }
      .sidebar-foot { margin: 40px 13px 0; padding-top: 17px; border-top: 1px solid var(--line); color: var(--subtle); font-size: 11px; }
      .sidebar-foot a { color: var(--blue); font-weight: 700; }
      .main { min-width: 0; }
      .topbar { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 67px; padding: 0 6vw; border-bottom: 1px solid var(--line); background: rgba(255,255,255,.82); backdrop-filter: blur(14px); }
      .breadcrumbs { color: var(--muted); font-size: 12px; }
      .breadcrumbs strong { color: var(--ink); }
      .top-links { display: flex; align-items: center; gap: 17px; color: var(--muted); font-size: 12px; }
      .top-links a:hover { color: var(--blue); }
      .network { display: inline-flex; align-items: center; gap: 7px; padding: 7px 10px; border: 1px solid #dfe3ec; border-radius: 7px; color: var(--ink-soft); background: white; font: 600 10px "SFMono-Regular", Consolas, monospace; }
      .network i { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }
      .content { width: min(1100px, calc(100% - 12vw)); margin: 0 auto; padding: 73px 0 110px; }
      .eyebrow { display: inline-flex; align-items: center; gap: 9px; color: var(--blue); font: 700 11px "SFMono-Regular", Consolas, monospace; letter-spacing: .09em; text-transform: uppercase; }
      .eyebrow i { width: 7px; height: 7px; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 4px var(--blue-soft); }
      h1, h2, h3 { margin: 0; letter-spacing: -.045em; }
      h1 { max-width: 820px; margin-top: 20px; font-size: clamp(40px, 5vw, 69px); line-height: 1.02; font-weight: 750; }
      h1 em { color: var(--blue); font-style: normal; }
      .hero-copy { max-width: 650px; margin-top: 22px; color: var(--muted); font-size: 17px; line-height: 1.75; }
      .hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 11px; margin-top: 29px; }
      .button { display: inline-flex; align-items: center; gap: 9px; padding: 11px 15px; border-radius: 7px; font-size: 12px; font-weight: 750; }
      .button-primary { color: white; background: var(--ink); box-shadow: 0 9px 20px rgba(11,16,32,.14); }
      .button-primary:hover { background: #1f2a4a; }
      .button-quiet { border: 1px solid var(--line); color: var(--ink-soft); background: white; }
      .button-quiet:hover { border-color: #cbd2e0; }
      .endpoint-pill { display: inline-flex; align-items: center; gap: 8px; margin-top: 18px; padding: 8px 10px; border: 1px solid #dfe3ec; border-radius: 7px; color: var(--muted); background: white; }
      .endpoint-pill code { color: var(--blue); }
      .endpoint-pill span { color: var(--subtle); font-size: 11px; }
      .hero-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(280px, .7fr); gap: 23px; align-items: stretch; margin-top: 58px; }
      .hero-grid > * { min-width: 0; }
      .hero-panel, .info-card, .tool-card, .endpoint-card { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); box-shadow: var(--shadow); }
      .hero-panel { padding: 25px; }
      .panel-kicker { color: var(--subtle); font: 700 10px "SFMono-Regular", Consolas, monospace; letter-spacing: .09em; text-transform: uppercase; }
      .hero-panel h2 { margin-top: 12px; font-size: 24px; }
      .hero-panel p { margin: 10px 0 0; color: var(--muted); }
      .code-block { overflow-x: auto; margin: 18px 0 0; padding: 17px; border: 1px solid #202a44; border-radius: 8px; color: #dbe4ff; background: #0b1020; }
      .code-block code { white-space: pre; }
      .code-label { display: flex; align-items: center; justify-content: space-between; margin-top: 23px; color: var(--subtle); font: 700 10px "SFMono-Regular", Consolas, monospace; text-transform: uppercase; }
      .copyable { cursor: pointer; color: var(--blue); }
      .stats-panel { display: grid; gap: 12px; }
      .stat { padding: 19px; border: 1px solid var(--line); border-radius: 12px; background: white; }
      .stat strong { display: block; color: var(--ink); font-size: 25px; letter-spacing: -.04em; }
      .stat span { display: block; margin-top: 3px; color: var(--muted); font-size: 11px; }
      .section { padding-top: 112px; scroll-margin-top: 25px; }
      .section-heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 25px; }
      .section-heading h2 { margin-top: 10px; font-size: 34px; }
      .section-heading p { max-width: 560px; margin: 10px 0 0; color: var(--muted); }
      .section-index { color: var(--blue); font: 700 11px "SFMono-Regular", Consolas, monospace; }
      .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
      .info-card { padding: 21px; box-shadow: none; }
      .card-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; color: var(--blue); background: var(--blue-soft); font-size: 16px; font-weight: 800; }
      .info-card h3 { margin-top: 18px; font-size: 17px; }
      .info-card p { margin: 9px 0 0; color: var(--muted); font-size: 12px; line-height: 1.7; }
      .info-card a { display: inline-block; margin-top: 16px; color: var(--blue); font-size: 11px; font-weight: 750; }
      .flow { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0; margin-top: 28px; border: 1px solid var(--line); border-radius: 12px; background: white; overflow: hidden; }
      .flow-step { position: relative; min-height: 145px; padding: 18px; border-right: 1px solid var(--line); }
      .flow-step:last-child { border-right: 0; }
      .flow-step strong { display: block; color: var(--blue); font: 700 10px "SFMono-Regular", Consolas, monospace; }
      .flow-step h3 { margin-top: 20px; font-size: 14px; }
      .flow-step p { margin: 6px 0 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
      .flow-step:not(:last-child)::after { content: "→"; position: absolute; z-index: 1; top: 51px; right: -8px; color: var(--blue); background: white; font-weight: 800; }
      .split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
      .callout { padding: 20px; border-left: 3px solid var(--green); border-radius: 0 9px 9px 0; color: var(--ink-soft); background: #effdf7; }
      .callout strong { color: #08784f; }
      .check-list { display: grid; gap: 11px; margin: 20px 0 0; padding: 0; list-style: none; }
      .check-list li { display: grid; grid-template-columns: 20px 1fr; gap: 8px; color: var(--muted); font-size: 12px; }
      .check-list li::before { content: "✓"; color: #08784f; font-weight: 800; }
      .table-wrap { overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: white; }
      .endpoint-card { display: grid; grid-template-columns: 74px minmax(0, 1fr) 1fr; gap: 17px; align-items: center; padding: 17px 20px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; box-shadow: none; }
      .endpoint-card:last-child { border-bottom: 0; }
      .method { display: inline-block; width: fit-content; padding: 4px 7px; border-radius: 5px; color: #08784f; background: #e7fbf2; font: 700 10px "SFMono-Regular", Consolas, monospace; }
      .endpoint-card code { color: var(--ink); font-weight: 700; }
      .endpoint-card span:last-child { color: var(--muted); font-size: 11px; }
      .tool-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
      .tool-card { padding: 17px 18px; box-shadow: none; scroll-margin-top: 25px; }
      .tool-card-top { display: flex; align-items: center; gap: 10px; }
      .tool-number { color: var(--subtle); font: 700 10px "SFMono-Regular", Consolas, monospace; }
      .tool-name { color: var(--blue); font-size: 12px; font-weight: 700; }
      .tool-badge { margin-left: auto; padding: 4px 6px; border-radius: 4px; color: var(--subtle); background: #f5f6f9; font: 700 9px "SFMono-Regular", Consolas, monospace; }
      .tool-card p { min-height: 42px; margin: 13px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
      .tool-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 14px; padding-top: 12px; border-top: 1px solid #f0f1f5; }
      .tool-fields span { margin-right: 2px; color: var(--subtle); font: 700 9px "SFMono-Regular", Consolas, monospace; text-transform: uppercase; }
      .tool-fields code { padding: 3px 5px; border-radius: 4px; color: var(--ink-soft); background: #f5f6f9; font-size: 10px; }
      .footer { display: flex; justify-content: space-between; gap: 20px; margin-top: 110px; padding-top: 23px; border-top: 1px solid var(--line); color: var(--subtle); font-size: 11px; }
      .footer a { color: var(--blue); }
      @media (max-width: 1050px) {
        :root { --sidebar: 228px; }
        .hero-grid { grid-template-columns: 1fr; }
        .stats-panel { grid-template-columns: repeat(3, 1fr); }
      }
      @media (max-width: 800px) {
        .layout { display: block; }
        .sidebar { position: static; height: auto; padding: 17px 18px; border-right: 0; border-bottom: 1px solid var(--line); }
        .brand-link { display: inline-block; padding: 0 0 13px; }
        .brand-logo { width: 170px; }
        .version, .nav-group, .sidebar-foot { display: none; }
        .sidebar::after { content: "ChainPay MCP docs · Devnet"; float: right; margin-top: 13px; color: var(--subtle); font: 10px "SFMono-Regular", Consolas, monospace; }
        .topbar { padding: 0 18px; }
        .top-links a { display: none; }
        .content { width: min(100% - 36px, 660px); padding-top: 55px; }
        .cards, .split, .tool-grid { grid-template-columns: 1fr; }
        .flow { grid-template-columns: 1fr; }
        .flow-step { min-height: 0; border-right: 0; border-bottom: 1px solid var(--line); }
        .flow-step:last-child { border-bottom: 0; }
        .flow-step:not(:last-child)::after { content: "↓"; top: auto; right: 18px; bottom: -11px; }
        .section-heading { display: block; }
        .section-index { display: block; margin-bottom: 9px; }
        .stats-panel { grid-template-columns: 1fr; }
        .endpoint-card { grid-template-columns: 60px 1fr; }
        .endpoint-card span:last-child { grid-column: 2; }
        .footer { display: block; }
        .footer span { display: block; margin-top: 7px; }
      }
      /* Coinbase-inspired editorial layer: white canvas, one blue, quiet depth. */
      :root {
        --ink: #0a0b0d;
        --ink-soft: #30343a;
        --muted: #5b616e;
        --subtle: #7c828a;
        --line: #dee1e6;
        --line-soft: #eef0f3;
        --surface: #ffffff;
        --canvas: #ffffff;
        --soft: #f7f7f7;
        --strong: #eef0f3;
        --blue: #0052ff;
        --blue-active: #003ecc;
        --blue-soft: #eaf0ff;
        --green: #05b169;
        --dark: #0a0b0d;
        --dark-elevated: #16181c;
        --sidebar: 256px;
        --shadow: 0 4px 12px rgba(0, 0, 0, .04);
        --mono: "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
      }
      body { color: var(--ink); background: var(--canvas); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      code, pre { font-family: var(--mono); }
      .layout { grid-template-columns: var(--sidebar) minmax(0, 1fr); }
      .sidebar { padding: 28px 18px 24px; border-right: 1px solid var(--line); background: #fff; }
      .brand-link { padding: 0 12px 31px; }
      .brand-logo { width: 178px; }
      .version { margin: 0 12px 28px; padding: 7px 11px; border-color: var(--line); border-radius: 100px; color: var(--ink); background: var(--soft); font-family: var(--mono); }
      .version i { background: var(--green); box-shadow: 0 0 0 3px rgba(5, 177, 105, .14); }
      .nav-group { margin-top: 27px; }
      .nav-label { padding-inline: 12px; color: var(--subtle); font-family: var(--mono); letter-spacing: .08em; }
      .nav-link { padding: 10px 12px; border-radius: 14px; color: var(--muted); font-size: 13px; }
      .nav-link:hover, .nav-link.active { color: var(--ink); background: var(--soft); }
      .nav-link.active { color: var(--blue); }
      .nav-link span { color: var(--blue); }
      .sidebar-foot { margin: 42px 12px 0; border-color: var(--line); color: var(--subtle); }
      .sidebar-foot a { color: var(--blue); }
      .topbar { min-height: 64px; padding: 0 48px; border-bottom-color: var(--line); background: #fff; }
      .breadcrumbs { color: var(--muted); font-size: 13px; }
      .breadcrumbs strong { color: var(--ink); }
      .top-links { gap: 20px; color: var(--muted); font-size: 13px; }
      .top-links a:hover { color: var(--blue); }
      .network { padding: 9px 13px; border-color: var(--line); border-radius: 100px; color: var(--ink); background: #fff; font-family: var(--mono); }
      .network i { background: var(--green); }
      .content { width: 100%; margin: 0; padding: 0 0 112px; }
      .hero { padding: 96px max(48px, calc((100% - 1100px) / 2)); color: #fff; background: var(--dark); }
      .eyebrow { color: #fff; font-family: var(--mono); }
      .eyebrow i { background: var(--green); box-shadow: 0 0 0 4px rgba(5, 177, 105, .14); }
      h1, h2, h3 { letter-spacing: -1px; }
      h1 { max-width: 850px; margin-top: 22px; color: #fff; font-size: clamp(48px, 6vw, 80px); font-weight: 400; line-height: 1; }
      h1 em { color: var(--blue); }
      .hero-copy { max-width: 680px; margin-top: 24px; color: #a8acb3; font-size: 17px; line-height: 1.65; }
      .hero-actions { gap: 17px; margin-top: 32px; }
      .button { min-height: 44px; padding: 12px 20px; border-radius: 100px; font-size: 15px; font-weight: 600; }
      .button-primary { color: #fff; background: var(--blue); box-shadow: none; }
      .button-primary:hover { background: var(--blue-active); }
      .button-quiet { border-color: #42464c; color: #fff; background: transparent; }
      .button-quiet:hover { border-color: #fff; background: var(--dark-elevated); }
      .endpoint-pill { margin-top: 21px; padding: 9px 13px; border-color: #42464c; border-radius: 100px; color: #a8acb3; background: transparent; }
      .endpoint-pill code { color: #fff; }
      .hero-grid { width: min(1100px, calc(100% - 96px)); margin: 0 auto; grid-template-columns: minmax(0, 1.3fr) minmax(260px, .7fr); gap: 24px; padding-top: 40px; }
      .hero-panel, .info-card, .tool-card, .endpoint-card { border-color: var(--line); border-radius: 24px; background: #fff; box-shadow: var(--shadow); }
      .hero-panel { padding: 32px; }
      .panel-kicker, .code-label, .section-index, .tool-number, .method { font-family: var(--mono); }
      .panel-kicker { color: var(--subtle); }
      .hero-panel h2 { margin-top: 13px; font-size: 26px; font-weight: 400; }
      .hero-panel p { margin-top: 11px; color: var(--muted); }
      .code-block { margin-top: 20px; padding: 20px; border: 1px solid #2c3035; border-radius: 16px; color: #e8ebef; background: var(--dark); }
      .code-block code { font-size: 11px; }
      .code-label { margin-top: 24px; color: var(--subtle); }
      .copyable { color: var(--blue); }
      .stats-panel { gap: 16px; }
      .stat { padding: 24px; border-color: var(--line); border-radius: 24px; background: #fff; }
      .stat strong { color: var(--ink); font: 500 28px var(--mono); }
      .stat span { color: var(--muted); font-size: 12px; }
      .section { width: min(1100px, calc(100% - 96px)); margin-inline: auto; padding-top: 112px; }
      .section-heading { margin-bottom: 28px; }
      .section-heading h2 { margin-top: 12px; font-size: clamp(34px, 4vw, 48px); font-weight: 400; line-height: 1.05; }
      .section-heading p { max-width: 620px; margin-top: 13px; color: var(--muted); font-size: 16px; line-height: 1.65; }
      .section-index { color: var(--blue); font-size: 11px; }
      .cards { gap: 20px; }
      .info-card { padding: 32px; box-shadow: none; }
      .card-icon { width: 40px; height: 40px; border-radius: 50%; color: var(--blue); background: var(--blue-soft); }
      .info-card h3 { margin-top: 20px; font-size: 19px; font-weight: 600; }
      .info-card p { margin-top: 10px; color: var(--muted); font-size: 13px; line-height: 1.7; }
      .info-card a { margin-top: 19px; color: var(--blue); font-size: 12px; }
      .flow { margin-top: 28px; border-color: var(--line); border-radius: 24px; box-shadow: var(--shadow); }
      .flow-step { min-height: 160px; padding: 24px; border-color: var(--line); }
      .flow-step strong { color: var(--blue); font-family: var(--mono); }
      .flow-step h3 { margin-top: 25px; font-size: 16px; font-weight: 600; }
      .flow-step p { color: var(--muted); font-size: 12px; }
      .flow-step:not(:last-child)::after { color: var(--blue); }
      .split { gap: 20px; }
      .callout { padding: 22px; border-left: 3px solid var(--green); border-radius: 0 16px 16px 0; color: var(--ink-soft); background: #effaf5; }
      .callout strong { color: #08784f; }
      .check-list { gap: 12px; margin-top: 22px; }
      .check-list li { color: var(--muted); }
      .check-list li::before { color: var(--green); }
      .table-wrap { border-color: var(--line); border-radius: 24px; box-shadow: var(--shadow); }
      .endpoint-card { padding: 19px 24px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; box-shadow: none; }
      .method { padding: 5px 8px; border-radius: 100px; color: var(--green); background: #e8f8f0; }
      .endpoint-card code { font-weight: 500; }
      .tool-grid { gap: 16px; }
      .tool-card { padding: 22px; box-shadow: none; }
      .tool-name { color: var(--blue); font-family: var(--mono); }
      .tool-badge { padding: 5px 8px; border-radius: 100px; color: var(--muted); background: var(--strong); font-family: var(--mono); }
      .tool-card p { color: var(--muted); }
      .tool-fields { border-color: var(--line-soft); }
      .tool-fields code { border-radius: 100px; color: var(--ink-soft); background: var(--strong); }
      .footer { width: min(1100px, calc(100% - 96px)); margin: 112px auto 0; border-color: var(--line); color: var(--subtle); }
      .footer a { color: var(--blue); }
      @media (max-width: 1050px) {
        :root { --sidebar: 228px; }
        .hero-grid { grid-template-columns: 1fr; }
        .stats-panel { grid-template-columns: repeat(3, 1fr); }
      }
      @media (max-width: 800px) {
        .layout { display: block; }
        .sidebar { position: static; height: auto; padding: 18px; border-right: 0; border-bottom: 1px solid var(--line); }
        .brand-link { display: inline-block; padding: 0 0 14px; }
        .brand-logo { width: 170px; }
        .version, .nav-group, .sidebar-foot { display: none; }
        .sidebar::after { content: "ChainPay MCP docs · Devnet"; float: right; margin-top: 14px; color: var(--subtle); font: 10px var(--mono); }
        .topbar { padding: 0 18px; }
        .top-links a { display: none; }
        .content { padding-bottom: 72px; }
        .hero { padding: 72px 18px 78px; }
        .hero-grid, .section, .footer { width: min(100% - 36px, 660px); }
        .hero-grid { padding-top: 24px; }
        .hero h1 { font-size: 50px; }
        .cards, .split, .tool-grid { grid-template-columns: 1fr; }
        .flow { grid-template-columns: 1fr; }
        .flow-step { min-height: 0; border-right: 0; border-bottom: 1px solid var(--line); }
        .flow-step:last-child { border-bottom: 0; }
        .flow-step:not(:last-child)::after { content: "↓"; top: auto; right: 24px; bottom: -11px; }
        .section-heading { display: block; }
        .section-index { display: block; margin-bottom: 10px; }
        .stats-panel { grid-template-columns: 1fr; }
        .footer { display: block; }
        .footer span { display: block; margin-top: 7px; }
      }
      @media (max-width: 480px) {
        .hero h1 { font-size: 43px; }
        .hero-panel, .info-card, .tool-card { padding: 24px; }
        .section { padding-top: 78px; }
        .section-heading h2 { font-size: 36px; }
        .endpoint-card { grid-template-columns: 60px 1fr; gap: 12px; }
        .endpoint-card span:last-child { grid-column: 2; }
      }
      .connector-flow, .settlement-flow { margin-top: 30px; }
      .connector-detail { align-items: stretch; }
      .connector-detail .info-card { height: 100%; }
      .connector-callout { display: flex; align-items: flex-start; min-height: 100%; }
      .usecase-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
      .usecase-card { min-height: 278px; padding: 28px; border: 1px solid var(--line); border-radius: 24px; background: #fff; box-shadow: none; }
      .usecase-card-top { display: flex; align-items: center; justify-content: space-between; }
      .usecase-index { color: var(--blue); font: 500 11px var(--mono); }
      .usecase-card .card-icon { flex: 0 0 auto; }
      .usecase-card h3 { margin-top: 24px; font-size: 20px; font-weight: 600; }
      .usecase-card p { min-height: 88px; margin-top: 11px; color: var(--muted); font-size: 13px; line-height: 1.7; }
      .usecase-tool { display: inline-flex; padding: 7px 10px; margin-top: 22px; border-radius: 100px; color: var(--blue); background: var(--blue-soft); font: 500 10px var(--mono); }
      .connector-callout { display: grid; align-content: start; gap: 8px; min-height: 100%; }
      .connector-callout strong { display: block; margin-bottom: 4px; }
      .connector-callout span, .connector-callout code { display: block; }
      .connector-callout code { width: fit-content; padding: 6px 9px; border-radius: 8px; color: var(--ink); background: #fff; font-size: 11px; }
      .rail-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; margin-top: 20px; }
      .rail-card { display: grid; grid-template-columns: 42px 1fr auto; align-items: start; gap: 15px; padding: 24px; border: 1px solid var(--line); border-radius: 24px; background: #fff; }
      .rail-icon { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 50%; color: var(--blue); background: var(--blue-soft); font-weight: 600; }
      .rail-card h3 { font-size: 17px; font-weight: 600; }
      .rail-card p { margin-top: 7px; color: var(--muted); font-size: 12px; line-height: 1.6; }
      .rail-card > code { align-self: center; padding: 6px 9px; border-radius: 100px; color: var(--ink-soft); background: var(--strong); font-size: 10px; }
      .use-case-reference { display: grid; gap: 12px; }
      .use-case-detail { overflow: hidden; border: 1px solid var(--line); border-radius: 20px; background: #fff; }
      .use-case-detail summary { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 22px 24px; cursor: pointer; list-style: none; }
      .use-case-detail summary::-webkit-details-marker { display: none; }
      .use-case-detail summary:hover { background: var(--soft); }
      .use-case-detail summary:focus-visible { outline: 3px solid rgba(0, 82, 255, .22); outline-offset: -3px; }
      .use-case-detail[open] summary { border-bottom: 1px solid var(--line); background: var(--soft); }
      .use-case-detail[open] .use-case-open span { display: inline-block; transform: rotate(180deg); }
      .use-case-summary { display: grid; gap: 5px; min-width: 0; }
      .use-case-summary strong { color: var(--ink); font-size: 17px; font-weight: 600; }
      .use-case-summary small { overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .use-case-open { color: var(--blue); font: 500 11px var(--mono); white-space: nowrap; }
      .use-case-open span { display: inline-block; margin-left: 4px; transition: transform .18s ease; }
      .use-case-body { padding: 26px 28px 28px; }
      .use-case-description { max-width: 760px; color: var(--muted); font-size: 14px; line-height: 1.7; }
      .uml-diagram { overflow: hidden; margin-top: 22px; border: 1px solid var(--line); border-radius: 16px; background: #fff; }
      .uml-title { display: flex; justify-content: space-between; gap: 14px; padding: 12px 16px; border-bottom: 1px solid var(--line); color: var(--subtle); background: var(--soft); font: 600 9px var(--mono); letter-spacing: .07em; }
      .uml-message { display: grid; grid-template-columns: 32px 128px 28px 150px minmax(0, 1fr); align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line-soft); font-size: 11px; }
      .uml-message:last-child { border-bottom: 0; }
      .uml-number { color: var(--blue); font: 500 10px var(--mono); }
      .uml-message strong { color: var(--ink); font-size: 11px; font-weight: 600; }
      .uml-arrow { color: var(--blue); font-size: 16px; text-align: center; }
      .uml-message p { min-width: 0; margin: 0; color: var(--muted); line-height: 1.5; }
      .use-case-outcome { display: flex; align-items: baseline; gap: 10px; padding: 14px 16px; margin-top: 16px; border-left: 3px solid var(--green); border-radius: 0 10px 10px 0; color: var(--muted); background: #effaf5; font-size: 12px; line-height: 1.5; }
      .use-case-outcome strong { color: #08784f; }
      @media (max-width: 800px) {
        .usecase-grid, .rail-grid { grid-template-columns: 1fr; }
        .rail-card { grid-template-columns: 42px 1fr; }
        .rail-card > code { grid-column: 2; justify-self: start; }
      }
      /* Device response follows the Coinbase editorial breakpoints. */
      @media (min-width: 1025px) and (max-width: 1279px) {
        .hero { padding-inline: 64px; }
        .hero-grid, .section, .footer { width: min(1100px, calc(100% - 80px)); }
      }
      @media (min-width: 640px) and (max-width: 1024px) {
        :root { --sidebar: 220px; }
        .topbar { padding-inline: 32px; }
        .hero { padding: 80px 32px 88px; }
        .hero h1 { font-size: 64px; letter-spacing: -2px; }
        .hero-grid, .section, .footer { width: min(100% - 64px, 760px); }
        .cards, .usecase-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .rail-grid { grid-template-columns: 1fr; }
        .flow { grid-template-columns: repeat(5, minmax(0, 1fr)); }
        .flow-step { min-height: 178px; padding: 16px; }
        .flow-step h3 { margin-top: 20px; font-size: 14px; }
        .flow-step p { font-size: 11px; }
        .flow-step:not(:last-child)::after { right: -7px; }
        .usecase-card { min-height: 300px; padding: 24px; }
        .usecase-card p { min-height: 112px; }
        .uml-message { grid-template-columns: 28px 92px 20px 105px minmax(0, 1fr); gap: 7px; padding-inline: 12px; }
      }
      @media (max-width: 639px) {
        .layout { display: block; }
        .sidebar { position: static; height: auto; padding: 16px; border-right: 0; border-bottom: 1px solid var(--line); }
        .brand-link { display: inline-block; padding: 0 0 14px; }
        .brand-logo { width: 166px; }
        .version { display: inline-flex; margin: 0 0 18px; }
        .sidebar::after { display: none; }
        .sidebar nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 8px; }
        .nav-group { display: block; min-width: 0; margin-top: 0; }
        .nav-label { padding: 0 8px 7px; font-size: 9px; }
        .nav-link { min-height: 36px; padding: 8px; font-size: 11px; white-space: nowrap; }
        .sidebar-foot { display: none; }
        .topbar { min-height: 64px; padding: 0 16px; }
        .breadcrumbs { font-size: 12px; }
        .breadcrumbs span { display: none; }
        .top-links { gap: 8px; }
        .top-links a { display: none; }
        .network { padding: 8px 10px; font-size: 9px; }
        .content { padding-bottom: 72px; }
        .hero { padding: 56px 16px 64px; }
        .hero h1 { font-size: 40px; line-height: 1.02; letter-spacing: -1.2px; }
        .hero-copy { font-size: 15px; }
        .hero-actions { align-items: stretch; flex-direction: column; }
        .hero-actions .button { width: 100%; }
        .endpoint-pill { overflow: hidden; max-width: 100%; }
        .endpoint-pill code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .hero-grid, .section, .footer { width: calc(100% - 32px); }
        .hero-grid { padding-top: 20px; }
        .hero-panel, .info-card, .tool-card { padding: 24px; }
        .hero-panel h2 { font-size: 23px; }
        .section { padding-top: 72px; }
        .section-heading h2 { font-size: 35px; }
        .cards, .split, .tool-grid, .usecase-grid, .rail-grid { grid-template-columns: 1fr; }
        .flow { grid-template-columns: 1fr; }
        .flow-step { min-height: 0; padding: 20px; border-right: 0; border-bottom: 1px solid var(--line); }
        .flow-step:last-child { border-bottom: 0; }
        .flow-step:not(:last-child)::after { content: "↓"; top: auto; right: 20px; bottom: -11px; }
        .usecase-card { min-height: 0; padding: 24px; }
        .usecase-card p { min-height: 0; }
        .rail-card { grid-template-columns: 42px 1fr; padding: 20px; }
        .rail-card > code { grid-column: 2; justify-self: start; }
        .use-case-detail summary { grid-template-columns: 34px minmax(0, 1fr); gap: 12px; padding: 18px; }
        .use-case-open { grid-column: 2; }
        .use-case-body { padding: 22px 18px 20px; }
        .uml-title { display: block; line-height: 1.6; }
        .uml-title span { display: block; }
        .uml-message { grid-template-columns: 28px minmax(0, max-content) 20px minmax(0, max-content); gap: 7px; padding: 12px; }
        .uml-message p { grid-column: 2 / -1; margin-top: 4px; }
        .use-case-outcome { align-items: flex-start; flex-direction: column; gap: 4px; }
        .endpoint-card { grid-template-columns: 58px 1fr; gap: 10px; padding: 17px; }
        .endpoint-card span:last-child { grid-column: 2; }
        .footer { margin-top: 72px; }
      }
    </style>
  </head>
  <body>
    <div class="layout">
      <aside class="sidebar">
        <a class="brand-link" href="#top" aria-label="ChainPay documentation home">${pageLogo}</a>
        <div class="version"><i></i> DEVNET · MCP TOOLS</div>
        <nav aria-label="Documentation navigation">
          <div class="nav-group">
            <div class="nav-label">Start here</div>
            <a class="nav-link active" href="#top"><span>⌂</span>Overview</a>
            <a class="nav-link" href="#quickstart"><span>↳</span>Quickstart</a>
          </div>
          <div class="nav-group">
            <div class="nav-label">Build with ChainPay</div>
            <a class="nav-link" href="#authentication"><span>↗</span>Authentication</a>
            <a class="nav-link" href="#agent-payments"><span>↗</span>Agent payments</a>
            <a class="nav-link" href="#x402"><span>↔</span>x402 connector</a>
            <a class="nav-link" href="#stablecoin-flow"><span>◎</span>Stablecoin flow</a>
          </div>
          <div class="nav-group">
            <div class="nav-label">Use cases</div>
            <a class="nav-link" href="#use-cases"><span>◇</span>Payment scenarios</a>
            <a class="nav-link" href="#policy-firewall"><span>⌁</span>Policy firewall</a>
            <a class="nav-link" href="#assets"><span>◈</span>SPL &amp; Token-2022</a>
          </div>
          <div class="nav-group">
            <div class="nav-label">Reference</div>
            <a class="nav-link" href="#tool-reference"><span>▤</span>Tool reference</a>
            <a class="nav-link" href="#endpoints"><span>⌁</span>HTTP endpoints</a>
          </div>
        </nav>
        <div class="sidebar-foot">Built for agents that need payment rails with <a href="#policy-firewall">explicit boundaries</a>.</div>
      </aside>

      <main class="main" id="top">
        <header class="topbar">
          <div class="breadcrumbs"><strong>ChainPay</strong> <span>/</span> MCP documentation</div>
          <div class="top-links">
            <a href="/tools">Tool catalog</a>
            <a href="/healthz">Health</a>
            <span class="network"><i></i> Solana Devnet</span>
          </div>
        </header>

        <div class="content">
          <section class="hero" aria-labelledby="hero-title">
            <span class="eyebrow"><i></i> Policy-controlled payments for agents</span>
            <h1 id="hero-title">Spending limits for <em>AI agents.</em></h1>
            <p class="hero-copy">ChainPay lets an owner approve limited token spending on Solana Devnet. Agents use MCP tools to inspect a mandate, prepare a payment, and retrieve its receipt. The on-chain program enforces the spending rules.</p>
            <div class="hero-actions">
              <a class="button button-primary" href="#quickstart">Start building <span>↗</span></a>
              <a class="button button-quiet" href="#tool-reference">Browse tools <span>↓</span></a>
            </div>
            <div class="endpoint-pill"><span>MCP endpoint</span><code data-endpoint>/mcp</code></div>
          </section>

          <section class="hero-grid" id="quickstart" aria-labelledby="quickstart-title">
            <div class="hero-panel">
              <span class="panel-kicker">01 · Connect an MCP client</span>
              <h2 id="quickstart-title">Start with a read-only result.</h2>
              <p>Replace YOUR_MCP_HOST with your server. This public configuration discovers tools and reads protocol configuration without a token or wallet. Expected: a tool catalog, then configuration or an explicit RPC/account error. A successful discovery does not establish payment availability.</p>
              ${renderCode(connectionConfig)}
              <div class="code-label"><span>Use /mcp in your client config</span><span class="copyable" data-copy="config">Copy</span></div>
              <div class="prompt-example"><span class="code-label"><span>Try this read-only prompt</span><span class="copyable" data-copy="prompt">Copy</span></span>${renderCode(demoPrompt)}</div>
            </div>
            <div class="stats-panel">
              <div class="stat"><strong>${TOOL_DEFINITIONS.length}</strong><span>payment and policy tools exposed</span></div>
              <div class="stat"><strong>2</strong><span>supported Solana token programs</span></div>
              <div class="stat"><strong>0</strong><span>private keys held by MCP</span></div>
            </div>
          </section>

          <section class="section" id="authentication" aria-labelledby="authentication-title">
            <div class="section-heading"><div><h2 id="authentication-title">Authorize private tools.</h2><p>A wallet address is not a login. The owner signs the dashboard’s wallet-message challenge, then creates a connection for selected owned mandates and tools. Copy its one-time token into the client’s private <code>headers.Authorization</code> value as <code>Bearer YOUR_SCOPED_CONNECTION_TOKEN</code>. Never put credentials in a prompt or commit them.</p></div></div>
            <div class="callout"><strong>First private read:</strong> select <code>get_mandate</code> when creating the connection, then call it with <code>{"address":"YOUR_MANDATE_PDA"}</code>. An unrelated mandate or unselected tool must be rejected. Owner-management tools require an owner session. Login does not authorize spending; human payment signatures and existing delegated mandates remain separate approvals.</div>
            <p>For stdio, build the repository’s private workspace package and launch <code>mcp-server/dist/server.js</code>. Private calls need <code>CHAINPAY_BACKEND_URL</code> and <code>CHAINPAY_CALLER_TOKEN</code>. Shared service tokens cannot authorize a caller. The source checkout contains the full guide at <code>docs/guides/connect-an-agent.md</code>.</p>
          </section>

          <section class="section" id="agent-payments" aria-labelledby="payments-title">
            <div class="section-heading"><div><span class="section-index">02 · Agent payments</span><h2 id="payments-title">A payment flow agents can explain.</h2><p>Check requirements first, review the exact fields, and use an explicitly authorized signer before submission. A quote is advisory; the program enforces the policy.</p></div></div>
            <div class="flow">
              <div class="flow-step"><strong>01</strong><h3>Inspect</h3><p>Read the mandate, protocol config, and asset registry.</p></div>
              <div class="flow-step"><strong>02</strong><h3>Quote</h3><p>Ask for a policy result without signing or submitting.</p></div>
              <div class="flow-step"><strong>03</strong><h3>Prepare</h3><p>Build a mandate-checked transaction plan.</p></div>
              <div class="flow-step"><strong>04</strong><h3>Execute</h3><p>Use explicit human wallet signing or a provisioned delegated signer through Axum.</p></div>
              <div class="flow-step"><strong>05</strong><h3>Confirm</h3><p>Wait for status and fetch the durable receipt.</p></div>
            </div>
            <div class="split" style="margin-top: 18px">
              <div>${renderCode(quoteExample)}</div>
              <div class="callout"><strong>Safe default:</strong> use <code>quote_payment</code> while the agent is deciding. It returns the policy preflight result but does not sign, submit, or move funds.</div>
            </div>
          </section>

          <section class="section" id="x402" aria-labelledby="x402-title">
            <div class="section-heading"><div><span class="section-index">03 · x402 connector</span><h2 id="x402-title">Custom x402/1.0 receipt proof, with standard v2 recognized but unavailable.</h2><p>ChainPay settles the custom receipt-proof rail on the same mandate interface. A paid API returns HTTP 402; protocol is detected from document shape, not from the header name. Standard x402 v2 exact SVM (sponsor countersign) is parsed and returned as unsupported-sponsor before any wallet or settlement work.</p></div></div>
            <div class="flow connector-flow">
              <div class="flow-step"><strong>01</strong><h3>Challenge</h3><p>Custom <code>x402/1.0</code> uses <code>network: solana-devnet</code> and <code>payTo</code> as a recipient token account. Standard v2 uses <code>x402Version: 2</code> and CAIP-2 <code>solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1</code>, where <code>payTo</code> is the merchant owner.</p></div>
              <div class="flow-step"><strong>02</strong><h3>Detect</h3><p><code>prepare_x402_payment</code> and <code>execute_x402_payment</code> require an explicit protocol version or network. Amounts are canonical decimal u64 strings. A v2 challenge never copies owner <code>payTo</code> into the custom recipient-token-account field.</p></div>
              <div class="flow-step"><strong>03</strong><h3>Preflight</h3><p>Only the custom rail continues. ChainPay checks the mandate, mint, token program, supplied recipient token account, limits, expiry, and available policy authority.</p></div>
              <div class="flow-step"><strong>04</strong><h3>Sign</h3><p>An external wallet or signer reviews the prepared custom transaction. MCP never receives a seed phrase or private key. Standard v2 never reaches this step.</p></div>
              <div class="flow-step"><strong>05</strong><h3>Proof</h3><p>After settlement, retry the original resource with an <code>x402/1.0</code> signature plus receipt PDA. That proof is not a partially signed sponsored transaction. Resume with <code>paymentId</code> retries delivery only.</p></div>
            </div>
            <div class="split connector-detail" style="margin-top: 20px">
              <div class="info-card"><div class="card-icon">↔</div><h3>How agents use it</h3><p>Call <code>execute_x402_payment</code> with <code>resource</code>, <code>mandate</code>, <code>agent</code>, and explicit <code>signingMode</code>. Human mode returns an unsigned transaction, then accepts its externally signed version. Delegated mode sends the unsigned wire to Axum’s mandate-bound provider signer and rejects supplied signatures. ChainPay verifies settlement before retrying delivery. Standard v2 returns <code>x402_unsupported_sponsor</code>.</p></div>
              <div class="callout connector-callout"><strong>Connector boundary</strong><span>Custom x402/1.0 does not bypass ChainPay policy.</span><span>The adapter detects custom vs standard v2 from document shape.</span><span>It binds the custom challenge to a deterministic invoice hash.</span><span>Human mode relays a wallet-signed transaction; delegated mode uses Axum’s authenticated managed signer.</span><span>It is not a key custodian, hosted facilitator, or standard x402 sponsor.</span></div>
            </div>
          </section>

          <section class="section" id="stablecoin-flow" aria-labelledby="stablecoin-title">
            <div class="section-heading"><div><span class="section-index">04 · Stablecoin settlement</span><h2 id="stablecoin-title">One policy surface for every supported token rail.</h2><p>Stablecoin payments use the same mandate and receipt model whether the asset is classic SPL Token or Token-2022. A mandate limits the agent, mint, amount, and time; each payment supplies one recipient and settles only to that destination.</p></div></div>
            <div class="flow settlement-flow">
              <div class="flow-step"><strong>01</strong><h3>Choose the rail</h3><p>Set the stablecoin mint and choose <code>spl-token</code> or <code>token-2022</code>.</p></div>
              <div class="flow-step"><strong>02</strong><h3>Set the boundary</h3><p>Bind the source account, approved agent, per-payment and total limits. The recipient is supplied with each payment request.</p></div>
              <div class="flow-step"><strong>03</strong><h3>Quote in base units</h3><p>Use <code>quote_payment</code> or <code>prepare_payment</code> before any signature is requested.</p></div>
              <div class="flow-step"><strong>04</strong><h3>Transfer on Solana</h3><p>The program enforces the mandate and transfers through the selected token program. The SDK capability scan admits only extension combinations supported by the current transparent transfer path.</p></div>
              <div class="flow-step"><strong>05</strong><h3>Reconcile</h3><p>Read the receipt PDA and backend status to give the agent and merchant durable proof.</p></div>
            </div>
            <div class="rail-grid">
              <div class="rail-card"><span class="rail-icon">$</span><div><h3>Classic SPL Token</h3><p>For standard SPL stablecoins and tokens. Every mint and token account must belong to the classic Token program.</p></div><code>spl-token</code></div>
              <div class="rail-card"><span class="rail-icon">◈</span><div><h3>Token-2022</h3><p>For enabled registry mints whose live mint, source, and recipient capability scan is compatible. Active hooks, non-zero fees, confidential-only transfers, and unknown transfer-affecting extensions fail closed.</p></div><code>token-2022</code></div>
            </div>
          </section>

          <section class="section" id="use-cases" aria-labelledby="use-cases-title">
            <div class="section-heading"><div><span class="section-index">05 · Use cases</span><h2 id="use-cases-title">Three flows to understand first.</h2><p>These sequences describe the implemented interfaces. A deployed server, registered Devnet asset, wallet, and any required provider still need separate verification. Batch payouts, subscriptions, governance rules, and production connectors are outside the supported scope described here.</p></div></div>
            <div class="use-case-reference">${renderUseCaseReference()}</div>
          </section>

          <section class="section" id="policy-firewall" aria-labelledby="firewall-title">
            <div class="section-heading"><div><span class="section-index">06 · Policy firewall</span><h2 id="firewall-title">Make the mandate the firewall.</h2><p>ChainPay turns an owner-approved mandate into a narrow spending boundary enforced by the on-chain program.</p></div></div>
            <div class="cards">
              <article class="info-card"><div class="card-icon">◇</div><h3>Who can spend</h3><p>Bind the mandate to one approved agent public key. Owner updates, pauses, and revocation remain wallet-signed actions.</p><a href="#tool-create-mandate">create_mandate →</a></article>
              <article class="info-card"><div class="card-icon">⌁</div><h3>Where funds can go</h3><p>Lock the allowed mint and require every payment request to provide one destination. The transfer settles only to the supplied recipient.</p><a href="#tool-prepare-payment">prepare_payment →</a></article>
              <article class="info-card"><div class="card-icon">↗</div><h3>How much, how often</h3><p>Set per-payment and total limits, expiry, payment count, and cooldown slots to make agent spending predictable.</p><a href="#tool-update-mandate">update_mandate →</a></article>
            </div>
          </section>

          <section class="section" id="assets" aria-labelledby="assets-title">
            <div class="section-heading"><div><span class="section-index">07 · Assets and token programs</span><h2 id="assets-title">SPL-compatible by design.</h2><p>ChainPay supports classic SPL Token and Token-2022 settlement, with explicit program selection so an agent cannot accidentally mix account types.</p></div></div>
            <div class="split">
              <div class="info-card"><div class="card-icon">◎</div><h3>Classic SPL Token</h3><p>Set <code>tokenProgram</code> to <code>spl-token</code>. The mint, source account, and destination account must belong to the classic Token program.</p><a href="#tool-get-asset">Inspect an asset →</a></div>
              <div class="info-card"><div class="card-icon">✦</div><h3>Token-2022</h3><p>Register a Token-2022 mint, then ChainPay verifies its program identity and scans the live mint and token-account extensions before every prepared payment. Unsupported transfer behavior is rejected until a tested adapter exists.</p><a href="#tool-get-protocol-config">Read protocol config →</a></div>
            </div>
            <div class="callout" style="margin-top: 16px"><strong>Important:</strong> token amounts are passed as unsigned base units. The protocol validates the configured mint and token program before a payment can settle.</div>
          </section>

          <section class="section" id="tool-reference" aria-labelledby="tools-title">
            <div class="section-heading"><div><span class="section-index">08 · Tool reference</span><h2 id="tools-title">Tools any agent can discover.</h2><p>The catalog below is generated from the same definitions returned by MCP <code>tools/list</code>. Required fields are shown to make orchestration easier.</p></div><a class="button button-quiet" href="/tools">Open JSON catalog ↗</a></div>
            <div class="tool-grid">${renderToolReference()}</div>
          </section>

          <section class="section" id="mcp-protocol" aria-labelledby="mcp-protocol-title">
            <div class="section-heading"><div><span class="section-index">09 · MCP protocol</span><h2 id="mcp-protocol-title">Tested subset, not blanket conformance.</h2><p>ChainPay implements a dual-era JSON-RPC boundary verified against the official <a href="https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts">2026-07-28 schema</a> on 2026-09-15. Wallet sessions are application authentication from PR-01, not MCP OAuth.</p></div></div>
            <div class="callout"><strong>Supported now:</strong> <code>server/discover</code>, <code>tools/list</code>, and <code>tools/call</code> on current <code>2026-07-28</code> without an initialize handshake; legacy <code>initialize</code>/<code>ping</code>/<code>tools/list</code>/<code>tools/call</code> for <code>2025-06-18</code> and <code>2024-11-05</code>; public discovery versus private owner tools on HTTP and stdio. Current-version GET or DELETE to <code>/mcp</code> returns 405. Legacy GET is a keepalive comment stream only — not <code>subscriptions/listen</code>, resources, prompts, or MRTR. Capability and version metadata never authorize a wallet.</div>
          </section>

          <section class="section" id="endpoints" aria-labelledby="endpoints-title">
            <div class="section-heading"><div><span class="section-index">10 · HTTP reference</span><h2 id="endpoints-title">A small surface area.</h2><p>Use the MCP transport for agents and the read-only routes for humans, health checks, and integration discovery.</p></div></div>
            <div class="table-wrap">
              <a class="endpoint-card" href="/"><span class="method">GET</span><code>/</code><span>Developer documentation preview</span></a>
              <a class="endpoint-card" href="/mcp"><span class="method">POST</span><code>/mcp</code><span>Streamable HTTP JSON-RPC MCP transport</span></a>
              <a class="endpoint-card" href="/tools"><span class="method">GET</span><code>/tools</code><span>Read-only tool definitions and input schemas</span></a>
              <a class="endpoint-card" href="/healthz"><span class="method">GET</span><code>/healthz</code><span>Render health check and service status</span></a>
              <a class="endpoint-card" href="/logo.svg"><span class="method">GET</span><code>/logo.svg</code><span>ChainPay brand mark used by this documentation</span></a>
              <a class="endpoint-card" href="/og-image.png"><span class="method">GET</span><code>/og-image.png</code><span>Raster social preview image for link unfurlers</span></a>
            </div>
          </section>

          <footer class="footer"><span>ChainPay MCP · Solana Devnet · Built for policy-first agent payments</span><span><a href="/mcp">Connect</a> · <a href="/tools">Tools</a> · <a href="/healthz">Status</a></span></footer>
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
          await navigator.clipboard?.writeText(value);
          element.textContent = "Copied";
          window.setTimeout(() => { element.textContent = "Copy"; }, 1400);
        });
      });
    </script>
  </body>
</html>`;
}
