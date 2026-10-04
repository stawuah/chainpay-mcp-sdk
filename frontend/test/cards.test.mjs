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
  // What the owner reviewed besides the numbers: the card's rules (here from its private records) and period.
  const reviewed = { rules: { maxPurchaseCents: "4000", maxPurchasesPerPeriod: 0, periodSeconds: 2_592_000, currency: "USD", merchantIdHashes: ["01".repeat(32)], mccs: [], expiresAt: "0", recurringAllowed: false, feeBps: 50, authorizer: authorizer.publicKey.toBase58() }, periodIndex: 2 };
  const input = { owner: owner.publicKey.toBase58(), cardId, programId, report, reviewed };
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
  assert.match(m.attestationCopy(failing[1]), /isn't MagicBlock's confirmed Devnet build\.$/);
  assert.match(m.attestationCopy(failing[3]), /Couldn't confirm/);
  // The browser check pauses nothing, so its line never says so.
  for (const a of failing) assert.doesNotMatch(m.attestationCopy(a), /paused/);
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

test("repayment offers both methods when ChainPay does, and the private one says the payer isn't verified", async () => {
  globalThis.CSS ??= { supports: () => false, escape: (value) => String(value) };
  dom.window.CSS ??= globalThis.CSS;
  const D = dom.window.HTMLDialogElement?.prototype;
  if (D && !D.showModal) { D.showModal = function () { this.setAttribute("open", ""); }; D.show = D.showModal; D.close = function () { this.removeAttribute("open"); }; }
  const source = m.createFixtureCardsSource({ delayMs: 0 });
  const [card] = await source.listCards();
  const statements = await source.statements(card.cardId);
  statements.closed[0] = { ...statements.closed[0], payPrivately: { method: "magicblock_private_payments", prepare: "/x", cluster: "devnet", verification: "settlement_to_partner_only", payerVerified: false } };
  let prepared = 0;
  source.privateRepay = (_c, statement) => statement.payPrivately ? { prepare: async () => { prepared += 1; throw new Error("not in tests"); }, check: async () => ({}), pay: async () => ({ transferOutcome: "sent" }), wait: async () => ({}) } : null;
  const { host, unmount } = await render(createElement(m.CardStatement, { source, card, statements, mandates: [], wallet: "w", onChanged() {} }));
  await click(button(host, "Pay $188.36"));
  await settle(10);
  const dialog = document.querySelector('[data-testid="repayment-dialog"]');
  assert.ok(dialog, "repayment dialog");
  assert.ok(button(document.body, "From a spending permission"), "transparent method offered");
  await click(button(document.body, "Privately with MagicBlock"));
  await settle(10);
  const text = document.querySelector('[data-testid="repayment-dialog"]').textContent;
  assert.match(text, /can't check who paid/);
  assert.match(text, /still public/);
  assert.doesNotMatch(text, /untraceable|anonymous/i);
  assert.equal(prepared, 0, "nothing is prepared before the owner opts in");
  await unmount();
});

// ---------------------------------------------------------------- review 2026-10-04 (PR #40 frontend F1–F9, X2/X4/X5/X12)

async function restoreFixture() {
  const { Keypair, PublicKey, Transaction, TransactionInstruction } = await import("@solana/web3.js");
  const sdk = await import("@chainpay/sdk");
  const owner = Keypair.generate();
  const authorizer = Keypair.generate();
  const cardId = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const programId = sdk.CARD_POLICY_PROGRAM_ID;
  const digest = "cd".repeat(32);
  const report = { digest, detectedAt: "", reason: "", snapshotLedgerSeq: "9", issuerEventsReplayed: 0, numbers: [
    { key: "budget", label: "Budget", cents: "50000" }, { key: "captured", label: "Charged", cents: "12000" }, { key: "reserved", label: "Held", cents: "0" },
    { key: "refunded", label: "Refunded", cents: "0" }, { key: "purchases", label: "Purchases", count: 3 }, { key: "exceptions", label: "Needs review", cents: "150" },
    { key: "outstanding", label: "Owed", cents: "5025" },
  ] };
  const shop = new Uint8Array(32).fill(1);
  // The owner's own private records (TEE read): what the card's rules are today.
  const current = {
    policy: { policyVersion: 3, authorizer: authorizer.publicKey.toBase58(), budgetCents: "50000", maxPurchaseCents: "4000", maxPurchasesPerPeriod: 0, periodSeconds: 2_592_000, currency: "USD",
      merchantIdHashes: ["01".repeat(32)], mccs: [5734], expiresAt: null, recurringAllowed: false, feeBps: 50, maxObligationCents: "50250", frozen: true, freezeReason: "recovery",
      recoveryState: "recovery_frozen", statementOutstandingCents: "0", exceptionsOpen: 0, members: [], ledgerSeq: "4", commitSeq: "1" },
    period: { policy: "", periodIndex: 2, periodStart: 0n, periodEnd: 0n, capturedCents: 0n, reservedCents: 0n, refundedCents: 0n, purchasesCount: 0, exceptionCents: 0n, bump: 255 },
  };
  const restore = (policy = {}, o = {}) => ({
    policy: { budgetCents: 50_000n, maxPurchaseCents: 4_000n, maxPurchasesPerPeriod: 0, periodSeconds: 2_592_000, currency: "USD", merchantIdHashes: [shop], mccs: [5734], expiresAt: 0n, recurringAllowed: false, feeBps: 50, authorizer: authorizer.publicKey.toBase58(), ...policy },
    periodIndex: 2, capturedCents: 12_000n, reservedCents: 0n, refundedCents: 0n, purchasesCount: 3, exceptionCents: 150n, statementOutstandingCents: 5_025n,
    ledgerHead: new Uint8Array(32).fill(4), ledgerSeq: 11n, reconDigest: Uint8Array.from(Buffer.from(digest, "hex")), ...o,
  });
  const wire = (args, signer = authorizer) => {
    const ix = sdk.buildRestoreInstruction({ owner: owner.publicKey.toBase58(), cardId, authorizer: signer.publicKey.toBase58(), restore: args }, programId);
    const t = new Transaction({ feePayer: owner.publicKey, recentBlockhash: "11111111111111111111111111111111" });
    t.add(new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.address), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) }));
    t.partialSign(signer);
    return Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false }));
  };
  return { owner, authorizer, cardId, programId, report, current, restore, wire, Keypair };
}

