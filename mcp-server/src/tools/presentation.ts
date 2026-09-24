import {
  formatOpsMarkdown,
  formatPaymentLookupMarkdown,
  formatReceiptListMarkdown,
  type OpsReceiptList,
  type OpsSnapshot,
  type PaymentLookupCard,
} from "@chainpay/sdk";
import { receiptUrlForAddress } from "../outcome.js";

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function shortAddress(value: string | undefined): string {
  if (!value || value.length < 12) return value ?? "unknown";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "pass": return "✓";
    case "fail": return "✗";
    case "missing": return "?";
    default: return "…";
  }
}

function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatChecklist(checks: unknown): string[] {
  if (!Array.isArray(checks)) return [];
  return checks
    .filter(isRecord)
    .map((check) => {
      const label = pickString(check.label, check.key) ?? "Check";
      const status = pickString(check.status) ?? "pending";
      const detail = pickString(check.detail, check.message) ?? "";
      return `- ${statusIcon(status)} **${label}** — ${detail}`;
    });
}

function formatDisplayAmounts(display: unknown): string[] {
  if (!isRecord(display)) return [];
  const symbol = pickString(display.symbol) ?? "tokens";
  const amounts = isRecord(display.amounts) ? display.amounts : {};
  const lines: string[] = [];
  const maxPer = pickString(amounts.maxPerPayment);
  const totalLimit = pickString(amounts.totalLimit);
  const spent = pickString(amounts.amountSpent);
  if (maxPer) lines.push(`- Per payment: **${maxPer} ${symbol}**`);
  if (totalLimit) {
    const remaining = spent
      ? `(**${spent} ${symbol}** spent)`
      : "";
    lines.push(`- Total allowance: **${totalLimit} ${symbol}** ${remaining}`.trim());
  }
  return lines;
}

function formatMandateEntry(entry: RecordLike, index: number): string {
  const mandate = isRecord(entry.mandate) ? entry.mandate : entry;
  const status = pickString(mandate.status) ?? "unknown";
  const address = pickString(mandate.address) ?? "unknown";
  const display = entry.display ?? mandate.display;
  const symbol = isRecord(display) ? pickString(display.symbol) : undefined;
  const lines = [
    `${index + 1}. **${symbol ?? "Spending permission"}** — ${status}`,
    `   Address: \`${shortAddress(address)}\``,
    ...formatDisplayAmounts(display).map((line) => `   ${line}`),
  ];
  if (entry.compatible === false && isRecord(entry.checks)) {
    const failed = Object.entries(entry.checks)
      .filter(([, ok]) => ok === false)
      .map(([name]) => name);
    if (failed.length) lines.push(`   Not compatible: ${failed.join(", ")}`);
  }
  return lines.join("\n");
}

function formatMandateList(record: RecordLike): string {
  const mandates = Array.isArray(record.mandates) ? record.mandates : [];
  const count = typeof record.count === "number" ? record.count : mandates.length;
  if (count === 0) {
    return "**No spending permissions found** for this wallet on ChainPay Devnet.\n\n**Next step:** Create a mandate in the ChainPay dashboard, then reconnect the agent.";
  }
  const body = mandates.map((item, index) => formatMandateEntry(item as RecordLike, index)).join("\n\n");
  return `**${count} spending permission${count === 1 ? "" : "s"}**\n\n${body}\n\n**Next step:** Ask which permission to use, or call \`get_mandate\` on one address for full details.`;
}

function formatCompatibleMandate(record: RecordLike): string {
  const compatible = record.compatible === true;
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  if (compatible && isRecord(record.match)) {
    return `**Compatible mandate found**\n\n${formatMandateEntry(record.match, 0)}\n\n**Next step:** Quote or prepare the payment against this permission.`;
  }
  const options = candidates
    .filter(isRecord)
    .map((candidate, index) => formatMandateEntry(candidate, index))
    .join("\n\n");
  return `**No compatible mandate**\n\n${options || "None of the connected permissions fit this request."}\n\n**Next step:** Adjust the amount, token, or agent—or create a new spending permission in the dashboard.`;
}

