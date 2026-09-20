import type { ChainPayClient } from "./client.js";
import { formatExactTokenAmount } from "./receipt.js";
import type { Address, Mandate, MandateStatus, PaymentReceipt, PaymentStatus } from "./types.js";

/** Known Devnet demonstration mints. Unknown mints stay "tokens". */
const TOKEN_LABELS: Record<string, string> = {
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": "USDC",
  "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM": "PYUSD",
};

export const DEFAULT_RECEIPT_LIMIT = 10;

export type OpsAttentionKind = "expiring_soon" | "paused" | "exhausted" | "revoked";

export type OpsMintTotal = {
  mint: Address;
  symbol: string;
  decimals: number | null;
  spent: string;
  remaining: string;
  spentBase: string;
  remainingBase: string;
};

export type OpsMandateRow = {
  address: Address;
  status: MandateStatus;
  mint: Address;
  symbol: string;
  decimals: number | null;
  spent: string;
  remaining: string;
  totalLimit: string;
  maxPerPayment: string;
  spentBase: string;
  remainingBase: string;
  totalLimitBase: string;
  maxPerPaymentBase: string;
  expiresAtSlot: string;
  approvedAgent: Address;
};

export type OpsReceiptRow = {
  address: Address;
  mandate: Address;
  amount: string;
  amountBase: string;
  symbol: string;
  decimals: number | null;
  status: PaymentStatus;
  executedAtSlot: string;
  recipientTokenAccount: Address;
  receiptUrl?: string;
};

export type OpsAttentionItem = {
  kind: OpsAttentionKind;
  mandate: Address;
  detail: string;
};

export type OpsSnapshot = {
  kind: "spend_overview";
  owner: Address;
  totals: OpsMintTotal[];
  mandates: OpsMandateRow[];
  receipts: OpsReceiptRow[];
  attention: OpsAttentionItem[];
  note: string;
};

export type OpsReceiptList = {
  kind: "receipt_list";
  owner: Address;
  count: number;
  receipts: OpsReceiptRow[];
};

export type PaymentLookupCard = {
  kind: "payment_lookup";
  found: boolean;
  receiptAddress?: Address;
  amount?: string;
  symbol?: string;
  status?: string;
  signature?: string;
  mandate?: Address;
  receiptUrl?: string;
};

export type LoadOpsSnapshotInput = {
  owner: Address;
  mandateFilter?: readonly Address[];
  receiptLimit?: number;
  appUrl?: string;
  currentSlot?: bigint;
  expiringSoonSlots?: bigint;
};

export function tokenLabel(mint: Address): string {
  return TOKEN_LABELS[mint] ?? "tokens";
}