test("F1/X4: a co-signed restore that changes any rule the owner didn't review is refused", async () => {
  const f = await restoreFixture();
  const reviewed = m.reviewedRestore(f.report, f.current);
  const input = { owner: f.owner.publicKey.toBase58(), cardId: f.cardId, programId: f.programId, report: f.report, reviewed };
  // The honest restore: the reviewed numbers, the card's own rules, its period.
  assert.equal(m.assertCoSignedRestore(f.wire(f.restore()), input).capturedCents, 12_000n);
  // The review repro: same 7 numbers, different rules.
  const attacker = f.Keypair.generate();
  const changes = [
    [{ maxPurchaseCents: 50_000n }, /max per purchase/],
    [{ merchantIdHashes: [] }, /shops/],
    [{ mccs: [] }, /categories/],
    [{ recurringAllowed: true }, /repeat charges/],
    [{ feeBps: 1000 }, /fee/],
    [{ maxPurchasesPerPeriod: 99 }, /purchases per period/],
    [{ periodSeconds: 86_400 }, /period length/],
    [{ expiresAt: 1_900_000_000n }, /end date/],
    [{ authorizer: attacker.publicKey.toBase58() }, /ChainPay approver/],
  ];
  for (const [policy, why] of changes) {
    assert.throws(() => m.assertCoSignedRestore(f.wire(f.restore(policy)), input), why, JSON.stringify(Object.keys(policy)));
  }
  assert.throws(() => m.assertCoSignedRestore(f.wire(f.restore({}, { periodIndex: 3 })), input), /period/);
  assert.throws(() => m.assertCoSignedRestore(f.wire(f.restore({}, { ledgerSeq: 2n })), input), /doesn't match/, "ledger before the reviewed snapshot");
  // A different co-signer (X4): the rules name one approver, the transaction is signed by another.
  assert.throws(() => m.assertCoSignedRestore(f.wire(f.restore({ authorizer: attacker.publicKey.toBase58() }), attacker), input), /ChainPay approver|doesn't match/);
  assert.throws(() => m.assertCoSignedRestore(f.wire(f.restore(), attacker), input), /doesn't match/);
});

test("F1: the rules a restore may write come from the owner's private records; the report must agree, and with neither nothing is signed", async () => {
  const f = await restoreFixture();
  const mine = m.rulesFromPolicy(f.current.policy, f.current.period);
  assert.equal(mine.expiresAt, "0");
  assert.equal(mine.periodIndex, 2);
  // Report rules that disagree with the private records: refused before Axum is even asked.
  assert.throws(() => m.reviewedRestore({ ...f.report, rules: { ...mine, feeBps: 1000 } }, f.current), /different card rules than your private records \(fee\)/);
  // Records unreadable (e.g. reason not_visible): the report's rules, shown to the owner, are the reference.
  const fromReport = m.reviewedRestore({ ...f.report, rules: mine }, { policy: null, period: null });
  assert.equal(fromReport.rules.feeBps, 50);
  assert.throws(() => m.reviewedRestore(f.report, { policy: null, period: null }), /can't be checked/);
  assert.throws(() => m.reviewedRestore({ ...f.report, rules: { ...mine, periodIndex: undefined } }, { policy: null, period: null }), /which period/);
  // Axum's report rules are parsed strictly; a malformed one can't vouch for a restore.
  assert.deepEqual(m.parseRecoveryRules({ ...mine, merchantIdHashes: ["01".repeat(32).toUpperCase()] }).merchantIdHashes, ["01".repeat(32)]);
  assert.equal(m.parseRecoveryRules({ ...mine, feeBps: "50" }), undefined);
  assert.equal(m.recoveryView({ recovery: { state: "recovery_frozen", report: { ...f.report, rules: mine } } }).report.rules.authorizer, mine.authorizer);
});

test("F2: card setup signs only the exact setup instructions for THIS card", async () => {
  const { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, ComputeBudgetProgram } = await import("@solana/web3.js");
  const sdk = await import("@chainpay/sdk");
  const owner = Keypair.generate();
  const ownerKey = owner.publicKey.toBase58();
  const programId = sdk.CARD_POLICY_PROGRAM_ID;
  const cardId = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
  const otherCardId = new Uint8Array(32).fill(7);
  const accounts = sdk.deriveCardAccounts(ownerKey, cardId, programId);
  const prepared = { cardId: sdk.cardIdToHex(cardId), accounts: { binding: accounts.binding, policy: accounts.policy, period: accounts.period, commitment: accounts.commitment, escrow: accounts.escrow }, initTx: "", delegateTx: "", escrowTopUpTx: "", authorizer: Keypair.generate().publicKey.toBase58(), teeValidator: sdk.DEVNET_TEE_VALIDATOR, prefundLamports: "5000000" };
  const web3ix = (ix) => new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map((k) => ({ pubkey: new PublicKey(k.address), isSigner: k.isSigner, isWritable: k.isWritable })), data: Buffer.from(ix.data) });
  const wire = (...ixs) => { const t = new Transaction({ feePayer: owner.publicKey, recentBlockhash: "11111111111111111111111111111111" }).add(...ixs); return Transaction.from(t.serialize({ requireAllSignatures: false, verifySignatures: false })); };
  const init = (o = {}) => web3ix(sdk.buildInitCardInstruction({ owner: ownerKey, cardId, issuer: 1, issuerCardRefHash: new Uint8Array(32).fill(3), prefundLamports: 5_000_000n, ...o }, programId));
  const delegate = (o = {}) => web3ix(sdk.buildDelegateCardInstruction({ owner: ownerKey, cardId, validator: sdk.DEVNET_TEE_VALIDATOR, ...o }, programId));
  const topUp = (lamports = 20_000_000n, escrow = accounts.escrow, policy = accounts.policy) => {
    const data = Buffer.alloc(17); data.writeBigUInt64LE(9n, 0); data.writeBigUInt64LE(lamports, 8); data[16] = 255;
    return new TransactionInstruction({ programId: new PublicKey(sdk.DELEGATION_PROGRAM_ID), keys: [
      { pubkey: owner.publicKey, isSigner: true, isWritable: true }, { pubkey: new PublicKey(policy), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(escrow), isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false } ], data });
  };
  const input = { owner: ownerKey, prepared, programId };
  // The 3 real setup steps pass.
  m.assertCardSetupTransaction(wire(init()), 0, input);
  m.assertCardSetupTransaction(wire(delegate()), 1, input);
  m.assertCardSetupTransaction(wire(topUp()), 2, input);
  const refused = /does something other than set up this card/;
  // The review repro: a 500 SOL System transfer dressed as a setup step.
  const drain = SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 500_000_000_000 });
  for (const step of [0, 1, 2]) assert.throws(() => m.assertCardSetupTransaction(wire(drain), step, input), refused, `transfer as step ${step}`);
  assert.throws(() => m.assertCardSetupTransaction(wire(init(), drain), 0, input), refused, "transfer riding along");
  assert.throws(() => m.assertCardSetupTransaction(wire(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000_000 }), init()), 0, input), refused, "priority-fee drain");
  // card_policy instructions that aren't this step, or aimed at another of the owner's cards.
  assert.throws(() => m.assertCardSetupTransaction(wire(web3ix(sdk.buildCloseCardInstruction({ owner: ownerKey, cardId: otherCardId }, programId))), 0, input), refused, "close another card");
  assert.throws(() => m.assertCardSetupTransaction(wire(web3ix(sdk.buildWipeCardInstruction({ owner: ownerKey, cardId: otherCardId }, programId))), 1, input), refused, "wipe another card");
  assert.throws(() => m.assertCardSetupTransaction(wire(init({ cardId: otherCardId })), 0, input), refused, "init another card");
  assert.throws(() => m.assertCardSetupTransaction(wire(delegate({ cardId: otherCardId })), 1, input), refused, "delegate another card");
  assert.throws(() => m.assertCardSetupTransaction(wire(init()), 1, input), refused, "right instruction, wrong step");
  assert.throws(() => m.assertCardSetupTransaction(wire(init({ prefundLamports: 900_000_000n })), 0, input), refused, "prefund above the cap");
  // Escrow: only this card's escrow, capped.
  assert.throws(() => m.assertCardSetupTransaction(wire(topUp(m.MAX_ESCROW_TOP_UP_LAMPORTS + 1n)), 2, input), refused, "top-up above the cap");
  const other = sdk.deriveCardAccounts(ownerKey, otherCardId, programId);
  assert.throws(() => m.assertCardSetupTransaction(wire(topUp(20_000_000n, other.escrow, other.policy)), 2, input), refused, "another card's escrow");
  // Served accounts that aren't this card's.
  assert.throws(() => m.assertCardSetupTransaction(wire(init()), 0, { ...input, prepared: { ...prepared, accounts: { ...prepared.accounts, escrow: other.escrow } } }), refused);
  // Paid by someone else.
  const t = new Transaction({ feePayer: Keypair.generate().publicKey, recentBlockhash: "11111111111111111111111111111111" }).add(init());
  assert.throws(() => m.assertCardSetupTransaction(t, 0, input), refused);
});

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
function dialogSetup() {
  globalThis.CSS ??= { supports: () => false, escape: (value) => String(value) };
  dom.window.CSS ??= globalThis.CSS;
  const D = dom.window.HTMLDialogElement?.prototype;
  if (D && !D.showModal) { D.showModal = function () { this.setAttribute("open", ""); }; D.show = D.showModal; D.close = function () { this.removeAttribute("open"); }; }
}
const payButtons = () => [...document.querySelectorAll('[data-testid="repayment-dialog"]')].length
  ? [...document.querySelector('[data-testid="repayment-dialog"]').closest("dialog")?.querySelectorAll("button") ?? document.querySelectorAll("button")].filter((b) => /^Pay \$/.test(b.textContent.trim()))
  : [];