function formatSingleMandate(record: RecordLike): string {
  const mandate = isRecord(record.mandate) ? record.mandate : {};
  const status = pickString(mandate.status) ?? "unknown";
  const address = pickString(mandate.address) ?? "unknown";
  const agent = pickString(mandate.approvedAgent);
  const lines = [
    `**Spending permission — ${status}**`,
    `- Address: \`${shortAddress(address)}\``,
    ...(agent ? [`- Approved agent: \`${shortAddress(agent)}\``] : []),
    ...formatDisplayAmounts(record.display),
  ];
  if (status !== "active") {
    lines.push("", "**Next step:** Choose an active permission or ask the owner to resume or recreate this mandate.");
  } else {
    lines.push("", "**Next step:** Quote a payment, pay a 402 URL, or inspect receipts for this permission.");
  }
  return lines.join("\n");
}

function formatRequirements(record: RecordLike): string {
  const requirements = isRecord(record.requirements) ? record.requirements : record;
  const status = pickString(requirements.status, record.status) ?? "unknown";
  const checks = formatChecklist(requirements.checks ?? record.checks);
  const missing = Array.isArray(requirements.missing)
    ? requirements.missing.filter((item): item is string => typeof item === "string")
    : Array.isArray(record.missing)
      ? record.missing.filter((item): item is string => typeof item === "string")
      : [];

  const headline = status === "ready"
    ? "**Payment checks passed** — safe to quote or prepare."
    : status === "needs_details"
      ? "**More details needed** before ChainPay can continue."
      : "**Payment blocked** by policy checks.";

  const lines = [headline, ""];
  if (checks.length) {
    lines.push("**Checks**", ...checks, "");
  }
  if (missing.length) {
    lines.push("**Please provide:**", ...missing.map((item, index) => `${index + 1}. ${item}`), "");
  }
  const message = pickString(record.message);
  if (message) lines.push(message, "");
  lines.push(status === "ready"
    ? "**Next step:** Prepare or execute the payment when the owner approves."
    : "**Next step:** Collect the missing details or fix the failed checks before trying again.");
  return lines.join("\n").trim();
}

function formatApprovalRequired(record: RecordLike): string {
  // The tools do not agree on where these live. prepare_payment nests them under
  // `payment` and emits no `display` at all; x402 uses `challenge`; the demo request uses
  // `request`/`display`. A card that silently omits the amount and the destination is
  // worse than no card, so read every shape the tools actually produce.
  const display = isRecord(record.display) ? record.display : undefined;
  const payment = isRecord(record.payment) ? record.payment : undefined;
  const request = isRecord(record.request) ? record.request : undefined;
  const challenge = isRecord(record.challenge) ? record.challenge : undefined;

  const symbol = pickString(display?.symbol, display?.token) ?? "tokens";
  const humanAmount = isRecord(display?.amounts)
    ? pickString(display.amounts.amount)
    : pickString(display?.amount);
  // Only base units are available on the prepare paths. Never present one as a human
  // amount and never invent a decimal count: say what it is.
  const baseUnits = humanAmount
    ? undefined
    : pickString(payment?.amount, challenge?.amount, request?.amount)
      ?? (typeof payment?.amount === "bigint" || typeof payment?.amount === "number"
        ? String(payment.amount)
        : undefined);

  const mandate = pickString(record.mandate, payment?.mandate, request?.mandate, challenge?.mandate);
  const recipient = pickString(
    record.recipient,
    payment?.recipient,
    request?.recipient,
    challenge?.recipient,
  );
  const mint = pickString(payment?.mint, challenge?.mint, record.mint);
  const receiptAddress = pickString(record.receiptAddress, record.receipt_address);

  const lines = [
    "**Approval required** — review before signing.",
    ...(humanAmount ? [`- Amount: **${humanAmount} ${symbol}**`] : []),
    ...(!humanAmount && baseUnits
      ? [`- Amount: **${baseUnits}** base units${mint ? ` of \`${shortAddress(mint)}\`` : ""} (exact on-chain value)`]
      : []),
    ...(recipient ? [`- Destination: \`${shortAddress(recipient)}\``] : []),
    ...(mandate ? [`- Permission: \`${shortAddress(mandate)}\``] : []),
    ...(receiptAddress ? [`- Receipt to be created: \`${shortAddress(receiptAddress)}\``] : []),
    "",
    "**Options**",
    "1. Approve in the owner wallet",
    "2. Cancel and revise the request",
    "",
    "**Next step:** Wait for the owner to choose an option. Never ask for private keys or seed phrases.",
  ];
  return lines.join("\n");
}

