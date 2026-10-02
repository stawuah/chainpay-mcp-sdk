import {
  decodeMandateRequestLink,
  formatHumanTokenAmount,
  verifyMandateRequest,
  type MandateRequestPayload,
  type SignedMandateRequest,
  type TokenProgram,
} from "@chainpay/sdk";
import type { AgentInboxItem } from "../owner/runtime";
import { formatTokenUnits } from "../receipts/model";

/**
 * A permission request is someone else's signed ask for a spending
 * permission: a vendor's purchase order or a builder's budget request. It
 * arrives as a link, `/app/requests/permission#req=…`. The fragment never
 * reaches a server. Nothing here moves money or signs anything: the owner
 * reviews it in the existing mandate builder and approves there.
 */

export const PERMISSION_REQUEST_SOURCE = "permission-request" as const;

/** Nominal 400 ms slots, the same estimate the requester's CLI uses. Only for "≈ days" labels. */
const NOMINAL_SLOTS_PER_DAY = 216_000n;

export type PermissionRequestCheck =
  | { status: "valid"; signed: SignedMandateRequest; requestHash: string; checkedAtSlot?: string }
  | { status: "invalid"; reason: string; requestHash: string };

/** What the inbox keeps for a permission request. Lives in this browser only. */
export type PermissionRequestRecord = {
  /** Present only when the signature verified. */
  signed?: SignedMandateRequest;
  requestHash: string;
  valid: boolean;
  reason?: string;
  /** Slot used for the expiry check, when it could be read. */
  checkedAtSlot?: string;
  /** Set once the owner created a permission from this request. */
  mandateAddress?: string;
  /** Whether the relay linked the request to that permission. */
  link?: "linked" | "failed";
  linkError?: string;
};

export function shortKey(value: string): string {
  return value.length < 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** The `req=` value from a location hash, or null. Other hash keys are ignored. */
export function requestFragmentFromHash(hash: string): string | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of raw.split("&")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index) === "req" && part.slice(index + 1)) return part.slice(index + 1);
  }
  return null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Check the request against the active Devnet app before any wallet approval. */
function assertRequestContext(payload: MandateRequestPayload, currentSlot?: bigint | null): void {
  if (payload.cluster !== "devnet") throw new Error("This request is for a different Solana cluster. ChainPay uses Devnet.");
  if (currentSlot == null) throw new Error("Request expiry could not be checked. Reopen the link when the network is available.");
  if (payload.validUntilSlot !== undefined && BigInt(payload.validUntilSlot) <= currentSlot) throw new Error("This request link has expired");
  if (payload.suggestedExpirySlot !== undefined && BigInt(payload.suggestedExpirySlot) <= currentSlot) throw new Error("The requested permission expiry has passed");
}

/** Recheck persisted requests with a fresh slot immediately before approval. */
export async function validatePermissionRequestForApproval(signed: SignedMandateRequest, currentSlot?: bigint | null): Promise<void> {
  const verification = await verifyMandateRequest(signed);
  if (!verification.valid) throw new Error(verification.reason ?? "This request did not verify");
  assertRequestContext(verification.payload, currentSlot);
}

/**
 * Decode and verify a request link. With a current slot, an expired link is
 * refused. A link that cannot be read still gets a stable id (the hash of the
 * raw fragment) so opening it twice shows one blocked item, not two.
 */
export async function checkPermissionRequestLink(
  fragment: string,
  currentSlot?: bigint | null,
): Promise<PermissionRequestCheck> {
  let signed: SignedMandateRequest;
  try {
    signed = decodeMandateRequestLink(`#req=${fragment}`);
  } catch (error) {
    return {
      status: "invalid",
      reason: error instanceof Error ? error.message : "This request link could not be read",
      requestHash: `link-${await sha256Hex(fragment)}`,
    };
  }
  const slot = currentSlot ?? undefined;
  const verification = await verifyMandateRequest(signed, slot);
  const requestHash = verification.requestHash || `link-${await sha256Hex(fragment)}`;
  if (!verification.valid) {
    return { status: "invalid", reason: verification.reason ?? "This request did not verify", requestHash };
  }
  try {
    assertRequestContext(verification.payload, currentSlot);
  } catch (error) {
    return { status: "invalid", requestHash, reason: error instanceof Error ? error.message : "This request could not be checked" };
  }
  return {
    status: "valid",
    signed: { payload: verification.payload, signature: signed.signature },
    requestHash,
    ...(slot === undefined ? {} : { checkedAtSlot: slot.toString() }),
  };
}