test("F4/X2: an unknown repayment outcome reads 'Outcome unknown — checking', Pay stays off, and no other permission can pay the same statement", async () => {
  dialogSetup();
  document.body.innerHTML = "";
  const source = m.createFixtureCardsSource({ delayMs: 0, repay: "unknown" });
  const [card] = await source.listCards();
  const statements = await source.statements(card.cardId);
  const calls = [];
  const fixturePay = source.payStatement;
  source.payStatement = async (...args) => { calls.push(args[2]); return fixturePay(...args); };
  const wallet = "Owner1111111111111111111111111111111111111";
  const mandates = [
    { address: "MandA111111111111111111111111111111111111", approvedAgent: wallet, allowedMint: USDC, status: "active" },
    { address: "MandB111111111111111111111111111111111111", approvedAgent: wallet, allowedMint: USDC, status: "active" },
  ];
  const { host, unmount } = await render(createElement(m.CardStatement, { source, card, statements, mandates, wallet, onChanged() {} }));
  await click([...host.querySelectorAll("button")].find((b) => /^Pay \$/.test(b.textContent.trim())));
  await settle(20);
  let [pay] = payButtons().slice(-1);
  assert.equal(pay.disabled || pay.getAttribute("aria-disabled") === "true", false, "payable before any attempt");
  await click(pay);
  await settle(20);
  const dialogText = document.querySelector('[data-testid="repayment-dialog"]').textContent;
  assert.match(document.querySelector('[data-testid="repay-unknown"]').textContent, /Outcome unknown — checking/);
  assert.doesNotMatch(dialogText, /Not paid/);
  [pay] = payButtons().slice(-1);
  assert.ok(pay.disabled || pay.getAttribute("aria-disabled") === "true", "Pay disabled after an unknown outcome");
  // The receipt to check is pre-filled from the attempt.
  const inputs = [...document.querySelectorAll('[data-testid="repayment-dialog"] input')];
  assert.ok(inputs.some((input) => input.value === "4RcptStatementFixture11111111111111111111"));
  await click(pay);
  await settle(10);
  assert.deepEqual(calls, ["MandA111111111111111111111111111111111111"], "paid once, never again through another permission");
  await unmount();
  document.body.innerHTML = "";
  // Re-opened later: the statement is checked across every permission before Pay can be used.
  const again = await render(createElement(m.CardStatement, { source, card, statements, mandates, wallet, onChanged() {} }));
  await click([...again.host.querySelectorAll("button")].find((b) => /^Pay \$/.test(b.textContent.trim())));
  await settle(20);
  [pay] = payButtons().slice(-1);
  assert.ok(pay.disabled || pay.getAttribute("aria-disabled") === "true", "still disabled after reopening");
  assert.ok(document.querySelector('[data-testid="repay-unknown"]'));
  await again.unmount();
  document.body.innerHTML = "";
});

