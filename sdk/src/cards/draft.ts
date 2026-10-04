import { MAX_BUDGET_CENTS, MAX_FEE_BPS, MAX_MCCS, MAX_MERCHANTS } from "./constants.js";
import { centsToString, maxObligationCents, parseCents } from "./math.js";
import { cardMerchantByRef } from "./merchants.js";
import { redactCardNumbersInInput } from "./redact.js";

/*
 * A card draft is what an agent may propose: label, budget, cap, shops and
 * categories. It is not a card. It goes to the owner's dashboard in the URL
 * fragment (never sent to a server), the owner reviews the exact numbers,
 * and only the owner's wallet can turn it into `init_card` + `set_policy`.
 */

export type CardDraft = {
  v: 1;
  label: string;
  budgetCents: string;
  maxPurchaseCents: string;
  /** Registered merchant references (Axum resolves each to an acceptor-id hash). */
  merchants: string[];
  mccs: number[];
  periodDays: number;
  /** ISO time or null for no expiry. */
  expiresAt: string | null;
  feeBps: number;
};

export type CardDraftInput = {
  label: unknown;
  budgetCents: unknown;
  maxPurchaseCents: unknown;
  merchants?: unknown;
  mccs?: unknown;
  periodDays: unknown;
  expiresAt?: unknown;
  feeBps?: unknown;
};

/** ChainPay's displayed platform fee when a draft doesn't name one (contracts.md §1.5 example). */
export const DEFAULT_CARD_FEE_BPS = 50;
export const MAX_PERIOD_DAYS = 365;
const MERCHANT_REF = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Validate and normalize an agent-proposed draft. Throws plain-language errors. */
export function normalizeCardDraft(input: CardDraftInput, now = Date.now()): CardDraft {
  if (typeof input.label !== "string" || !input.label.trim() || input.label.trim().length > 40) throw new Error("label must be 1-40 characters");
  const budget = parseCents(input.budgetCents, "budgetCents");
  const maxPurchase = parseCents(input.maxPurchaseCents, "maxPurchaseCents");
  if (budget <= 0n) throw new Error("Budget must be more than $0");
  if (budget > MAX_BUDGET_CENTS) throw new Error("Budget can't be more than $10,000 in the sandbox");
  if (maxPurchase <= 0n || maxPurchase > budget) throw new Error("Max purchase must be more than $0 and no more than the budget");
  const merchants = input.merchants === undefined ? [] : input.merchants;
  const mccs = input.mccs === undefined ? [] : input.mccs;
  if (!Array.isArray(merchants) || !merchants.every((ref) => typeof ref === "string" && MERCHANT_REF.test(ref))) throw new Error("merchants must be a list of merchant references");
  if (!Array.isArray(mccs) || !mccs.every((mcc) => Number.isInteger(mcc) && mcc >= 0 && mcc <= 9_999)) throw new Error("mccs must be a list of 4-digit merchant category codes");
  if (merchants.length === 0 && mccs.length === 0) throw new Error("Pick at least one shop or merchant category");
  // A shop ChainPay can't check out at would make the owner's review link dead
  // on arrival, so the draft is never "ready" with one (review F8).
  const unknown = (merchants as string[]).filter((ref) => !cardMerchantByRef(ref));
  if (unknown.length) throw new Error(`${unknown.map((ref) => `"${redactCardNumbersInInput(ref)}"`).join(", ")} ${unknown.length === 1 ? "isn't a shop" : "aren't shops"} ChainPay can check out at`);
  if (merchants.length > MAX_MERCHANTS) throw new Error(`At most ${MAX_MERCHANTS} shops`);
  if (mccs.length > MAX_MCCS) throw new Error(`At most ${MAX_MCCS} merchant categories`);
  if (new Set(merchants).size !== merchants.length) throw new Error("A shop is listed twice");
  if (new Set(mccs).size !== mccs.length) throw new Error("A merchant category is listed twice");
  if (!Number.isInteger(input.periodDays) || (input.periodDays as number) < 1 || (input.periodDays as number) > MAX_PERIOD_DAYS) throw new Error(`periodDays must be a whole number from 1 to ${MAX_PERIOD_DAYS}`);
  const feeBps = input.feeBps === undefined ? DEFAULT_CARD_FEE_BPS : input.feeBps;
  if (!Number.isInteger(feeBps) || (feeBps as number) < 0 || (feeBps as number) > MAX_FEE_BPS) throw new Error("feeBps must be a whole number from 0 to 1000");
  let expiresAt: string | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const ms = typeof input.expiresAt === "string" ? Date.parse(input.expiresAt) : Number.NaN;
    if (Number.isNaN(ms)) throw new Error("expiresAt must be an ISO date");
    if (ms <= now) throw new Error("expiresAt must be in the future");
    expiresAt = new Date(ms).toISOString();
  }
  return {
    v: 1,
    label: input.label.trim(),
    budgetCents: centsToString(budget),
    maxPurchaseCents: centsToString(maxPurchase),
    merchants: [...(merchants as string[])],
    mccs: [...(mccs as number[])],
    periodDays: input.periodDays as number,
    expiresAt,
    feeBps: feeBps as number,
  };
}

