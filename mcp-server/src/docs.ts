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

export function renderDocsHtml(): string {
  const connectionConfig = `{
  "mcpServers": {
    "chainpay": {
      "url": "https://chainpay-mcp.onrender.com/mcp"
    }
  }
}`;

  const demoPrompt = "Use ChainPay to inspect the protocol config, then quote a payment for this demo invoice without executing it.";

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
    <meta name="description" content="ChainPay MCP documentation for policy-controlled agent payments on Solana." />
    <title>ChainPay MCP · Solana payment infrastructure</title>
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
    </style>
  </head>
  <body>
    <div class="layout">
      <aside class="sidebar">
        <a class="brand-link" href="#top" aria-label="ChainPay documentation home">${pageLogo}</a>
        <div class="version"><i></i> DEVNET · MCP 1.0</div>
        <nav aria-label="Documentation navigation">
          <div class="nav-group">
            <div class="nav-label">Start here</div>
            <a class="nav-link active" href="#top"><span>⌂</span>Overview</a>
            <a class="nav-link" href="#quickstart"><span>↳</span>Quickstart</a>
          </div>
          <div class="nav-group">
            <div class="nav-label">Build with ChainPay</div>
            <a class="nav-link" href="#agent-payments"><span>↗</span>Agent payments</a>
            <a class="nav-link" href="#policy-firewall"><span>◇</span>Policy firewall</a>
            <a class="nav-link" href="#assets"><span>◎</span>SPL &amp; Token-2022</a>
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
            <h1 id="hero-title">Move money with <em>guardrails.</em></h1>
            <p class="hero-copy">ChainPay gives AI agents a safe payment rail on Solana. Agents can inspect mandates, quote and prepare payments, and relay approved transactions—while owners keep the signing authority.</p>
            <div class="hero-actions">
              <a class="button button-primary" href="#quickstart">Start building <span>↗</span></a>
              <a class="button button-quiet" href="#tool-reference">Browse tools <span>↓</span></a>
            </div>
            <div class="endpoint-pill"><span>MCP endpoint</span><code data-endpoint>/mcp</code></div>
          </section>

          <section class="hero-grid" id="quickstart" aria-labelledby="quickstart-title">
            <div class="hero-panel">
              <span class="panel-kicker">01 · Connect an MCP client</span>
              <h2 id="quickstart-title">One endpoint. Every payment primitive.</h2>
              <p>Point any MCP-compatible agent at the hosted endpoint. Tool discovery is automatic, and the HTTP transport never receives a seed phrase or private key.</p>
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

          <section class="section" id="agent-payments" aria-labelledby="payments-title">
            <div class="section-heading"><div><span class="section-index">02 · Agent payments</span><h2 id="payments-title">A payment flow agents can explain.</h2><p>Keep payment decisions inspectable. Preflight first, sign only in the wallet boundary, then submit and observe the receipt.</p></div></div>
            <div class="flow">
              <div class="flow-step"><strong>01</strong><h3>Inspect</h3><p>Read the mandate, protocol config, and asset registry.</p></div>
              <div class="flow-step"><strong>02</strong><h3>Quote</h3><p>Ask for a policy result without signing or submitting.</p></div>
              <div class="flow-step"><strong>03</strong><h3>Prepare</h3><p>Build a mandate-checked transaction plan.</p></div>
              <div class="flow-step"><strong>04</strong><h3>Execute</h3><p>Relay a wallet-signed transaction through the backend.</p></div>
              <div class="flow-step"><strong>05</strong><h3>Confirm</h3><p>Wait for status and fetch the durable receipt.</p></div>
            </div>
            <div class="split" style="margin-top: 18px">
              <div>${renderCode(quoteExample)}</div>
              <div class="callout"><strong>Safe default:</strong> use <code>quote_payment</code> while the agent is deciding. It returns the policy preflight result but does not sign, submit, or move funds.</div>
            </div>
          </section>

          <section class="section" id="policy-firewall" aria-labelledby="firewall-title">
            <div class="section-heading"><div><span class="section-index">03 · Policy firewall</span><h2 id="firewall-title">Make the mandate the firewall.</h2><p>ChainPay turns an owner-approved mandate into a narrow spending boundary enforced by the on-chain program.</p></div></div>
            <div class="cards">
              <article class="info-card"><div class="card-icon">◇</div><h3>Who can spend</h3><p>Bind the mandate to one approved agent public key. Owner updates, pauses, and revocation remain wallet-signed actions.</p><a href="#tool-create-mandate">create_mandate →</a></article>
              <article class="info-card"><div class="card-icon">⌁</div><h3>Where funds can go</h3><p>Lock the allowed mint and recipient token account. A request outside the configured destination is rejected during preflight and on-chain execution.</p><a href="#tool-prepare-payment">prepare_payment →</a></article>
              <article class="info-card"><div class="card-icon">↗</div><h3>How much, how often</h3><p>Set per-payment and total limits, expiry, payment count, and cooldown slots to make agent spending predictable.</p><a href="#tool-update-mandate">update_mandate →</a></article>
            </div>
            <ul class="check-list">
              <li>Use <code>pause_mandate</code> for an immediate owner-controlled stop.</li>
              <li>Use <code>revoke_mandate</code> for permanent shutdown of a policy.</li>
              <li>Use <code>verify_payment_request</code> to validate a merchant-signed request before settlement.</li>
            </ul>
          </section>

          <section class="section" id="assets" aria-labelledby="assets-title">
            <div class="section-heading"><div><span class="section-index">04 · Assets and token programs</span><h2 id="assets-title">SPL-compatible by design.</h2><p>ChainPay supports classic SPL Token and Token-2022 settlement, with explicit program selection so an agent cannot accidentally mix account types.</p></div></div>
            <div class="split">
              <div class="info-card"><div class="card-icon">◎</div><h3>Classic SPL Token</h3><p>Set <code>tokenProgram</code> to <code>spl-token</code>. The mint, source account, and destination account must belong to the classic Token program.</p><a href="#tool-get-asset">Inspect an asset →</a></div>
              <div class="info-card"><div class="card-icon">✦</div><h3>Token-2022</h3><p>Set <code>tokenProgram</code> to <code>token-2022</code>. Keep the same program identity across the mint and every token account in the payment.</p><a href="#tool-get-protocol-config">Read protocol config →</a></div>
            </div>
            <div class="callout" style="margin-top: 16px"><strong>Important:</strong> token amounts are passed as unsigned base units. The protocol validates the configured mint and token program before a payment can settle.</div>
          </section>

          <section class="section" id="tool-reference" aria-labelledby="tools-title">
            <div class="section-heading"><div><span class="section-index">05 · Tool reference</span><h2 id="tools-title">Tools any agent can discover.</h2><p>The catalog below is generated from the same definitions returned by MCP <code>tools/list</code>. Required fields are shown to make orchestration easier.</p></div><a class="button button-quiet" href="/tools">Open JSON catalog ↗</a></div>
            <div class="tool-grid">${renderToolReference()}</div>
          </section>

          <section class="section" id="endpoints" aria-labelledby="endpoints-title">
            <div class="section-heading"><div><span class="section-index">06 · HTTP reference</span><h2 id="endpoints-title">A small surface area.</h2><p>Use the MCP transport for agents and the read-only routes for humans, health checks, and integration discovery.</p></div></div>
            <div class="table-wrap">
              <a class="endpoint-card" href="/"><span class="method">GET</span><code>/</code><span>Developer documentation preview</span></a>
              <a class="endpoint-card" href="/mcp"><span class="method">POST</span><code>/mcp</code><span>Streamable HTTP JSON-RPC MCP transport</span></a>
              <a class="endpoint-card" href="/tools"><span class="method">GET</span><code>/tools</code><span>Read-only tool definitions and input schemas</span></a>
              <a class="endpoint-card" href="/healthz"><span class="method">GET</span><code>/healthz</code><span>Render health check and service status</span></a>
              <a class="endpoint-card" href="/logo.svg"><span class="method">GET</span><code>/logo.svg</code><span>ChainPay brand mark used by this documentation</span></a>
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
            : ${JSON.stringify(connectionConfig)}.replace("YOUR_RENDER_HOST", window.location.host);
          await navigator.clipboard?.writeText(value);
          element.textContent = "Copied";
          window.setTimeout(() => { element.textContent = "Copy"; }, 1400);
        });
      });
    </script>
  </body>
</html>`;
}