test("X2: a receipt already on Solana under another permission closes the statement instead of offering Pay", async () => {
  dialogSetup();
  document.body.innerHTML = "";
  const source = m.createFixtureCardsSource({ delayMs: 0 });
  const [card] = await source.listCards();
  const statements = await source.statements(card.cardId);
  const seen = [];
  source.repaymentStatus = async (_s, addresses) => { seen.push(addresses); return { state: "paid", receiptPda: "RcptOnB", mandatePda: "MandB111111111111111111111111111111111111" }; };
  const submitted = [];
  source.submitRepayment = async (_c, _s, input) => { submitted.push(input); return { state: "repayment_observed" }; };
  let paid = 0;
  source.payStatement = async () => { paid += 1; throw new Error("must not be called"); };
  const wallet = "Owner1111111111111111111111111111111111111";
  const mandates = [
    { address: "MandA111111111111111111111111111111111111", approvedAgent: wallet, allowedMint: USDC, status: "active" },
    { address: "MandB111111111111111111111111111111111111", approvedAgent: wallet, allowedMint: USDC, status: "paused" },
  ];
  const { host, unmount } = await render(createElement(m.CardStatement, { source, card, statements, mandates, wallet, onChanged() {} }));
  await click([...host.querySelectorAll("button")].find((b) => /^Pay \$/.test(b.textContent.trim())));
  await settle(20);
  assert.deepEqual(seen[0], mandates.map((item) => item.address), "checked across every permission, eligible or not");
  assert.deepEqual(submitted, [{ receiptPda: "RcptOnB", mandatePda: "MandB111111111111111111111111111111111111" }]);
  assert.equal(paid, 0);
  await unmount();
  document.body.innerHTML = "";
  // A failed check never opens Pay.
  source.repaymentStatus = async () => { throw new Error("RPC unavailable"); };
  const failing = await render(createElement(m.CardStatement, { source, card, statements, mandates, wallet, onChanged() {} }));
  await click([...failing.host.querySelectorAll("button")].find((b) => /^Pay \$/.test(b.textContent.trim())));
  await settle(20);
  const [pay] = payButtons().slice(-1);
  assert.ok(pay.disabled || pay.getAttribute("aria-disabled") === "true");
  assert.match(document.querySelector('[data-testid="repay-check-failed"]').textContent, /Pay stays off/);
  await failing.unmount();
  document.body.innerHTML = "";
});

