import { Keypair } from "@solana/web3.js";
import {
  buildMandateRequestPayload,
  encodeMandateRequestLink,
  mandateRequestSummary,
  signMandateRequest,
  type SignedMandateRequest,
} from "@chainpayhq/sdk";
import { assertSafeHttpUrl, parseSellerSecretKey, sellerIdentity, type MerchantConfig } from "./config.js";

const MAX_U64 = 18_446_744_073_709_551_615n;
const DEFAULT_APP_URL = "https://chainpay-frontend.onrender.com";

/**
 * What the merchant asks owners for. Per-payment defaults to the resource
 * price; the total to ten payments. The request is a proposal: the owner sets
 * the real limits in their own wallet.
 */
export type MandateRequestSettings = {
  requester: string;
  secretKey: Uint8Array;
  /** True when no seller key is configured and a per-process key signs instead. */
  throwawayKey: boolean;
  requesterName: string;
  appUrl: string;
  description: string;
  maxPerPayment: string;
  total: string;
  days: number;
  decimals?: number;
};

export type MandateRequestDependencies = {
  getCurrentSlot(): Promise<bigint>;
  getMintDecimals(mint: string): Promise<number>;
};

/** The slot or mint read failed; nothing was signed. */
export class MandateRequestLookupError extends Error {}

export type CreatedMandateRequest = {
  link: string;
  summary: string;
  request: SignedMandateRequest;
};

function positiveU64(value: string, name: string): string {
  if (!/^[1-9]\d*$/.test(value) || BigInt(value) > MAX_U64) {
    throw new Error(`${name} must be a positive base-unit integer string`);
  }
  return value;
}

/**
 * Signs with `CHAINPAY_SELLER_SECRET_KEY` when set. Without it, development
 * gets a throwaway key so the page works; production gets no endpoint.
 */
export function loadMandateRequestSettings(
  env: NodeJS.Dict<string>,
  config: MerchantConfig,
): MandateRequestSettings | undefined {
  const encoded = env.CHAINPAY_SELLER_SECRET_KEY?.trim();
  let identity: { secretKey: Uint8Array; seller: string };
  let throwawayKey = false;
  if (encoded) {
    identity = sellerIdentity(parseSellerSecretKey(encoded));
  } else if (env.NODE_ENV === "production") {
    return undefined;
  } else {
    const keypair = Keypair.generate();
    identity = { secretKey: keypair.secretKey, seller: keypair.publicKey.toBase58() };
    throwawayKey = true;
  }
  const maxPerPayment = positiveU64(config.amount, "CHAINPAY_X402_AMOUNT");
  const total = positiveU64(
    env.CHAINPAY_MANDATE_REQUEST_TOTAL?.trim() || (BigInt(maxPerPayment) * 10n > MAX_U64 ? maxPerPayment : (BigInt(maxPerPayment) * 10n).toString()),
    "CHAINPAY_MANDATE_REQUEST_TOTAL",
  );
  const days = Number(env.CHAINPAY_MANDATE_REQUEST_DAYS?.trim() || "30");
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error("CHAINPAY_MANDATE_REQUEST_DAYS must be a whole number from 1 to 3650");
  }
  const decimalsText = env.CHAINPAY_X402_DECIMALS?.trim();
  const decimals = decimalsText === undefined || decimalsText === "" ? undefined : Number(decimalsText);
  if (decimals !== undefined && (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)) {
    throw new Error("CHAINPAY_X402_DECIMALS must be an integer from 0 to 255");
  }
  const appUrl = assertSafeHttpUrl(env.CHAINPAY_APP_URL?.trim() || DEFAULT_APP_URL, "CHAINPAY_APP_URL")
    .toString()
    .replace(/\/$/, "");
  return {
    requester: identity.seller,
    secretKey: identity.secretKey,
    throwawayKey,
    requesterName: env.CHAINPAY_MERCHANT_NAME?.trim() || "ChainPay demo merchant",
    appUrl,
    description: env.CHAINPAY_MANDATE_REQUEST_DESCRIPTION?.trim() || "Paid API access from the ChainPay demo merchant",
    maxPerPayment,
    total,
    days,
    ...(decimals === undefined ? {} : { decimals }),
  };
}