function formatSettled(record: RecordLike): string {
  // execute_x402_payment nests these under `receipt` and `settlement`; execute_payment
  // puts them at the top level. Reading only the top level dropped the receipt, the
  // signature and the verify link from every x402 success card.
  const receipt = isRecord(record.receipt) ? record.receipt : undefined;
  const settlement = isRecord(record.settlement) ? record.settlement : undefined;
  const receiptAddress = pickString(
    record.receiptAddress,
    record.receipt_address,
    receipt?.address,
    receipt?.receiptAddress,
    settlement?.receipt_address,
  );
  const signature = pickString(record.signature, settlement?.signature);
  const receiptUrl = receiptUrlForAddress(receiptAddress);
  const delivered = record.resourceResponse !== undefined && record.resourceResponse !== null;
  const lines = [
    "**Payment settled** on Solana Devnet.",
    ...(receiptAddress ? [`- Receipt: \`${shortAddress(receiptAddress)}\``] : []),
    ...(signature ? [`- Signature: \`${shortAddress(signature)}\``] : []),
    ...(receiptUrl ? [`- Verify: ${receiptUrl}`] : []),
    ...(delivered ? ["- The merchant accepted the receipt proof and returned the resource."] : []),
    "",
    delivered
      ? "**Next step:** Give the owner the resource, then the verify link."
      : "**Next step:** Share the verify link or open the receipt in ChainPay.",
  ];
  return lines.join("\n");
}

function formatBlocked(record: RecordLike): string {
  const action = pickString(record.action) ?? "blocked";
  const message = pickString(record.message, record.reason, record.error) ?? "This request cannot proceed.";
  const lines = [`**Stopped — ${action.replaceAll("_", " ")}**`, "", message];

  // Without this the owner is told only that something cannot proceed. The preflight
  // already knows which limit failed; say so.
  const requirements = isRecord(record.requirements) ? record.requirements : undefined;
  const preflight = isRecord(record.preflight) ? record.preflight : undefined;
  const checks = formatChecklist(
    record.checks ?? requirements?.checks ?? preflight?.checks,
  );
  if (checks.length) lines.push("", "**Checks**", ...checks);
  const missing = toStringList(record.missing ?? requirements?.missing);
  if (missing.length) {
    lines.push("", "**Missing:**", ...missing.map((item, index) => `${index + 1}. ${item}`));
  }

  if (action === "x402_unsupported_sponsor") {
    lines.push("", "ChainPay can quote this against the mandate but cannot settle it here: the merchant expects a facilitator to countersign, and ChainPay settles by on-chain receipt proof instead.");
    lines.push("", "**Next step:** This is pay.sh's job, not ChainPay's. Use the pay.sh MCP server if it is connected; otherwise hand the owner the resource URL and point them at the pay.sh panel in the ChainPay dashboard. There is no facilitator tool here, so do not retry.");
  } else if (action === "mpp_unsupported") {
    lines.push("", "**Next step:** MPP (WWW-Authenticate: Payment) merchants are pay.sh's job. Use the pay.sh MCP server if it is connected, otherwise hand the owner the URL and the dashboard's pay.sh panel. Do not retry here.");
  } else if (action.includes("preflight") || action === "requirements_blocked" || action === "payment_request_rejected") {
    lines.push("", "**Next step:** Fix the failed checks or choose a different spending permission.");
  } else if (action === "payment_pending" || action === "x402_payment_pending") {
    lines.push("", "**Next step:** Poll \`wait_for_payment\` with the same \`paymentId\`. Do not approve a second payment.");
  } else {
    lines.push("", "**Next step:** Report the stop reason plainly and suggest the safest dashboard or read-only follow-up.");
  }
  return lines.join("\n");
}

function formatOwnerApproval(record: RecordLike): string {
  const action = pickString(record.action) ?? "owner approval";
  return [
    `**${action.replaceAll("_", " ")}**`,
    "",
    "This change needs the owner wallet—not the agent connection.",
    "",
    "**Options**",
    "1. Approve in the ChainPay dashboard wallet flow",
    "2. Cancel and keep the current policy",
    "",
    "**Next step:** Wait for the owner to sign in the dashboard.",
  ].join("\n");
}