test("X2: the repayment lookup is per statement across permissions, and only an expired, receipt-less attempt reopens Pay", async () => {
  window.localStorage.clear();
  const digest = "ef".repeat(32);
  const none = await m.lookupRepayment({ digest, mandateAddresses: ["A"], getBlockHeight: async () => 1, findReceipt: async () => null });
  assert.deepEqual(none, { state: "none" });
  m.recordRepaymentAttempt(digest, { mandatePda: "A", receiptPda: "RA", lastValidBlockHeight: 100 });
  // Before expiry with no receipt: unknown, whatever other permissions exist.
  assert.deepEqual(await m.lookupRepayment({ digest, mandateAddresses: ["B"], getBlockHeight: async () => 90, findReceipt: async () => null }), { state: "unknown", receiptPda: "RA", mandatePda: "A" });
  // A receipt under another permission: paid.
  assert.deepEqual(await m.lookupRepayment({ digest, mandateAddresses: ["B"], getBlockHeight: async () => 90, findReceipt: async (mandate) => mandate === "B" ? "RB" : null }), { state: "paid", receiptPda: "RB", mandatePda: "B" });
  m.recordRepaymentAttempt(digest, { mandatePda: "A", receiptPda: "RA", lastValidBlockHeight: 100 });
  // The original permission is checked even when it's no longer listed.
  const asked = [];
  assert.equal((await m.lookupRepayment({ digest, mandateAddresses: [], getBlockHeight: async () => 90, findReceipt: async (mandate) => { asked.push(mandate); return mandate === "A" ? "RA" : null; } })).state, "paid");
  assert.deepEqual(asked, ["A"]);
  m.recordRepaymentAttempt(digest, { mandatePda: "A", receiptPda: "RA", lastValidBlockHeight: 100 });
  // Past its last valid height with no receipt: it can never land, so it's cleared.
  assert.deepEqual(await m.lookupRepayment({ digest, mandateAddresses: ["A"], getBlockHeight: async () => 101, findReceipt: async () => null }), { state: "none" });
  assert.deepEqual(m.readRepaymentAttempts(digest), []);
});