function poNumber(): string {
  const bytes = new Uint8Array(3);
  globalThis.crypto.getRandomValues(bytes);
  return `PO-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

export async function createMandateRequest(
  settings: MandateRequestSettings,
  config: MerchantConfig,
  deps: MandateRequestDependencies,
  options: { poNumber?: string } = {},
): Promise<CreatedMandateRequest> {
  let currentSlot: bigint;
  let decimals: number;
  try {
    [currentSlot, decimals] = await Promise.all([
      deps.getCurrentSlot(),
      settings.decimals === undefined ? deps.getMintDecimals(config.mint) : Promise.resolve(settings.decimals),
    ]);
  } catch {
    throw new MandateRequestLookupError("Could not read the current slot or the token from Solana. Try again.");
  }
  const payload = buildMandateRequestPayload({
    role: "vendor",
    requester: settings.requester,
    requesterName: settings.requesterName,
    recipient: config.recipient,
    mint: config.mint,
    tokenProgram: config.tokenProgram,
    maxPerPayment: settings.maxPerPayment,
    total: settings.total,
    decimals,
    currentSlot,
    days: settings.days,
    description: settings.description,
    poNumber: options.poNumber ?? poNumber(),
  });
  const request = await signMandateRequest(payload, settings.secretKey);
  return {
    link: encodeMandateRequestLink(request, settings.appUrl),
    summary: mandateRequestSummary(request.payload, currentSlot),
    request,
  };
}

/** One page, no framework, no external assets. ChainPay tokens only. */
export const PAY_WITH_CHAINPAY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pay us with ChainPay</title>
<style>
  :root {
    --blue: #0052ff;
    --ink: #14213d;
    --muted: #5b6478;
    --line: #e3e7ef;
    --surface: #ffffff;
    --page: #f6f8fc;
    --radius: 24px;
    --control: 44px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px 16px;
    background: var(--page);
    color: var(--ink);
    font: 400 16px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main {
    width: 100%;
    max-width: 480px;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 32px 24px;
  }
  h1 { margin: 0 0 8px; font-size: 24px; font-weight: 500; line-height: 1.25; }
  p { margin: 0 0 16px; color: var(--muted); }
  button, a.button {
    min-height: var(--control);
    padding: 0 20px;
    border-radius: var(--radius);
    border: 1px solid var(--blue);
    font-family: inherit;
    font-size: 15px;
    font-weight: 600;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
  }
  .primary { background: var(--blue); color: #ffffff; width: 100%; }
  .secondary { background: var(--surface); color: var(--blue); }
  button:disabled { opacity: 0.6; cursor: progress; }
  button:focus-visible, a.button:focus-visible, input:focus-visible { outline: 3px solid var(--blue); outline-offset: 2px; }
  #result[hidden], #error[hidden] { display: none; }
  #result { margin-top: 24px; border-top: 1px solid var(--line); padding-top: 24px; }
  #summary { color: var(--ink); }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  input {
    width: 100%;
    min-height: var(--control);
    padding: 0 16px;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    color: var(--ink);
    font: 400 14px/1 ui-monospace, "JetBrains Mono", SFMono-Regular, Menlo, monospace;
  }
  .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .note { font-size: 14px; margin: 16px 0 0; }
  #error { color: #b42318; margin: 16px 0 0; }
</style>
</head>
<body>
<main>
  <h1>Pay us with ChainPay</h1>
  <p>Let your agent pay for this API within limits you set. We send you a request; you choose the limits and approve them in your own wallet.</p>
  <button id="request" class="primary" type="button">Request permission</button>
  <p id="error" role="alert" hidden></p>
  <section id="result" aria-live="polite" hidden>
    <p id="summary"></p>
    <label for="link">Request link</label>
    <input id="link" readonly>
    <div class="actions">
      <button id="copy" class="secondary" type="button">Copy link</button>
      <a id="open" class="button secondary" href="#" target="_blank" rel="noopener">Open link</a>
    </div>
    <p class="note">Nothing is charged by this link. The owner who opens it can change every limit before approving.</p>
  </section>
</main>
<script>
  const requestButton = document.getElementById("request");
  const copyButton = document.getElementById("copy");
  const result = document.getElementById("result");
  const error = document.getElementById("error");
  const linkInput = document.getElementById("link");
  requestButton.addEventListener("click", async () => {
    requestButton.disabled = true;
    error.hidden = true;
    try {
      const response = await fetch("/mandate-requests", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not create the request.");
      document.getElementById("summary").textContent = body.summary;
      linkInput.value = body.link;
      document.getElementById("open").href = body.link;
      result.hidden = false;
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : "Could not create the request.";
      error.hidden = false;
    } finally {
      requestButton.disabled = false;
    }
  });
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(linkInput.value);
      copyButton.textContent = "Copied";
    } catch {
      linkInput.select();
      copyButton.textContent = "Press Ctrl+C to copy";
    }
    setTimeout(() => { copyButton.textContent = "Copy link"; }, 2000);
  });
</script>
</body>
</html>
`;