function formatTokenAccountApproval(record: RecordLike): string {
  const tokenAccount = pickString(record.tokenAccount);
  const mint = pickString(record.mint);
  return [
    "**Token account approval required**",
    "",
    "The agent prepared a canonical associated token account creation. The owner wallet must review and sign it.",
    "",
    `- Mint: \`${shortAddress(mint)}\``,
    `- Token account: \`${shortAddress(tokenAccount)}\``,
    "- Cost: Devnet SOL account rent and transaction fee",
    "- This does not fund the account or grant spending permission",
    "",
    "**Next step:** Approve in the ChainPay dashboard, or cancel without spending SOL.",
  ].join("\n");
}

function formatActionResult(record: RecordLike, isError: boolean): string {
  const action = pickString(record.action) ?? "result";
  if (action === "details_required" || action === "requirements_ready" || action === "requirements_blocked") {
    return formatRequirements(record);
  }
  if (action === "agent_signature_required" || action === "x402_agent_signature_required") {
    return formatApprovalRequired(record);
  }
  if (action === "owner_wallet_signature_required") {
    return formatOwnerApproval(record);
  }
  if (action === "token_account_signature_required") {
    return formatTokenAccountApproval(record);
  }
  if (
    action === "backend_relayed"
    || action === "managed_payment_settled"
    || action === "x402_verified"
    || (action === "payment_terminal" && record.status === "confirmed")
  ) {
    return formatSettled(record);
  }
  if (
    isError
    || action.includes("rejected")
    || action.includes("failed")
    || action.includes("unsupported")
    || action.includes("blocked")
    || action === "backend_rejected"
    || action === "agent_identity_mismatch"
    || record.status === "failed"
  ) {
    return formatBlocked(record);
  }
  if (action === "payment_pending" || action === "x402_payment_pending") {
    return formatBlocked(record);
  }
  return fallbackPresentation(record, isError, action);
}

function fallbackPresentation(data: unknown, isError: boolean, headline?: string): string {
  const title = headline
    ? `**${headline.replaceAll("_", " ")}**`
    : isError
      ? "**ChainPay tool error**"
      : "**ChainPay result**";
  const json = JSON.stringify(data, null, 2);
  return `${title}\n\n\`\`\`json\n${json}\n\`\`\``;
}

function formatPaymentLookup(record: RecordLike): string {
  const onChain = isRecord(record.onChain) ? record.onChain : undefined;
  const display = isRecord(record.display) ? record.display : undefined;
  const amounts = isRecord(display?.amounts) ? display.amounts : undefined;
  const card: PaymentLookupCard = {
    kind: "payment_lookup",
    found: record.found === true,
    receiptAddress: pickString(record.receiptAddress, onChain?.address),
    amount: pickString(amounts?.amount),
    symbol: pickString(display?.symbol),
    status: pickString(onChain?.status, record.status),
    signature: pickString(
      isRecord(record.offChain) ? record.offChain.transactionSignature : undefined,
      onChain?.transactionSignature,
    ),
    mandate: pickString(onChain?.mandate),
    receiptUrl: receiptUrlForAddress(pickString(record.receiptAddress, onChain?.address)),
  };
  return formatPaymentLookupMarkdown(card);
}

export function formatToolPresentation(data: unknown, isError = false): string {
  if (!isRecord(data)) return fallbackPresentation(data, isError);
  if (data.kind === "spend_overview") return formatOpsMarkdown(data as OpsSnapshot);
  if (data.kind === "receipt_list") return formatReceiptListMarkdown(data as OpsReceiptList);
  if (data.kind === "payment_lookup") return formatPaymentLookup(data);
  if (Array.isArray(data.mandates) && data.owner !== undefined) return formatMandateList(data);
  if (data.compatible !== undefined && Array.isArray(data.candidates)) return formatCompatibleMandate(data);
  if (data.found === true && data.mandate !== undefined) return formatSingleMandate(data);
  if (data.found === false) {
    const address = pickString(data.address);
    return `**Spending permission not found**${address ? ` at \`${shortAddress(address)}\`` : ""}.\n\n**Next step:** Confirm the address or call \`list_mandates\` for this wallet.`;
  }
  if (data.action !== undefined) return formatActionResult(data, isError);
  if (data.requirements !== undefined || Array.isArray(data.checks)) return formatRequirements(data);
  return fallbackPresentation(data, isError);
}