test("F5/X5: the privacy check says what was checked, and shows ChainPay's approver attestation with its real mode", async () => {
  // The review repro: hardware challenge-bound, build unreadable. Not "hardware verified", not "paused".
  const repro = { hardware: "challenge_bound", measurements: "unavailable", label: "Hardware verified, but the workload couldn't be checked, so approvals are paused" };
  assert.equal(m.attestationCopy(repro), "The private rollup answered a fresh challenge, but Intel's hardware signature wasn't checked here. Its build couldn't be checked.");
  assert.match(m.BROWSER_CHECK_NOTE, /doesn't pause anything/);
  // Axum's enum ("match", "unchecked") is normalized in one place.
  const served = m.normalizeApproverAttestation({ mode: "enforce", hardware: "verified", measurements: "match", checkedAt: "2026-10-04T10:00:00Z", label: "x" });
  assert.deepEqual(served, { mode: "enforce", hardware: "verified", measurements: "matched", checkedAt: "2026-10-04T10:00:00Z" });
  assert.equal(m.approverAttestationPassed(served), true);
  const report = m.normalizeApproverAttestation({ mode: "report", hardware: "verified", measurements: "match", label: "x" });
  assert.equal(m.approverAttestationPassed(report), false, "report mode never reads as a gate");
  assert.match(m.approverAttestationCopy(report), /Report only: purchases are still approved when this check fails/);
  assert.match(m.approverAttestationCopy(m.normalizeApproverAttestation({ mode: "enforce", hardware: "unchecked", measurements: "pending", label: "" })), /hardware wasn't checked/);
  assert.match(m.approverAttestationCopy(null), /hasn't reported/);
  // Rendered: the browser line plus the approver line from the card view.
  globalThis.CSS ??= { supports: () => false, escape: (value) => String(value) };
  const source = m.createFixtureCardsSource({ delayMs: 0, unlocked: true, attestation: "challenge_bound" });
  const [card] = await source.listCards();
  const { host, unmount } = await render(createElement(m.CardPrivacyCheck, { source, card, unlocked: true, onUnlocked() {} }));
  await click(button(host, "Run the check"));
  await settle(20);
  assert.doesNotMatch(host.querySelector('[data-testid="attestation"]').textContent, /paused|Hardware verified/);
  assert.match(host.querySelector('[data-testid="approver-attestation"]').textContent, /ChainPay's approver checks.*Report only/);
  assert.equal(host.querySelector('[data-testid="approver-attestation"]').dataset.mode, "report");
  await unmount();
});

test("F6: no card copy claims only the owner can read the limits", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = join(frontendRoot, "src/dashboard/cards");
  const files = [...(await readdir(dir)).filter((name) => /\.(tsx?|css)$/.test(name)).map((name) => join(dir, name)), join(frontendRoot, "src/dashboard/tabCopy.ts"), join(frontendRoot, "src/verify/CardVerifyPage.tsx")];
  const banned = [/only you (?:can )?(?:see|read)/i, /nobody else/i, /no ?one else/i, /only your wallet and people you add/i, /limits only you/i, /only lets you read/i, /without seeing anything else/i, /every other field on this card stays private/i];
  const hits = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const pattern of banned) if (pattern.test(text)) hits.push(`${file.replace(frontendRoot, "")}: ${pattern}`);
  }
  assert.deepEqual(hits, []);
  assert.equal(m.PRIVACY_COPY, "Hidden from the public chain and from wallets you haven't approved. ChainPay's approver, readers you add and the card issuer can see them.");
  // Rendered where the review found the overclaims.
  globalThis.CSS ??= { supports: () => false, escape: (value) => String(value) };
  const locked = m.createFixtureCardsSource({ delayMs: 0 });
  const list = await render(createElement(m.CardList, { source: locked, unlocked: false, onUnlocked() {}, onNavigate() {} }));
  await settle(20);
  assert.match(document.querySelector('[data-testid="cards-unlock"]').textContent, /ChainPay's approver, readers you add and the card issuer can see them/);
  await list.unmount();
});

test("F7: the card number closes on a section switch, a hidden tab and unmount", async () => {
  const live = { cardNumberSession: async () => ({ embedUrl: "https://sandbox.lithic.com/v1/embed?session=s1&type=PAN", expiresAt: new Date(Date.now() + 30_000).toISOString() }) };
  const view = (closeKey) => createElement(m.CardNumberReveal, { source: live, card, closeKey });
  const { host, root, unmount } = await render(view("activity"));
  await click(button(host, "Show card number"));
  await settle();
  assert.ok(host.querySelector("iframe"), "open");
  await act(async () => { root.render(view("statement")); });
  assert.equal(host.querySelector("iframe"), null, "section switch closes it");
  await click(button(host, "Show card number"));
  await settle();
  assert.ok(host.querySelector("iframe"));
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
  await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); });
  assert.equal(host.querySelector("iframe"), null, "hidden tab closes it");
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  await click(button(host, "Show card number"));
  await settle();
  await act(async () => { window.dispatchEvent(new window.Event("pagehide")); });
  assert.equal(host.querySelector("iframe"), null, "leaving the page closes it");
  await unmount();
  assert.equal(document.querySelector("iframe.cp-card-number-frame"), null, "unmount removes it");
});

