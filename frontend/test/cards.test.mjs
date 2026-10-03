// Cards area: receipt semantics, fee/obligation before signing, draft intake
// digest check, the null-visibility proof panel, lifecycle words and /verify/card.
import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(frontendRoot, "package.json"));
const esbuild = require("esbuild");

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://chainpay.example/app/cards/new", pretendToBeVisual: true });
for (const key of ["window", "document", "HTMLElement", "Node", "Element", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "history", "location", "HTMLInputElement", "Event", "KeyboardEvent", "MouseEvent", "PopStateEvent", "CustomEvent", "matchMedia", "ResizeObserver", "DOMRect"]) {
  if (dom.window[key] !== undefined && globalThis[key] === undefined) globalThis[key] = typeof dom.window[key] === "function" && !/^[A-Z]/.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
}
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
dom.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = dom.window.matchMedia;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
dom.window.ResizeObserver = globalThis.ResizeObserver;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const outfile = join(frontendRoot, "test/.tmp-cards.mjs");
await esbuild.build({
  absWorkingDir: frontendRoot,
  entryPoints: ["test/fixtures/cards-test-entry.ts"],
  bundle: true, format: "esm", platform: "browser", jsx: "automatic", outfile,
  loader: { ".css": "empty", ".png": "empty", ".svg": "empty", ".webp": "empty" },
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@chainpay/sdk", "@solana/web3.js", "buffer"],
  define: { "import.meta.env": "{}" },
  logLevel: "error",
});
const m = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
await unlink(outfile).catch(() => {});

async function render(element) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  await act(async () => { root.render(element); });
  return { host, root, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}
const settle = (ms = 30) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
async function click(el) { await act(async () => { el.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }); }
const button = (host, name) => [...host.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || b.textContent).trim() === name);

const card = { cardId: "a1".repeat(32), label: "Data API credits", lastFour: "4242", issuerState: "OPEN", mirror: { state: "acknowledged" }, freeze: { onChain: false, issuer: "confirmed" }, commitment: { seq: "5", root: "", slot: "412883104" } };
const merchant = { displayName: "ChainPay demo shop", mcc: "5734" };
const CARD_EVIDENCE = [
  { kind: "card_authorization", cardId: card.cardId, intentId: "int-1", merchant, amountCents: "2500", currency: "USD", reservationState: "reserved", decision: "approved", at: "2026-10-03T20:51:00Z", private: true },
  { kind: "card_authorization", cardId: card.cardId, intentId: "int-2", merchant, amountCents: "900", currency: "USD", reservationState: "declined", decision: "declined", declineReason: "merchant_not_allowed", at: "2026-10-01T14:20:00Z", private: true },
  { kind: "card_capture", cardId: card.cardId, authId: "a-1", merchant, capturedCents: "1999", reservedCents: "1999", lifecycle: "captured", private: true },
  { kind: "card_capture", cardId: card.cardId, authId: "a-2", merchant, capturedCents: "1150", reservedCents: "1150", lifecycle: "forced_capture", exception: "forced_capture", private: true },
  { kind: "statement_repayment", cardId: card.cardId, statementId: "stmt-1", statementDigest: "ab".repeat(32), totalCents: "18836", receiptPda: "4RcptStatementFixture11111111111111111111", repaymentState: "discharged", simulatedCredit: true },
];

test("receipt semantics: card evidence never renders as an SPL settlement", async () => {
  // A ReceiptView that would render the payment layout if card evidence ever reached it.
  const decoyReceipt = { address: "4RcptStatementFixture11111111111111111111" };
  for (const evidence of CARD_EVIDENCE) {
    const { host, unmount } = await render(createElement(m.ReceiptEvidenceCard, { evidence, receipt: decoyReceipt }));
    const text = host.textContent;
    const article = host.querySelector("article");
    assert.equal(article.dataset.evidenceKind, evidence.kind);
    assert.equal(article.dataset.private, "yes");
    assert.equal(article.hasAttribute("data-paid"), false, `${evidence.kind} used the paid receipt layout`);
    assert.doesNotMatch(text, /PAYMENT RECEIPT/);
    assert.doesNotMatch(text, /settled on Solana/i);
    assert.doesNotMatch(text, /Solana Devnet$|Open public receipt|Copy receipt link/);
    assert.equal(host.querySelector(".receipt-card-network"), null);
    assert.match(text, /Private/);
    if (evidence.kind === "statement_repayment") assert.match(text, /Simulated credit — no credit extended/);
    if (evidence.exception) assert.match(text, /never treated as approved/);
    await unmount();
  }
  const { host, unmount } = await render(createElement(m.ReceiptEvidenceCard, { evidence: { kind: "spl_settlement", receiptPda: "Other111" }, receipt: decoyReceipt }));
  assert.equal(host.textContent, "", "an SPL kind without its own verified receipt renders nothing");
  await unmount();
});