export function requesterLabel(payload: Pick<MandateRequestPayload, "requester" | "requesterName">): string {
  return payload.requesterName ?? shortKey(payload.requester);
}

export function roleLabel(role: MandateRequestPayload["role"]): string {
  return role === "vendor" ? "Purchase order" : "Budget request";
}

/** "PO-1042" when the request names one, otherwise its description. */
export function requestReference(payload: Pick<MandateRequestPayload, "poNumber" | "description">): string {
  return payload.poNumber ?? payload.description;
}

export function permissionRequestTitle(record: PermissionRequestRecord): string {
  if (!record.valid || !record.signed) return "Permission request could not be checked";
  return `${requesterLabel(record.signed.payload)} asks for a spending permission`;
}

export function inboxIdForRequest(requestHash: string): string {
  return `${PERMISSION_REQUEST_SOURCE}:${requestHash}`;
}

export function permissionRequestInboxItem(check: PermissionRequestCheck, now = new Date()): AgentInboxItem {
  const record: PermissionRequestRecord = check.status === "valid"
    ? {
        signed: check.signed,
        requestHash: check.requestHash,
        valid: true,
        ...(check.checkedAtSlot ? { checkedAtSlot: check.checkedAtSlot } : {}),
      }
    : { requestHash: check.requestHash, valid: false, reason: check.reason };
  return {
    id: inboxIdForRequest(check.requestHash),
    createdAt: now.toISOString(),
    source: PERMISSION_REQUEST_SOURCE,
    title: permissionRequestTitle(record),
    prompt: "",
    response: record.valid
      ? "Review the requested limits before creating a spending permission. Nothing moves until you approve in your wallet."
      : `Blocked: ${record.reason}.`,
    stage: record.valid ? "waiting_for_approval" : "blocked",
    toolCalls: [],
    attachments: [],
    permissionRequest: record,
  };
}

/**
 * Add a request to the inbox, one item per request hash. Opening the same
 * link again refreshes an open item (for example, it has since expired) and
 * brings back one the owner declined. A request that already became a
 * permission stays as it is.
 */
export function upsertPermissionRequest(items: AgentInboxItem[], incoming: AgentInboxItem): AgentInboxItem[] {
  const existing = items.find((item) => item.id === incoming.id);
  if (!existing) return [incoming, ...items];
  if (existing.permissionRequest?.mandateAddress) return items;
  const merged: AgentInboxItem = {
    ...existing,
    title: incoming.title,
    response: incoming.response,
    stage: incoming.stage,
    permissionRequest: incoming.permissionRequest,
    archivedAt: undefined,
  };
  return [merged, ...items.filter((item) => item.id !== incoming.id)];
}

/** Decline: archived in this browser. Nothing is sent to the requester. */
export function declinePermissionRequest(items: AgentInboxItem[], id: string, now = new Date()): AgentInboxItem[] {
  return items.map((item) => item.id === id ? { ...item, archivedAt: now.toISOString() } : item);
}

