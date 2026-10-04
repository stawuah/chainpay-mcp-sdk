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
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "@chainpay/sdk", "@solana/web3.js", "buffer", "@phala/dcap-qvl"],
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
    { key: "refunded", label: "Refunded", cents: "0" }, { key: "purchases", label: "Purchases", count: 3 }, { key: "exceptions", label: "Needs review", cents: "150" },
    { key: "outstanding", label: "Owed", cents: "5025" },
  ] };
  const args = { policy: { budgetCents: 200000n }, capturedCents: 12000n, reservedCents: 0n, refundedCents: 0n, purchasesCount: 3, exceptionCents: 150n, statementOutstandingCents: 5025n };
  m.assertRestoreMatchesReport(args, report);
  assert.throws(() => m.assertRestoreMatchesReport({ ...args, capturedCents: 0n, statementOutstandingCents: 0n }, report), /doesn't match the numbers you reviewed/);
  assert.throws(() => m.assertRestoreMatchesReport(args, { ...report, numbers: report.numbers.slice(1) }), /doesn't match/);
});

test("co-signed restore: signs only the reviewed values, for this card, already signed by the authorizer", async () => {
  const { Keypair, PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
  const sdk = await import("@chainpay/sdk");
  const owner = Keypair.generate();
  const authorizer = Keypair.generate();
  const cardId = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const programId = sdk.CARD_POLICY_PROGRAM_ID;
  const digest = "cd".repeat(32);
  const report = { digest, detectedAt: "", reason: "", snapshotLedgerSeq: "1", issuerEventsReplayed: 0, numbers: [
    { key: "budget", label: "Budget", cents: "50000" }, { key: "captured", label: "Charged", cents: "12000" }, { key: "reserved", label: "Held", cents: "0" },
    { key: "refunded", label: "Refunded", cents: "0" }, { key: "purchases", label: "Purchases", count: 3 }, { key: "exceptions", label: "Needs review", cents: "150" },
    { key: "outstanding", label: "Owed", cents: "5025" },
  ] };
  const restore = (o = {}) => ({
    policy: { budgetCents: 50_000n, maxPurchaseCents: 4_000n, maxPurchasesPerPeriod: 0, periodSeconds: 2_592_000, currency: "USD", merchantIdHashes: [new Uint8Array(32).fill(1)], mccs: [], expiresAt: 0n, recurringAllowed: false, feeBps: 50, authorizer: authorizer.publicKey.toBase58() },
    periodIndex: 2, capturedCents: 12_000n, reservedCents: 0n, refundedCents: 0n, purchasesCount: 3, exceptionCents: 150n, statementOutstandingCents: 5_025n,
    ledgerHead: new Uint8Array(32).fill(4), ledgerSeq: 9n, reconDigest: Uint8Array.from(Buffer.from(digest, "hex")), ...o,
  });
  const tx = ({ args = restore(), signer = authorizer, sign = true, feePayer = owner.publicKey, extra = [] } = {}) => {
    const ix = sdk.buildRestoreInstruction({ owner: owner.publicKey.toBase58(), cardId, authorizer: signer.publicKey.toBase58(), restore: args }, programId);
    const t = new Transaction({ feePayer, recentBlockhash: "11111111111111111111111111111111" });
    t.add(new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.address), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) }), ...extra);
    if (sign) t.partialSign(signer);
    return t;
  };
  const input = { owner: owner.publicKey.toBase58(), cardId, programId, report };
  assert.equal(m.assertCoSignedRestore(tx(), input).exceptionCents, 150n);
  // What the owner actually gets: Axum's wire bytes, read back (fee payer comes out writable).
  const wire = (t) => Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
  assert.equal(m.assertCoSignedRestore(wire(tx()), input).exceptionCents, 150n);
  assert.throws(() => m.assertCoSignedRestore(wire(tx({ args: restore({ capturedCents: 1n }) })), input), /doesn't match/);
  assert.throws(() => m.assertCoSignedRestore(wire(tx({ sign: false })), input), /isn't signed yet/);
  assert.throws(() => m.assertCoSignedRestore(tx({ args: restore({ exceptionCents: 0n }) }), input), /doesn't match the numbers you reviewed/);
  assert.throws(() => m.assertCoSignedRestore(tx({ args: restore({ reconDigest: new Uint8Array(32).fill(9) }) }), input), /doesn't match/);
  assert.throws(() => m.assertCoSignedRestore(tx({ sign: false }), input), /isn't signed yet/);
  assert.throws(() => m.assertCoSignedRestore(tx({ feePayer: authorizer.publicKey }), input), /doesn't match/);
  assert.throws(() => m.assertCoSignedRestore(tx(), { ...input, cardId: new Uint8Array(32).fill(7) }), /doesn't match/, "another card's accounts");
  const sneaky = new TransactionInstruction({ programId: new PublicKey(programId), keys: [], data: Buffer.alloc(8) });
  assert.throws(() => m.assertCoSignedRestore(tx({ extra: [sneaky] }), input), /doesn't match/);
});

test("card number: human-only Lithic frame, never rendered by ChainPay", async () => {
  assert.equal(m.safeEmbedUrl("https://sandbox.lithic.com/v1/embed?session=abc&type=PAN"), "https://sandbox.lithic.com/v1/embed?session=abc&type=PAN");
  assert.equal(m.safeEmbedUrl("https://evil.example/v1/embed?session=abc"), null);
  assert.equal(m.safeEmbedUrl("javascript:alert(1)"), null);
  assert.equal(m.safeEmbedUrl("https://sandbox.lithic.com/v1/cards"), null);
  const live = { cardNumberSession: async () => ({ embedUrl: "https://sandbox.lithic.com/v1/embed?session=s1&type=PAN", expiresAt: new Date(Date.now() + 30_000).toISOString() }) };
  const { host, unmount } = await render(createElement(m.CardNumberReveal, { source: live, card }));
  await click(button(host, "Show card number"));
  await settle();
  const frame = host.querySelector("iframe");
  assert.equal(frame.getAttribute("src"), "https://sandbox.lithic.com/v1/embed?session=s1&type=PAN");
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin");
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
  assert.doesNotMatch(host.textContent, /\d{13,19}/, "no digits rendered by ChainPay");
  await click(button(host, "Hide card number"));
  assert.equal(host.querySelector("iframe"), null);
  await unmount();
  const evil = { cardNumberSession: async () => ({ embedUrl: "https://evil.example/v1/embed", expiresAt: new Date().toISOString() }) };
  const refused = await render(createElement(m.CardNumberReveal, { source: evil, card }));
  await click(button(refused.host, "Show card number"));
  await settle();
  assert.equal(refused.host.querySelector("iframe"), null);
  assert.match(refused.host.textContent, /unexpected link/);
  await refused.unmount();
  // A slow session for card A must not open under card B.
  let release;
  const slow = { cardNumberSession: () => new Promise((resolve) => { release = () => resolve({ embedUrl: "https://sandbox.lithic.com/v1/embed?session=A", expiresAt: new Date(Date.now() + 30_000).toISOString() }); }) };
  const switching = await render(createElement(m.CardNumberReveal, { source: slow, card }));
  await click(button(switching.host, "Show card number"));
  await act(async () => { switching.root.render(createElement(m.CardNumberReveal, { source: slow, card: { ...card, cardId: "b2".repeat(32), label: "Other card" } })); });
  await act(async () => { release(); });
  await settle();
  assert.equal(switching.host.querySelector("iframe"), null, "stale session dropped");
  await switching.unmount();
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
        attestation: { hardware: "verified", measurements: "matched", label: "Genuine TDX hardware and expected MagicBlock build verified (Devnet)", provenance: "confirmed by MagicBlock to ChainPay, 2026-10-04 (direct, unsigned)" },
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
  const attestation = host.querySelector('[data-testid="attestation"]');
  assert.equal(attestation.dataset.passed, "true");
  assert.match(attestation.textContent, /Genuine TDX hardware and expected MagicBlock build verified \(Devnet\)\./);
  assert.match(attestation.textContent, /Expected build values: confirmed by MagicBlock to ChainPay, 2026-10-04 \(direct, unsigned\)\./);
  assert.equal(m.readVerdict({ state: "not_visible" }), "Hidden from this wallet");
  await unmount();
});

test("attestation copy claims the verified build only when both halves passed", () => {
  const pass = { hardware: "verified", measurements: "matched", label: "x" };
  assert.equal(m.attestationCopy(pass), m.ATTESTATION_VERIFIED_COPY);
  assert.equal(m.ATTESTATION_VERIFIED_COPY, "Genuine TDX hardware and expected MagicBlock build verified (Devnet).");
  const failing = [
    { hardware: "challenge_bound", measurements: "matched", label: "The private rollup answered a fresh challenge with MagicBlock's expected Devnet build. Intel's hardware signature wasn't checked here." },
    { hardware: "verified", measurements: "mismatch", label: "The private rollup is running a build that isn't MagicBlock's confirmed Devnet build, so approvals are paused" },
    { hardware: "verified", measurements: "unavailable", label: "Hardware verified, but the workload couldn't be checked, so approvals are paused" },
    { hardware: "failed", measurements: "unavailable", label: "" },
    { hardware: "not_checked", measurements: "unavailable", label: "This browser couldn't run the hardware check" },
  ];
  for (const a of failing) {
    assert.equal(m.attestationPassed(a), false);
    assert.notEqual(m.attestationCopy(a), m.ATTESTATION_VERIFIED_COPY);
    assert.doesNotMatch(m.attestationCopy(a), /build verified/);
  }
  assert.match(m.attestationCopy(failing[1]), /isn't MagicBlock's confirmed Devnet build, so approvals are paused\.$/);
  assert.match(m.attestationCopy(failing[3]), /Couldn't confirm/);
});

test("card face carries a Sandbox mark while the issuer is a sandbox, and no back", async () => {
  const { host, unmount } = await render(createElement(m.AgentCard, { label: "Data API credits", lastFour: "4821" }));
  const figure = host.querySelector("figure");
  assert.equal(figure.dataset.issuerEnv, "sandbox", "defaults to sandbox when no env says production");
  assert.equal(host.querySelector('[data-testid="card-sandbox-mark"]').textContent, "Sandbox");
  assert.match(figure.getAttribute("aria-label"), /sandbox card ending 4821/);
  assert.doesNotMatch(host.innerHTML, /flip|card-back/i);
  await unmount();
  const live = await render(createElement(m.AgentCard, { label: "Data API credits", lastFour: "4821", issuerEnvironment: "production" }));
  assert.equal(live.host.querySelector('[data-testid="card-sandbox-mark"]'), null);
  await live.unmount();
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

test("statement lines as Axum sends them: credits are negative and still add up", () => {
  const axum = { totalCents: "1005", feeCents: "5", lines: [{ kind: "purchase", amountCents: "2000", feeCents: "10", postedAt: "2026-10-04T01:00:00Z" }, { kind: "refund", amountCents: "-1000", feeCents: "-5", postedAt: "2026-10-04T02:00:00Z" }] };
  const totals = m.statementLineTotals(axum);
  assert.equal(totals.matches, true);
  assert.equal(totals.refunds, 1000n);
  // Repayment carries the amount due (after carried credit), never the gross total.
  assert.equal(m.statementAmountDue({ totalCents: "1005", amountDueCents: "505" }), 505n);
  assert.equal(m.statementAmountDue({ totalCents: "-200", amountDueCents: "0" }), 0n);
});

test("repayment target: Axum's payWith is used, and a different token is refused", () => {
  const usdc = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
  const ok = m.repaymentTargetFor({ payWith: { mint: usdc, recipientTokenAccount: "3burs6CNFvrQW8US2C5W84do8J1EezWsQfsoBAvHF5q6", amountCents: "2010" } });
  assert.equal(ok.recipientTokenAccount, "3burs6CNFvrQW8US2C5W84do8J1EezWsQfsoBAvHF5q6");
  assert.equal(ok.conflict, undefined);
  const bad = m.repaymentTargetFor({ payWith: { mint: "So11111111111111111111111111111111111111112", recipientTokenAccount: "3burs6CNFvrQW8US2C5W84do8J1EezWsQfsoBAvHF5q6", amountCents: "2010" } });
  assert.match(bad.conflict, /token other than Devnet USDC/);
});

test("recovery: Axum states map to the banner, and a report missing a restored counter is not offered", () => {
  const numbers = ["budget", "captured", "reserved", "refunded", "exceptions", "outstanding"].map((key) => ({ key, label: key, cents: "0" })).concat([{ key: "purchases", label: "purchases", count: 0 }]);
  const report = { digest: "ab".repeat(32), detectedAt: "2026-10-04T00:00:00Z", reason: "not_visible", snapshotLedgerSeq: "7", issuerEventsReplayed: 1, numbers };
  const card = (state, r = report) => ({ cardId: "a1".repeat(32), recovery: { state, report: r } });
  assert.equal(m.recoveryView(card("recovery_frozen")).state, "recovery_frozen");
  assert.equal(m.recoveryView(card("restore_prepared")).state, "recovery_frozen");
  assert.equal(m.recoveryView(card("reconciled_pending_owner_confirm")).state, "restored_pending_reconcile");
  assert.equal(m.recoveryView(card("restored")).state, "normal");
  assert.match(m.recoveryView(card("recovery_frozen")).report.reason, /stopped answering/);
  const noExceptions = { ...report, numbers: numbers.filter((n) => n.key !== "exceptions") };
  assert.equal(m.recoveryView(card("recovery_frozen", noExceptions)).report, undefined, "no report without the exceptions counter");
});

test("running statement: the owner can close it early, and it becomes a payable statement", async () => {
  // Astryx's Button reads CSS.supports, which jsdom doesn't provide.
  globalThis.CSS ??= { supports: () => false, escape: (value) => String(value) };
  dom.window.CSS ??= globalThis.CSS;
  const source = m.createFixtureCardsSource({ delayMs: 0 });
  const [card] = await source.listCards();
  let statements = await source.statements(card.cardId);
  const view = () => createElement(m.CardStatement, { source, card, statements, mandates: [], wallet: "w", onChanged: async () => { statements = await source.statements(card.cardId); } });
  const { host, unmount } = await render(view());
  assert.ok(host.querySelector('[data-testid="running-statement"]'), "running statement shown");
  assert.match(host.textContent, /Running statement · not closed yet/);
  await click(button(host, "Close statement now"));
  await settle(20);
  assert.equal(statements.closed.length, 2);
  assert.equal(statements.closed[0].closeKind, "interim");
  assert.equal(statements.open.lineCount, 0);
  await unmount();
});
