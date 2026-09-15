import test from "node:test";
import assert from "node:assert/strict";
import { readFile, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(frontendRoot, "src");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

async function loadPurchaseCard() {
  const outfile = join(frontendRoot, "test/.tmp-purchase-card.mjs");
  await esbuild.build({
    absWorkingDir: frontendRoot,
    entryPoints: ["src/owner/purchaseCard.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    outfile,
  });
  const module = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  await unlink(outfile).catch(() => {});
  return module;
}

test("purchase card uses structured payment fields and unavailable description fallback", async () => {
  const purchaseCard = await loadPurchaseCard();
  const item = {
    id: "req-1",
    createdAt: new Date().toISOString(),
    source: "invoice",
    title: "Vendor invoice #42",
    prompt: "pay invoice",
    response: "assistant commentary only",
    stage: "waiting_for_approval",
    toolCalls: ["prepare_payment"],
    attachments: [],
    approval: {
      kind: "payment",
      action: "agent_signature_required",
      payment: {
        amount: "1000000",
        mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        recipient: "RecipientTokenAccount111111111111111111111",
      },
    },
    requirements: {
      status: "ready",
      missing: [],
      checks: [{ key: "limits", label: "Limits", status: "pass", detail: "Within mandate limits." }],
    },
  };
  const view = purchaseCard.purchaseCardFromInboxItem(item, {
    stablecoinOptions: [{ value: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "USDC", detail: "Classic SPL Token", tokenProgram: "spl-token" }],
    mandateDecimals: 6,
    mandate: null,
  });
  assert.equal(view.description, "Vendor invoice #42");
  const demoFallback = purchaseCard.purchaseCardFromInboxItem({ ...item, title: "Demo payment request" }, {
    stablecoinOptions: [{ value: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", label: "USDC", detail: "Classic SPL Token", tokenProgram: "spl-token" }],
    mandateDecimals: 6,
    mandate: null,
  });
  assert.equal(demoFallback.description, "pay invoice");
  assert.equal(view.tokenLabel, "USDC");
  assert.match(view.amountLabel, /1(\.0)?/);
  assert.equal(view.status, "waiting_for_approval");
  assert.equal(view.recipientLabel.length > 4, true);

  const sparse = purchaseCard.purchaseCardFromInboxItem({
    ...item,
    title: "",
    prompt: "",
    source: "message",
    approval: undefined,
  }, { stablecoinOptions: [], mandateDecimals: null, mandate: null });
  assert.equal(sparse.description, "Purchase description unavailable");
});

test("overview attention counts derive from inbox stages", async () => {
  const purchaseCard = await loadPurchaseCard();
  const counts = purchaseCard.inboxAttentionCounts([
    { stage: "waiting_for_approval" },
    { stage: "needs_details" },
    { stage: "blocked" },
    { stage: "receipt_ready" },
  ].map((entry, index) => ({ id: String(index), createdAt: "", source: "message", title: "", prompt: "", response: "", toolCalls: [], attachments: [], ...entry })));
  assert.equal(counts.waiting, 1);
  assert.equal(counts.needsDetails, 1);
  assert.equal(counts.blocked, 1);
  assert.equal(counts.receiptReady, 1);
  assert.equal(counts.pendingTotal, 3);
});

test("dashboard overview uses live purchase stats instead of hard-coded pending zero", async () => {
  const dashboard = await readFile(join(srcRoot, "dashboard/Dashboard.tsx"), "utf8");
  assert.match(dashboard, /LIVE PURCHASES/);
  assert.match(dashboard, /inboxCounts\.pendingTotal/);
  assert.equal(/PENDING PAYMENTS<\/span><strong>0<\/strong>/.test(dashboard), false);
  assert.match(dashboard, /OverviewLivePurchases/);
  assert.match(dashboard, /PurchaseCard/);
});

test("public receipt card does not expose MCP names or prepared-in-requests on public mode", async () => {
  const receiptCard = await readFile(join(srcRoot, "receipts/ReceiptCard.tsx"), "utf8");
  assert.match(receiptCard, /preparedInRequests && shareMode === "dashboard"/);
  const verifyPage = await readFile(join(srcRoot, "verify/VerifyPage.tsx"), "utf8");
  assert.equal(verifyPage.includes("Prepared in Requests"), false);
});