test("activity rows map to card evidence kinds, and a pending check has no receipt", () => {
  const capture = m.activityEvidence(card, { rowId: "r1", cardId: card.cardId, at: "x", kind: "capture", lifecycle: "partially_captured", amountCents: "1800", merchant });
  assert.equal(capture.kind, "card_capture");
  assert.equal(capture.lifecycle, "partially_captured");
  const declined = m.activityEvidence(card, { rowId: "r2", cardId: card.cardId, at: "x", kind: "authorization", lifecycle: "declined", declineReason: "over_max", amountCents: "4500", merchant });
  assert.equal(declined.kind, "card_authorization");
  assert.equal(declined.decision, "declined");
  assert.equal(m.activityEvidence(card, { rowId: "r3", cardId: card.cardId, at: "x", kind: "authorization", lifecycle: "pending" }), null);
  assert.equal(m.activityEvidence(card, { rowId: "r4", cardId: card.cardId, at: "x", kind: "authorization", lifecycle: "ambiguous" }), null, "no amount, no record (never an invented $0.00)");
  assert.equal(capture.reservedCents, "", "a partial charge without a reported hold never copies the charge as the hold");
  const partial = m.activityEvidence(card, { rowId: "r5", cardId: card.cardId, at: "x", kind: "capture", lifecycle: "partially_captured", amountCents: "1200", reservedCents: "3000", merchant });
  assert.deepEqual([partial.capturedCents, partial.reservedCents], ["1200", "3000"]);
});

test("lifecycle states are distinct words, and an exception is never shown as approved", () => {
  const states = ["pending", "reserved", "captured", "partially_captured", "reversed", "expired", "late_capture", "refunded", "declined", "ambiguous"];
  const labels = states.map((state) => m.LIFECYCLE_PILLS[state].label);
  assert.equal(new Set(labels).size, labels.length, labels.join(", "));
  const exception = m.activityPills({ rowId: "x", cardId: "c", at: "", kind: "exception", lifecycle: "captured", exception: "forced_capture" });
  assert.ok(exception.some((p) => p.label === "Needs review"));
  assert.ok(exception.every((p) => p.tone !== "positive" || p.key === "captured"));
  const forced = m.activityPills({ rowId: "y", cardId: "c", at: "", kind: "capture", lifecycle: "forced_capture" });
  assert.deepEqual(forced.map((p) => p.label), ["Needs review"], "a forced charge never shows as Charged");
  assert.equal(m.rowNeedsReview({ kind: "capture", lifecycle: "forced_capture" }), true);
  assert.equal(m.rowNeedsReview({ kind: "exception", exception: "forced_capture", needsReview: false }), false, "a resolved exception has no Mark reviewed");
  const disputed = m.activityPills({ rowId: "x", cardId: "c", at: "", kind: "dispute", lifecycle: "captured" });
  assert.deepEqual(disputed.map((p) => p.label), ["Charged", "Disputed"]);
  assert.equal(m.cardStatus({ ...card, freeze: { onChain: true, issuer: "pending_issuer_confirmation" } }).label, "Freeze pending");
  assert.equal(m.cardStatus({ ...card, freeze: { onChain: true, issuer: "confirmed" } }).label, "Frozen");
  assert.equal(m.cardStatus({ ...card, freeze: { onChain: true, issuer: "confirmed" }, recovery: { state: "recovery_frozen" } }).label, "Needs restore");
});