test("F8: the share picker says the link reveals the owner's wallet; the verify page doesn't claim the rest is private", async () => {
  globalThis.CSS ??= { supports: () => false, escape: (value) => String(value) };
  const D = dom.window.HTMLDialogElement?.prototype;
  if (D && !D.showModal) { D.showModal = function () { this.setAttribute("open", ""); }; D.show = D.showModal; D.close = function () { this.removeAttribute("open"); }; }
  const source = m.createFixtureCardsSource({ delayMs: 0 });
  const [first] = await source.listCards();
  const picker = await render(createElement(m.CardSharePicker, { source, card: first, open: true, onClose() {} }));
  await settle();
  assert.match(document.querySelector('[data-testid="share-wallet-warning"]').textContent, /shows your wallet address/);
  await picker.unmount();
  document.body.innerHTML = "";
});

test("F9: a failed private read shows an error with a retry, never 'Private', and doesn't hide other cards", async () => {
  globalThis.CSS ??= { supports: () => false, escape: (value) => String(value) };
  const source = m.createFixtureCardsSource({ delayMs: 0, unlocked: true });
  const cards = await source.listCards();
  const read = source.readPrivate.bind(source);
  let failing = true;
  source.readPrivate = async (c) => { if (failing && c.cardId === cards[1].cardId) throw new Error("rpc down"); return read(c); };
  const { host, unmount } = await render(createElement(m.CardList, { source, unlocked: true, onUnlocked() {}, onNavigate() {} }));
  await settle(30);
  const rows = [...host.querySelectorAll("tbody tr")];
  assert.match(rows[0].textContent, /\$/, "other cards keep their values");
  assert.match(rows[1].textContent, /Couldn't load/);
  assert.doesNotMatch(rows[1].textContent, /Private/);
  assert.match(host.querySelector('[data-testid="cards-read-failed"]').textContent, /didn't load/);
  failing = false;
  await click(button(host, "Try again"));
  await settle(30);
  assert.equal(host.querySelector('[data-testid="cards-read-failed"]'), null);
  assert.doesNotMatch(host.querySelectorAll("tbody tr")[1].textContent, /Couldn't load/);
  await unmount();
  // A rollup RPC error (not thrown) is a failure too.
  const rpc = m.createFixtureCardsSource({ delayMs: 0, unlocked: true });
  rpc.readPrivate = async () => ({ policy: { state: "rpc_error", code: -32000 }, period: { state: "rpc_error", code: -32000 } });
  const second = await render(createElement(m.CardList, { source: rpc, unlocked: true, onUnlocked() {}, onNavigate() {} }));
  await settle(30);
  assert.ok(second.host.querySelector('[data-testid="cards-read-failed"]'));
  await second.unmount();
});

test("X12: card dashboard code is lazy, so /verify doesn't download it", async () => {
  const { readFile } = await import("node:fs/promises");
  const dashboard = await readFile(join(frontendRoot, "src/dashboard/Dashboard.tsx"), "utf8");
  assert.doesNotMatch(dashboard, /import \{ CardsArea \} from/);
  assert.match(dashboard, /lazy\(\(\) => import\("\.\/cards\/CardsArea"\)\)/);
  const config = await readFile(join(frontendRoot, "vite.config.ts"), "utf8");
  assert.match(config, /\/src\/dashboard\/cards\/.*return "cards"/);
});