export function shortAddress(value: string | undefined): string {
  if (!value || value.length < 12) return value ?? "unknown";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function receiptUrlForAddress(receiptAddress: string | undefined, appUrl?: string): string | undefined {
  if (!receiptAddress) return undefined;
  const origin = appUrl?.trim().replace(/\/$/, "");
  if (!origin) return undefined;
  return `${origin}/verify/${encodeURIComponent(receiptAddress)}`;
}

export function humanTokenAmount(amount: bigint, decimals: number | null): {
  display: string;
  base: string;
  decimals: number | null;
} {
  const exact = formatExactTokenAmount(amount, decimals);
  let display = exact.display;
  if (exact.displayKind === "ui-amount" && display.includes(".")) {
    display = display.replace(/0+$/, "").replace(/\.$/, "");
  }
  return { display, base: exact.baseUnits, decimals: exact.decimals };
}

function remainingBase(mandate: Mandate): bigint {
  return mandate.totalLimit > mandate.amountSpent ? mandate.totalLimit - mandate.amountSpent : 0n;
}

export function buildOpsSnapshot(input: {
  owner: Address;
  mandates: Mandate[];
  receipts: PaymentReceipt[];
  decimalsByMint: Record<string, number | null>;
  currentSlot?: bigint;
  appUrl?: string;
  receiptLimit?: number;
  expiringSoonSlots?: bigint;
}): OpsSnapshot {
  const receiptLimit = input.receiptLimit ?? DEFAULT_RECEIPT_LIMIT;
  const soon = input.expiringSoonSlots;
  const mandates = input.mandates.map((mandate) => {
    const decimals = input.decimalsByMint[mandate.allowedMint] ?? null;
    const symbol = tokenLabel(mandate.allowedMint);
    const remaining = remainingBase(mandate);
    const spent = humanTokenAmount(mandate.amountSpent, decimals);
    const remain = humanTokenAmount(remaining, decimals);
    const limit = humanTokenAmount(mandate.totalLimit, decimals);
    const cap = humanTokenAmount(mandate.maxPerPayment, decimals);
    return {
      address: mandate.address,
      status: mandate.status,
      mint: mandate.allowedMint,
      symbol,
      decimals,
      spent: spent.display,
      remaining: remain.display,
      totalLimit: limit.display,
      maxPerPayment: cap.display,
      spentBase: spent.base,
      remainingBase: remain.base,
      totalLimitBase: limit.base,
      maxPerPaymentBase: cap.base,
      expiresAtSlot: mandate.expiresAtSlot.toString(),
      approvedAgent: mandate.approvedAgent,
    } satisfies OpsMandateRow;
  });

  const mints = [...new Set(input.mandates.map((mandate) => mandate.allowedMint))];
  const totals = mints.map((mint) => {
    const matching = input.mandates.filter((mandate) => mandate.allowedMint === mint);
    const spent = matching.reduce((sum, mandate) => sum + mandate.amountSpent, 0n);
    const remaining = matching
      .filter((mandate) => mandate.status === "active")
      .reduce((sum, mandate) => sum + remainingBase(mandate), 0n);
    const decimals = input.decimalsByMint[mint] ?? null;
    const spentAmt = humanTokenAmount(spent, decimals);
    const remainAmt = humanTokenAmount(remaining, decimals);
    return {
      mint,
      symbol: tokenLabel(mint),
      decimals,
      spent: spentAmt.display,
      remaining: remainAmt.display,
      spentBase: spentAmt.base,
      remainingBase: remainAmt.base,
    } satisfies OpsMintTotal;
  });

  const receipts = [...input.receipts]
    .sort((left, right) => (right.executedAtSlot > left.executedAtSlot ? 1 : right.executedAtSlot < left.executedAtSlot ? -1 : 0))
    .slice(0, receiptLimit)
    .map((receipt) => {
      const decimals = input.decimalsByMint[receipt.mint] ?? null;
      const amount = humanTokenAmount(receipt.amount, decimals);
      const receiptUrl = receiptUrlForAddress(receipt.address, input.appUrl);
      return {
        address: receipt.address,
        mandate: receipt.mandate,
        amount: amount.display,
        amountBase: amount.base,
        symbol: tokenLabel(receipt.mint),
        decimals,
        status: receipt.status,
        executedAtSlot: receipt.executedAtSlot.toString(),
        recipientTokenAccount: receipt.recipientTokenAccount,
        ...(receiptUrl ? { receiptUrl } : {}),
      } satisfies OpsReceiptRow;
    });

  const attention: OpsAttentionItem[] = [];
  for (const mandate of input.mandates) {
    if (mandate.status === "paused") {
      attention.push({
        kind: "paused",
        mandate: mandate.address,
        detail: "Paused — the agent cannot spend until the owner resumes this permission.",
      });
    } else if (mandate.status === "revoked") {
      attention.push({
        kind: "revoked",
        mandate: mandate.address,
        detail: "Revoked — settled receipts remain; the agent cannot spend.",
      });
    } else if (mandate.status === "active" && remainingBase(mandate) === 0n && mandate.totalLimit > 0n) {
      attention.push({
        kind: "exhausted",
        mandate: mandate.address,
        detail: "Remaining allowance is 0. The agent cannot spend more on this permission.",
      });
    } else if (
      mandate.status === "active"
      && input.currentSlot !== undefined
      && soon !== undefined
      && mandate.expiresAtSlot > input.currentSlot
      && mandate.expiresAtSlot - input.currentSlot <= soon
    ) {
      attention.push({
        kind: "expiring_soon",
        mandate: mandate.address,
        detail: "Expires within about a day (slot estimate).",
      });
    }
  }

  return {
    kind: "spend_overview",
    owner: input.owner,
    totals,
    mandates,
    receipts,
    attention,
    note: "Totals are mandate allowances, not wallet balance. Inbox requests stay in the dashboard until they settle on-chain.",
  };
}

export async function loadOpsSnapshot(
  client: ChainPayClient,
  options: LoadOpsSnapshotInput,
): Promise<OpsSnapshot> {
  const owner = options.owner;
  const loaded = await client.getMandatesByOwner(owner);
  const mandates = options.mandateFilter
    ? loaded.filter((mandate) => options.mandateFilter!.includes(mandate.address))
    : loaded;
  const receipts = (await Promise.all(mandates.map((mandate) => client.getPaymentsByMandate(mandate.address)))).flat();
  const mints = [...new Set([
    ...mandates.map((mandate) => mandate.allowedMint),
    ...receipts.map((receipt) => receipt.mint),
  ])];
  const decimalsByMint: Record<string, number | null> = {};
  await Promise.all(mints.map(async (mint) => {
    try {
      decimalsByMint[mint] = await client.getMintDecimals(mint);
    } catch {
      decimalsByMint[mint] = null;
    }
  }));
  const currentSlot = options.currentSlot ?? await client.getCurrentSlot().catch(() => undefined);
  return buildOpsSnapshot({
    owner,
    mandates,
    receipts,
    decimalsByMint,
    currentSlot,
    appUrl: options.appUrl,
    receiptLimit: options.receiptLimit,
    expiringSoonSlots: options.expiringSoonSlots,
  });
}

export function receiptListFromSnapshot(snapshot: OpsSnapshot): OpsReceiptList {
  return {
    kind: "receipt_list",
    owner: snapshot.owner,
    count: snapshot.receipts.length,
    receipts: snapshot.receipts,
  };
}

export function formatOpsMarkdown(snapshot: OpsSnapshot): string {
  if (snapshot.mandates.length === 0) {
    return [
      "**No spending permissions found** for this wallet on ChainPay Devnet.",
      "",
      snapshot.note,
      "",
      "**Next step:** Create a mandate in the ChainPay dashboard, then reconnect the agent.",
    ].join("\n");
  }

  const lines = ["**Spending overview**", ""];
  if (snapshot.totals.length) {
    lines.push("**Totals (mandate allowance, not wallet balance)**");
    for (const total of snapshot.totals) {
      lines.push(`- **${total.spent} ${total.symbol}** spent · **${total.remaining} ${total.symbol}** remaining`);
    }
    lines.push("");
  }

  lines.push(`**${snapshot.mandates.length} permission${snapshot.mandates.length === 1 ? "" : "s"}**`);
  snapshot.mandates.forEach((mandate, index) => {
    lines.push(
      `${index + 1}. **${mandate.symbol}** — ${mandate.status}`,
      `   Address: \`${shortAddress(mandate.address)}\``,
      `   - Per payment: **${mandate.maxPerPayment} ${mandate.symbol}**`,
      `   - Total allowance: **${mandate.totalLimit} ${mandate.symbol}** (**${mandate.spent} ${mandate.symbol}** spent, **${mandate.remaining} ${mandate.symbol}** remaining)`,
    );
  });

  if (snapshot.attention.length) {
    lines.push("", "**Needs attention**");
    for (const item of snapshot.attention) {
      lines.push(`- ${item.detail} (\`${shortAddress(item.mandate)}\`)`);
    }
  }

  if (snapshot.receipts.length) {
    lines.push("", `**Recent receipts (${snapshot.receipts.length})**`);
    for (const receipt of snapshot.receipts) {
      const verify = receipt.receiptUrl ? ` · [Verify](${receipt.receiptUrl})` : "";
      lines.push(`- **${receipt.amount} ${receipt.symbol}** · \`${shortAddress(receipt.address)}\`${verify}`);
    }
  }

  lines.push("", snapshot.note, "", "**Next step:** Ask for `list_receipts`, inspect one receipt, or prepare a pause in the owner wallet.");
  return lines.join("\n");
}

export function formatReceiptListMarkdown(list: OpsReceiptList): string {
  if (list.count === 0) {
    return [
      "**No receipts yet** for this permission.",
      "",
      "**Next step:** After a payment settles, call `list_receipts` again or open the public verify link from the settlement card.",
    ].join("\n");
  }
  const lines = [`**${list.count} receipt${list.count === 1 ? "" : "s"}**`, ""];
  list.receipts.forEach((receipt, index) => {
    const verify = receipt.receiptUrl ? ` · [Verify](${receipt.receiptUrl})` : "";
    lines.push(
      `${index + 1}. **${receipt.amount} ${receipt.symbol}** — ${receipt.status}`,
      `   Receipt: \`${shortAddress(receipt.address)}\`${verify}`,
      `   Permission: \`${shortAddress(receipt.mandate)}\``,
    );
  });
  lines.push("", "**Next step:** Open a verify link or call `get_payment` with a receipt address for the full card.");
  return lines.join("\n");
}

export function formatPaymentLookupMarkdown(card: PaymentLookupCard): string {
  if (!card.found) {
    const address = card.receiptAddress ? ` at \`${shortAddress(card.receiptAddress)}\`` : "";
    return `**Receipt not found**${address}.\n\n**Next step:** Confirm the address or call \`list_receipts\` for this permission.`;
  }
  const lines = [
    "**Payment receipt** on Solana Devnet.",
    ...(card.amount ? [`- Amount: **${card.amount}${card.symbol ? ` ${card.symbol}` : ""}**`] : []),
    ...(card.receiptAddress ? [`- Receipt: \`${shortAddress(card.receiptAddress)}\``] : []),
    ...(card.mandate ? [`- Permission: \`${shortAddress(card.mandate)}\``] : []),
    ...(card.status ? [`- Status: ${card.status}`] : []),
    ...(card.signature ? [`- Signature: \`${shortAddress(card.signature)}\``] : []),
    ...(card.receiptUrl ? [`- Verify: ${card.receiptUrl}`] : []),
    "",
    "**Next step:** Share the verify link or open the receipt in ChainPay.",
  ];
  return lines.join("\n");
}

export function formatPreparePolicyMarkdown(action: "pause" | "revoke", mandate?: string): string {
  const verb = action === "pause" ? "pause" : "revoke";
  return [
    `**Owner wallet signature required** — ${verb} this permission.`,
    "",
    "This change needs the owner wallet—not the agent connection.",
    ...(mandate ? [`- Permission: \`${shortAddress(mandate)}\``] : []),
    "",
    "**Options**",
    "1. Approve in the ChainPay dashboard wallet flow",
    "2. Cancel and keep the current policy",
    "",
    "**Next step:** Wait for the owner to sign in the dashboard. This surface does not sign or submit.",
  ].join("\n");
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`/g, "");
}

/** Compact terminal text. Same facts as the markdown card, no styling codes. */
export function formatOpsAnsi(snapshot: OpsSnapshot): string {
  return stripMarkdown(formatOpsMarkdown(snapshot));
}

export function formatReceiptListAnsi(list: OpsReceiptList): string {
  return stripMarkdown(formatReceiptListMarkdown(list));
}

export function formatPaymentLookupAnsi(card: PaymentLookupCard): string {
  return stripMarkdown(formatPaymentLookupMarkdown(card));
}

export function formatPreparePolicyAnsi(action: "pause" | "revoke", mandate?: string): string {
  return stripMarkdown(formatPreparePolicyMarkdown(action, mandate));
}