function canonical(draft: CardDraft): string {
  return JSON.stringify([draft.v, draft.label, draft.budgetCents, draft.maxPurchaseCents, draft.merchants, draft.mccs, draft.periodDays, draft.expiresAt, draft.feeBps]);
}

/** hex sha256("chainpay-card-draft:v1\n" || canonical draft). The dashboard recomputes it before showing the review. */
export async function cardDraftDigest(draft: CardDraft): Promise<string> {
  const bytes = new TextEncoder().encode(`chainpay-card-draft:v1\n${canonical(draft)}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cardDraftMaxObligationCents(draft: CardDraft): string {
  return centsToString(maxObligationCents(BigInt(draft.budgetCents), draft.feeBps));
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const binary = globalThis.atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/** `${app}/app/cards/new#draft=<base64url(JSON)>`. The fragment never reaches a server. */
export function encodeCardDraftLink(draft: CardDraft, appBaseUrl: string): string {
  const origin = appBaseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(origin)) throw new Error("App URL must be http(s)");
  return `${origin}/app/cards/new#draft=${toBase64Url(JSON.stringify(draft))}`;
}

export function decodeCardDraftFragment(fragment: string, now = Date.now()): CardDraft {
  const match = fragment.match(/(?:^#?|&)draft=([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("No card draft in this link");
  const raw = JSON.parse(fromBase64Url(match[1])) as Record<string, unknown>;
  if (raw.v !== 1) throw new Error("Unsupported card draft version");
  return normalizeCardDraft(raw as CardDraftInput, now);
}

/** Review link with the draft digest alongside: `…/app/cards/new#draft=…&digest=<hex>`. */
export async function encodeCardDraftReviewLink(draft: CardDraft, appBaseUrl: string): Promise<string> {
  return `${encodeCardDraftLink(draft, appBaseUrl)}&digest=${await cardDraftDigest(draft)}`;
}

export type CardDraftIntake =
  | { status: "matched"; draft: CardDraft; digest: string }
  | { status: "mismatch"; digest: string; expected: string }
  | { status: "missing_digest"; digest: string }
  | { status: "invalid"; reason: string };

/**
 * Dashboard intake for an agent's review link. The draft is only usable when
 * the digest in the link equals the digest recomputed here; otherwise the
 * caller must leave the form empty.
 */
export async function verifyCardDraftFragment(fragment: string, now = Date.now()): Promise<CardDraftIntake> {
  let draft: CardDraft;
  try {
    draft = decodeCardDraftFragment(fragment, now);
  } catch (error) {
    return { status: "invalid", reason: error instanceof Error ? error.message : "This link can't be read" };
  }
  const digest = await cardDraftDigest(draft);
  const claimed = fragment.match(/(?:^#?|&)digest=([0-9a-f]{64})(?:&|$)/)?.[1];
  if (!claimed) return { status: "missing_digest", digest };
  if (claimed !== digest) return { status: "mismatch", digest, expected: claimed };
  return { status: "matched", draft, digest };
}