/** After the mandate is created: completed, with the relay link outcome. */
export function completePermissionRequest(
  items: AgentInboxItem[],
  requestHash: string,
  mandateAddress: string,
  link: "linked" | "failed",
  linkError?: string,
): AgentInboxItem[] {
  const id = inboxIdForRequest(requestHash);
  return items.map((item) => {
    if (item.id !== id || !item.permissionRequest) return item;
    const reference = item.permissionRequest.signed ? requestReference(item.permissionRequest.signed.payload) : "";
    return {
      ...item,
      stage: "approved",
      response: link === "linked"
        ? `Permission created · linked to ${reference}`
        : "Permission created. Linking it to the request failed; the permission exists.",
      permissionRequest: {
        ...item.permissionRequest,
        mandateAddress,
        link,
        ...(linkError ? { linkError } : { linkError: undefined }),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// The request card
// ---------------------------------------------------------------------------

export type PermissionRequestRow = { key: string; label: string; value: string; mono?: boolean };

export type PermissionRequestCardView =
  | {
      status: "valid";
      kicker: "PERMISSION REQUEST";
      title: string;
      roleLabel: string;
      statedName?: string;
      requester: string;
      rows: PermissionRequestRow[];
    }
  | { status: "invalid"; kicker: "PERMISSION REQUEST"; title: string; reason: string };

/** "≈ 30 days" from a slot, estimated from nominal 400 ms slots. */
export function approxDaysFromSlot(slot: string | undefined, currentSlot: string | undefined): string | null {
  if (!slot || !currentSlot || !/^\d+$/.test(slot) || !/^\d+$/.test(currentSlot)) return null;
  const remaining = BigInt(slot) - BigInt(currentSlot);
  if (remaining <= 0n) return "already passed";
  const days = (remaining + NOMINAL_SLOTS_PER_DAY / 2n) / NOMINAL_SLOTS_PER_DAY;
  if (days === 0n) return "≈ less than a day";
  return days === 1n ? "≈ 1 day" : `≈ ${days} days`;
}

export function requestAmount(baseUnits: string, payload: Pick<MandateRequestPayload, "decimals">, symbol: string): string {
  return formatTokenUnits(baseUnits, payload.decimals, symbol);
}

export function permissionRequestCard(record: PermissionRequestRecord, symbolFor: (mint: string) => string): PermissionRequestCardView {
  if (!record.valid || !record.signed) {
    return {
      status: "invalid",
      kicker: "PERMISSION REQUEST",
      title: "This permission request can’t be used",
      reason: record.reason ?? "The request did not verify",
    };
  }
  const payload = record.signed.payload;
  const symbol = symbolFor(payload.mint);
  const expiry = payload.suggestedExpirySlot
    ? approxDaysFromSlot(payload.suggestedExpirySlot, record.checkedAtSlot) ?? `Slot ${payload.suggestedExpirySlot}`
    : "Not suggested";
  const rows: PermissionRequestRow[] = [
    { key: "token", label: "Token", value: symbol },
    { key: "per-payment", label: "Suggested per payment", value: requestAmount(payload.suggestedMaxPerPayment, payload, symbol) },
    { key: "total", label: "Suggested total", value: requestAmount(payload.suggestedTotal, payload, symbol) },
    { key: "expiry", label: "Expiry", value: expiry },
    payload.role === "vendor"
      ? { key: "payee", label: "Expected payee", value: payload.recipient ?? "", mono: true }
      : { key: "agent", label: "Agent that will sign", value: payload.agent ?? "", mono: true },
    { key: "description", label: "Description", value: payload.description },
  ];
  if (payload.poNumber) rows.push({ key: "po", label: "PO number", value: payload.poNumber });
  return {
    status: "valid",
    kicker: "PERMISSION REQUEST",
    title: `${requesterLabel(payload)} asks for a spending permission`,
    roleLabel: payload.role === "vendor" ? `Purchase order${payload.poNumber ? ` ${payload.poNumber}` : ""}` : "Budget request",
    ...(payload.requesterName ? { statedName: payload.requesterName } : {}),
    requester: payload.requester,
    rows,
  };
}

// ---------------------------------------------------------------------------
// Builder prefill
// ---------------------------------------------------------------------------

export type MandatePrefill = {
  request: SignedMandateRequest;
  requestHash: string;
  role: MandateRequestPayload["role"];
  mint: string;
  tokenProgram: TokenProgram;
  decimals: number;
  /** Grantee only: the approved agent is fixed to this key. */
  agent?: string;
  /** Vendor only: checked at match, not enforced on chain. */
  expectedPayee?: string;
  /** Whole tokens, exact. */
  maxPerPayment: string;
  totalLimit: string;
  expiresAtSlot?: string;
  /** PO number, else the description. */
  reference: string;
  requester: string;
};

export function prefillFromRequest(signed: SignedMandateRequest, requestHash: string): MandatePrefill {
  const payload = signed.payload;
  return {
    request: signed,
    requestHash,
    role: payload.role,
    mint: payload.mint,
    tokenProgram: payload.tokenProgram,
    decimals: payload.decimals,
    ...(payload.role === "grantee" && payload.agent ? { agent: payload.agent } : {}),
    ...(payload.role === "vendor" && payload.recipient ? { expectedPayee: payload.recipient } : {}),
    maxPerPayment: formatHumanTokenAmount(payload.suggestedMaxPerPayment, payload.decimals),
    totalLimit: formatHumanTokenAmount(payload.suggestedTotal, payload.decimals),
    ...(payload.suggestedExpirySlot ? { expiresAtSlot: payload.suggestedExpirySlot } : {}),
    reference: requestReference(payload),
    requester: payload.requester,
  };
}

/**
 * The prefill is held in memory between "Review permission" and the builder,
 * because navigation drops the URL fragment. It is not written to storage.
 */
let pendingPrefill: MandatePrefill | null = null;

export function setMandatePrefill(prefill: MandatePrefill | null): void {
  pendingPrefill = prefill;
}

export function peekMandatePrefill(): MandatePrefill | null {
  return pendingPrefill;
}

export function clearMandatePrefill(): void {
  pendingPrefill = null;
}

export type SigningMode = "human" | "delegated" | "requester";

export type BuilderSeed<Form> = {
  source: "request" | "draft" | "defaults";
  form: Form;
  signingMode: SigningMode;
  slotEdited: boolean;
};

const EXPIRY_CHOICES = ["1", "7", "30", "90"] as const;

/** The nearest of the builder's day choices, for a request's exact expiry slot. */
export function nearestExpiryChoice(expiresAtSlot: string | undefined, currentSlot: string | undefined): string {
  if (!expiresAtSlot || !currentSlot || !/^\d+$/.test(expiresAtSlot) || !/^\d+$/.test(currentSlot)) return "7";
  const remaining = BigInt(expiresAtSlot) - BigInt(currentSlot);
  if (remaining <= 0n) return "1";
  const days = Number(remaining / NOMINAL_SLOTS_PER_DAY);
  let best: string = EXPIRY_CHOICES[0];
  for (const choice of EXPIRY_CHOICES) {
    if (Math.abs(Number(choice) - days) < Math.abs(Number(best) - days)) best = choice;
  }
  return best;
}

type SeedForm = {
  approvedAgent: string;
  allowedMint: string;
  maxPerPayment: string;
  totalLimit: string;
  expiresInDays: string;
  expiresAtSlot: string;
  tokenProgram: TokenProgram;
};

/**
 * Where the builder starts. A request prefill wins over the per-wallet draft,
 * which wins over the defaults. A grantee request fixes the approval method to
 * "Requester's agent signs" with the request's agent key.
 */
export function seedMandateBuilder<Form extends SeedForm>(input: {
  wallet: string;
  defaults: Form;
  draft?: { form: Form; signingMode: "human" | "delegated"; slotEdited: boolean } | null;
  prefill?: MandatePrefill | null;
  currentSlot?: string;
}): BuilderSeed<Form> {
  const { prefill, draft, defaults, wallet } = input;
  if (prefill) {
    return {
      source: "request",
      form: {
        ...defaults,
        approvedAgent: prefill.role === "grantee" && prefill.agent ? prefill.agent : wallet,
        allowedMint: prefill.mint,
        tokenProgram: prefill.tokenProgram,
        maxPerPayment: prefill.maxPerPayment,
        totalLimit: prefill.totalLimit,
        expiresInDays: nearestExpiryChoice(prefill.expiresAtSlot, input.currentSlot),
        expiresAtSlot: prefill.expiresAtSlot ?? "",
      },
      signingMode: prefill.role === "grantee" ? "requester" : "human",
      // An exact requested expiry is kept as the slot, not re-estimated from days.
      slotEdited: Boolean(prefill.expiresAtSlot),
    };
  }
  if (draft) return { source: "draft", form: draft.form, signingMode: draft.signingMode, slotEdited: draft.slotEdited };
  return { source: "defaults", form: defaults, signingMode: "human", slotEdited: false };
}

export type ApprovalOption = { value: SigningMode; label: string; description: string; disabled: boolean };

/**
 * Step 1 choices. "Requester's agent signs" exists only for a budget request,
 * where it is preselected and the other two are disabled. A purchase order
 * leaves the owner's normal choice.
 */
export function approvalOptions(prefill: MandatePrefill | null | undefined): ApprovalOption[] {
  const fixed = prefill?.role === "grantee";
  const options: ApprovalOption[] = [
    { value: "human", label: "Approve each payment", description: "Review and approve every payment in your wallet.", disabled: fixed },
    { value: "delegated", label: "Automatic payments", description: "Approve the permission once. Payments use a secure signer within your limits. Requires signer setup and network-fee funding.", disabled: fixed },
  ];
  if (fixed && prefill?.agent) {
    options.push({
      value: "requester",
      label: "Requester’s agent signs",
      description: `The budget request names agent ${shortKey(prefill.agent)}. It signs payments with its own key, only within the limits you set.`,
      disabled: false,
    });
  }
  return options;
}

function toBaseUnits(value: string, decimals: number): bigint | null {
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** True when the owner typed more than the request asked for. Neutral note, never a block. */
export function isAboveRequested(value: string, requestedBaseUnits: string, decimals: number): boolean {
  const chosen = toBaseUnits(value, decimals);
  return chosen !== null && chosen > BigInt(requestedBaseUnits);
}

export function requestedHelper(requestedBaseUnits: string, decimals: number, symbol: string): string {
  return `Requested: ${formatTokenUnits(requestedBaseUnits, decimals, symbol)}`;
}

export type ReviewRow = { key: string; label: string; value: string; helper?: string; mono?: boolean };

/**
 * Review rows a request adds or changes. A limit shows "(requested X)" only
 * when the chosen value differs from the request.
 */
export function requestReviewRows(input: {
  prefill: MandatePrefill;
  chosen: { maxPerPayment: string; totalLimit: string; expiresAtSlot: string };
  symbol: string;
  expiryLabel: (slot: string) => string;
}): { from: ReviewRow; maxPerPayment: ReviewRow; totalLimit: ReviewRow; expires: ReviewRow; payee?: ReviewRow } {
  const { prefill, chosen, symbol } = input;
  const payload = prefill.request.payload;
  const amountRow = (key: string, label: string, value: string, requested: string): ReviewRow => {
    const units = toBaseUnits(value, prefill.decimals);
    const display = units === null ? value : formatTokenUnits(units.toString(), prefill.decimals, symbol);
    const differs = units === null || units.toString() !== requested;
    return { key, label, value: differs ? `${display} (requested ${formatTokenUnits(requested, prefill.decimals, symbol)})` : display };
  };
  const expiresValue = input.expiryLabel(chosen.expiresAtSlot);
  const expiryDiffers = Boolean(prefill.expiresAtSlot) && chosen.expiresAtSlot.trim() !== prefill.expiresAtSlot;
  return {
    from: {
      key: "from-request",
      label: "From request",
      value: `${prefill.reference} · ${shortKey(prefill.requester)}`,
    },
    maxPerPayment: amountRow("max-per-payment", "Max per payment", chosen.maxPerPayment, payload.suggestedMaxPerPayment),
    totalLimit: amountRow("total-limit", "Total spend limit", chosen.totalLimit, payload.suggestedTotal),
    expires: {
      key: "expires",
      label: "Expires",
      value: expiryDiffers && prefill.expiresAtSlot ? `${expiresValue} (requested ${input.expiryLabel(prefill.expiresAtSlot)})` : expiresValue,
    },
    ...(prefill.role === "vendor" && prefill.expectedPayee
      ? {
          payee: {
            key: "expected-payee",
            label: "Expected payee",
            value: prefill.expectedPayee,
            helper: "Payments to anyone else are flagged on the receipt, not blocked by Solana.",
            mono: true,
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Linking the accepted request to the new mandate
// ---------------------------------------------------------------------------

export type LinkResult = { status: "linked" } | { status: "failed"; reason: string };

/**
 * PUT the signed request against the mandate it became. The mandate already
 * exists whatever happens here; a failure only means the link is missing and
 * can be retried.
 */
export async function linkMandateRequest(
  fetcher: (path: string, init: RequestInit) => Promise<Response>,
  mandateAddress: string,
  signed: SignedMandateRequest,
): Promise<LinkResult> {
  try {
    const response = await fetcher(`/v1/mandates/${encodeURIComponent(mandateAddress)}/request`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: signed.payload, signature: signed.signature }),
    });
    if (response.ok) return { status: "linked" };
    let reason = `The relay answered HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: unknown; message?: unknown };
      const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "";
      if (message) reason = message;
    } catch {
      // Keep the status line.
    }
    return { status: "failed", reason };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : "The relay could not be reached" };
  }
}

export function linkStatusCopy(reference: string, state: "linking" | LinkResult): string {
  if (state === "linking") return `Permission created · linking to ${reference}…`;
  if (state.status === "linked") return `Permission created · linked to ${reference}`;
  return `The permission exists. Linking it to ${reference} failed: ${state.reason}.`;
}