test("restore refuses values the owner wasn't shown", () => {
  const report = { digest: "ab".repeat(32), detectedAt: "", reason: "", snapshotLedgerSeq: "1", issuerEventsReplayed: 0, numbers: [
    { key: "budget", label: "Budget", cents: "200000" }, { key: "captured", label: "Charged", cents: "12000" }, { key: "reserved", label: "Held", cents: "0" },
    { key: "refunded", label: "Refunded", cents: "0" }, { key: "purchases", label: "Purchases", count: 3 }, { key: "outstanding", label: "Owed", cents: "5025" },
  ] };
  const args = { policy: { budgetCents: 200000n }, capturedCents: 12000n, reservedCents: 0n, refundedCents: 0n, purchasesCount: 3, statementOutstandingCents: 5025n };
  m.assertRestoreMatchesReport(args, report);
  assert.throws(() => m.assertRestoreMatchesReport({ ...args, capturedCents: 0n, statementOutstandingCents: 0n }, report), /doesn't match the numbers you reviewed/);
  assert.throws(() => m.assertRestoreMatchesReport(args, { ...report, numbers: report.numbers.slice(1) }), /doesn't match/);
});

test("dollar input is exact and statement lines add up to the cent", () => {
  assert.equal(m.dollarsToCents("500"), "50000");
  assert.equal(m.dollarsToCents("$1,250.5"), "125050");
  assert.equal(m.dollarsToCents("30.505"), null);
  assert.equal(m.dollarsToCents("-5"), null);
  assert.equal(m.centsToDollarInput("3050"), "30.50");
  const ok = m.statementLineTotals({ totalCents: "1005", feeCents: "5", lines: [{ kind: "purchase", amountCents: "2000", feeCents: "10" }, { kind: "refund", amountCents: "1000", feeCents: "-5" }] });
  assert.equal(ok.matches, true);
  assert.equal(m.statementLineTotals({ totalCents: "9999", feeCents: "5", lines: [{ kind: "purchase", amountCents: "2000", feeCents: "10" }] }).matches, false);
});

test("create flow shows allowance, fee and the most you could owe BEFORE anything is signed", async () => {
  const draftFragment = "#draft=eyJ2IjoxLCJsYWJlbCI6IkRhdGEgQVBJIGNyZWRpdHMiLCJidWRnZXRDZW50cyI6IjUwMDAwIiwibWF4UHVyY2hhc2VDZW50cyI6IjMwMDAiLCJtZXJjaGFudHMiOlsiZGVtby1hcHByb3ZlZCJdLCJtY2NzIjpbNzM3Ml0sInBlcmlvZERheXMiOjMwLCJleHBpcmVzQXQiOm51bGwsImZlZUJwcyI6NTB9&digest=709d6fc17729d26dc3f6158dd5a28df41836eb7534b599cd5b788d1c930da7ad";
  history.replaceState(null, "", `/app/cards/new${draftFragment}`);
  const source = m.createFixtureCardsSource({ delayMs: 0 });
  let creates = 0;
  const createCard = source.createCard;
  source.createCard = (...args) => { creates += 1; return createCard(...args); };
  const { host, unmount } = await render(createElement(m.CardCreate, { source, unlocked: false, onUnlocked() {}, onNavigate() {} }));
  await settle(60);
  assert.equal(host.querySelector('[data-intake="matched"]') !== null, true, "matched draft banner");
  assert.match(host.textContent, /Check code 709d6fc1/);
  await click(button(host, "Pick shops"));
  await click(button(host, "Review"));
  const box = host.querySelector('[data-testid="money-box"]');
  assert.ok(box, "review renders the money box");
  assert.match(box.querySelector('[data-row="allowance"]').textContent, /Purchase allowance\$500\.00/);
  assert.match(box.querySelector('[data-row="fee"]').textContent, /0\.5% · up to \$2\.50/);
  assert.match(box.querySelector('[data-row="max-obligation"]').textContent, /Most you could owe this period\$502\.50/);
  assert.match(box.textContent, /No credit is extended/);
  assert.equal(creates, 0, "nothing is signed or prepared before Approve");
  assert.doesNotMatch(host.textContent, /mandate|PDA|\bPER\b/);
  await click(button(host, "Approve in wallet"));
  await settle(30);
  assert.equal(creates, 1);
  await unmount();
});

test("draft intake: a changed link fills nothing in", async () => {
  for (const [fragment, pattern] of [
    ["#draft=eyJ2IjoxLCJsYWJlbCI6IkRhdGEgQVBJIGNyZWRpdHMiLCJidWRnZXRDZW50cyI6IjUwMDAwIiwibWF4UHVyY2hhc2VDZW50cyI6IjMwMDAiLCJtZXJjaGFudHMiOlsiZGVtby1hcHByb3ZlZCJdLCJtY2NzIjpbNzM3Ml0sInBlcmlvZERheXMiOjMwLCJleHBpcmVzQXQiOm51bGwsImZlZUJwcyI6NTB9&digest=" + "0".repeat(64), /doesn't match its own check code/],
    ["#draft=eyJ2IjoxLCJsYWJlbCI6IkRhdGEgQVBJIGNyZWRpdHMiLCJidWRnZXRDZW50cyI6IjUwMDAwIiwibWF4UHVyY2hhc2VDZW50cyI6IjMwMDAiLCJtZXJjaGFudHMiOlsiZGVtby1hcHByb3ZlZCJdLCJtY2NzIjpbNzM3Ml0sInBlcmlvZERheXMiOjMwLCJleHBpcmVzQXQiOm51bGwsImZlZUJwcyI6NTB9", /no check code/],
  ]) {
    history.replaceState(null, "", `/app/cards/new${fragment}`);
    const source = m.createFixtureCardsSource({ delayMs: 0 });
    const { host, unmount } = await render(createElement(m.CardCreate, { source, unlocked: false, onUnlocked() {}, onNavigate() {} }));
    await settle(60);
    assert.match(host.textContent, pattern);
    assert.equal(host.querySelector('[role="alert"][data-intake]') !== null, true);
    const values = [...host.querySelectorAll("input")].filter((el) => el.type !== "checkbox").map((el) => el.value);
    assert.ok(!values.includes("Data API credits") && !values.includes("500"), `nothing prefilled: ${values}`);
    await unmount();
  }
  history.replaceState(null, "", "/app/cards");
});

test("Read as another wallet: null is shown as hidden, never as missing", async () => {
  const source = {
    async privacyCheck() {
      return {
        checkedAt: "2026-10-04T10:15:00Z",
        owner: [{ label: "Card rules", state: "visible", raw: "value: { … }", summary: "Rules version 2" }],
        stranger: { wallet: "Str4ngerWa11et1111111111111111111111111111", reads: [{ label: "Card rules", state: "not_visible", raw: "value: null" }, { label: "This period", state: "not_visible", raw: "value: null" }] },
        publicChain: { address: "Po1icy1111111111111111111111111111111111111", bytes: 695, nonZeroAfterOwnerLink: 0, preview: "card + owner link, then 623 zero bytes", state: "empty" },
        attestation: { hardware: "verified", measurements: "pending", label: "Hardware verified, measurements pending" },
      };
    },
    unlock: async () => {}, isUnlocked: () => true,
  };
  const { host, unmount } = await render(createElement(m.CardPrivacyCheck, { source, card, unlocked: true, onUnlocked() {} }));
  await click(button(host, "Run the check"));
  await settle();
  const stranger = host.querySelector('[data-column="stranger"]');
  assert.equal(stranger.dataset.hidden, "yes");
  assert.equal([...stranger.querySelectorAll("code")].map((c) => c.textContent).join("|"), "value: null|value: null");
  assert.match(stranger.textContent, /Hidden from this wallet/);
  assert.doesNotMatch(stranger.textContent, /missing|does not exist|doesn't exist|not found/i);
  assert.match(host.querySelector('[data-testid="null-note"]').textContent, /Null means this wallet can't see it\. It doesn't mean the card is missing\./);
  assert.match(host.textContent, /Genuine TDX hardware verified; workload measurements pending from MagicBlock\./);
  assert.equal(m.readVerdict({ state: "not_visible" }), "Hidden from this wallet");
  assert.equal(m.attestationCopy({ hardware: "verified", measurements: "pending", label: "" }), m.MEASUREMENTS_PENDING_COPY);
  assert.doesNotMatch(m.attestationCopy({ hardware: "failed", measurements: "unavailable", label: "" }), /verified/);
  await unmount();
});

test("/verify/card checks disclosed fields against the on-chain commitment, with the exact copy", async () => {
  const { encodeDisclosureFragment } = await import("@chainpay/sdk");
  const source = m.createFixtureCardsSource({ unlocked: true, delayMs: 0 });
  const view = await source.getCard(m.FIXTURE_CARD_IDS.data);
  const bundle = await source.disclose(view, [2, 9]);
  const commitment = await source.commitmentFor(bundle.binding);
  m.setCardCommitmentReader(async () => ({ address: "Commit111", commitment }));
  for (const [mutate, expected] of [[(b) => b, "verified"], [(b) => ({ ...b, leaves: b.leaves.map((l, i) => i === 0 ? { ...l, value: "ffff000000000000" } : l) }), "mismatch"]]) {
    history.replaceState(null, "", `/verify/card#${encodeDisclosureFragment(mutate(structuredClone(bundle)))}`);
    const { host, unmount } = await render(createElement(m.CardVerifyPage));
    await settle(80);
    assert.equal(host.querySelector('[data-testid="card-verify-copy"]').textContent, "Integrity check against ChainPay's on-chain commitment, not a zero-knowledge proof.");
    assert.equal(host.querySelector('[data-testid="card-verify-result"]').dataset.check, expected);
    if (expected === "verified") assert.match(host.textContent, /Budget per period\$500\.00/);
    await unmount();
  }
  m.setCardCommitmentReader(null);
  history.replaceState(null, "", "/");
});
