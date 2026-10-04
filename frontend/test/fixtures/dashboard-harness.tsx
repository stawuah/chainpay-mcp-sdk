// Browser design harness: the real Dashboard, all tabs, no wallet and no backend.
//
// AppWorkspace gates the dashboard on a single truthy string (AppWorkspace.tsx:23),
// and hands Dashboard every piece of state it needs as a prop. So mounting Dashboard
// directly with fixture props renders the genuine panels with zero production changes.
//
// Test-only Vite entry. Not imported by production and not in its build. It cannot
// sign a real transaction. Opt-in approval checks use invalid fixture bytes and
// intercept every service request in memory. Amounts are fixture
// base units, not balances.
import "../../src/polyfills";
import { chainpayClient, publicReceiptClient } from "../../src/config/client";
import { PublicKey, type Transaction } from "@solana/web3.js";
import { setSessionWallet } from "../../src/session";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "../../src/dashboard/Dashboard";
import type { CardSection, DashboardTab } from "../../src/routing/paths";
import { setCardsSourceOverride } from "../../src/dashboard/cards/source";
import { createFixtureCardsSource, FIXTURE_CARD_IDS } from "../../src/dashboard/cards/fixtureSource";
import type { Mandate, PaymentReceipt } from "@chainpay/sdk";
import { Router } from "../../src/routing/Router";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import crossmintInbox from "./inbox-crossmint.json";
import { ownerReceiptRelay } from "../../src/receipts/owner";
import purchase from "./receipt-purchase.json";
import orders from "./mandate-request.json";

const OWNER = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function mandate(over: Partial<Mandate> & { address: string }): Mandate {
  return {
    owner: OWNER,
    approvedAgent: "AgEnT111111111111111111111111111111111111111",
    sourceTokenAccount: "SrcAta1111111111111111111111111111111111111",
    allowedMint: USDC,
    maxPerPayment: 5_000_000n,
    totalLimit: 250_000_000n,
    amountSpent: 91_500_000n,
    paymentCount: 12n,
    expiresAtSlot: 400_000_000n,
    maxPaymentCount: 100n,
    cooldownSlots: 0n,
    lastPaymentSlot: 399_000_000n,
    paused: false,
    revoked: false,
    status: "active",
    tokenProgram: "spl-token",
    createdAt: 1757894400,
    ...over,
  } as Mandate;
}

const MANDATES: Mandate[] = [
  mandate({ address: "MdT1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
  mandate({
    address: "MdT2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    approvedAgent: "AgEnT2222222222222222222222222222222222222222",
    totalLimit: 100_000_000n,
    amountSpent: 8_250_000n,
    paymentCount: 3n,
    status: "paused",
    paused: true,
  }),
  mandate({
    address: "MdT3ccccccccccccccccccccccccccccccccccccccc",
    approvedAgent: "AgEnT3333333333333333333333333333333333333333",
    totalLimit: 40_000_000n,
    amountSpent: 40_000_000n,
    paymentCount: 9n,
    status: "expired",
  }),
];

const STABLECOINS = [{
  value: USDC,
  mint: USDC,
  label: "USDC",
  detail: "Devnet fixture",
  tokenProgram: "spl-token" as const,
}];

const TOOLS = [
  { name: "create_mandate", description: "Create an on-chain spending permission for an agent.", inputSchema: { type: "object", properties: { maxPerPayment: { type: "string" } } } },
  { name: "prepare_payment", description: "Build an unsigned payment that fits the mandate policy.", inputSchema: { type: "object", properties: { amount: { type: "string" }, recipient: { type: "string" } } } },
  { name: "execute_payment", description: "Relay an approved payment and return its receipt.", inputSchema: { type: "object", properties: { signature: { type: "string" } } } },
  { name: "get_payment", description: "Read a settled receipt by its PDA.", inputSchema: { type: "object", properties: { receipt: { type: "string" } } } },
];

const CONFIG = {
  address: "CfG1111111111111111111111111111111111111111",
  authority: OWNER,
  supportedMints: [USDC],
  bump: 254,
};

// Opt-in deterministic network reads for the real three-step review. No signer
// is supplied, and these fixtures cannot send a transaction.
if (new URLSearchParams(location.search).has("ready")) {
  chainpayClient.getCurrentSlot = async () => 399_999_000n;
  chainpayClient.getMintDecimals = async () => 6;
  chainpayClient.getTokenProgram = async () => "spl-token";
  chainpayClient.connection.getRecentPerformanceSamples = async () => [{slot:399999000,numSlots:150,numTransactions:1,samplePeriodSecs:60}];
  chainpayClient.getSupportedAsset = async () => ({ enabled:true, tokenProgram:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mint:USDC }) as never;
  chainpayClient.getPaymentsByMandate = async () => [];
  chainpayClient.connection.getAccountInfo = async () => {
    const data = Buffer.alloc(165);
    data.set(new PublicKey(USDC).toBytes(), 0);
    data.set(new PublicKey(OWNER).toBytes(), 32);
    data[108] = 1;
    return {data,owner:new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),executable:false,lamports:2039280,rentEpoch:0};
  };
}

// Crossmint prototype: every request state, seeded into the real inbox store.
// Only visible when the dev server runs with VITE_CHAINPAY_CROSSMINT=true.
const CROSSMINT = new URLSearchParams(location.search).has("crossmint");
if (CROSSMINT) {
  // Keep blocked metadata on an otherwise approvable request: a stage of
  // "blocked" would hide the approval even if the Crossmint guard regressed.
  const inbox = new URLSearchParams(location.search).has("crossmint-review")
    ? crossmintInbox.map((item) => item.stage === "blocked" ? { ...item, stage: "waiting_for_approval" } : item)
    : crossmintInbox;
  localStorage.setItem(`chainpay.ai-inbox.v1:${OWNER}`, JSON.stringify(inbox));
}

if (CROSSMINT || new URLSearchParams(location.search).has("receipts")) {
  // An original 282-byte receipt: no limits recorded at payment.
  const receipt: PaymentReceipt = {
    address:"2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1", mandate:MANDATES[0].address,
    invoiceHash:new Uint8Array(32).fill(1), paymentId:new Uint8Array(32).fill(2), mint:USDC,
    recipient:OWNER,sourceTokenAccount:OWNER,recipientTokenAccount:OWNER,amount:4500001n,
    agent:OWNER,executedAtSlot:399999000n,signatureReference:new Uint8Array(32),status:"confirmed",onChainStatus:1,bump:255,
    policySnapshot:null,
  };
  // A 371-byte receipt with the program's policy snapshot, paying the
  // fixture's seller-signed invoice (its hash is the invoice hash).
  const v2: PaymentReceipt = {
    address:"3Rcpt2v2SnapshotFixture111111111111111111", mandate:MANDATES[0].address,
    invoiceHash:Uint8Array.from(purchase.invoiceHash.match(/../g)!.map((byte) => parseInt(byte, 16))), paymentId:new Uint8Array(32).fill(4), mint:USDC,
    recipient:purchase.request.payload.recipient,sourceTokenAccount:OWNER,recipientTokenAccount:purchase.request.payload.recipient,amount:4500000n,
    agent:"AgEnT111111111111111111111111111111111111111",executedAtSlot:399999200n,signatureReference:new Uint8Array(32).fill(5),status:"confirmed",onChainStatus:1,bump:254,
    policySnapshot:{ version:1, maxPerPayment:5_000_000n, totalLimit:50_000_000n, amountSpentAfter:12_000_000n, paymentCountAfter:3n, maxPaymentCount:10n, expiresAtSlot:405_000_000n, cooldownSlots:0n },
  };
  const byAddress = new Map([receipt, v2].map((item) => [item.address, item]));
  chainpayClient.getPaymentsByMandate = async (address) => (address === MANDATES[0].address ? [v2, receipt] : []);
  chainpayClient.getMintDecimals = async () => 6;
  publicReceiptClient.getCurrentSlot = async () => 399_999_500n;
  publicReceiptClient.readPublicReceipt = async (address) => {
    const found = byAddress.get(address) ?? receipt;
    return {
      receipt:{valid:true,receipt:found},
      amount:{baseUnits:found.amount.toString(),decimals:6,display:found.amount === 4500000n ? "4.500000" : "4.500001",displayKind:"ui-amount"},
      currentMandate:{status:"present",mandate:MANDATES[0]},
    } as never;
  };
  // Stand-in for the owner's relay session: the signed invoice for the v2 receipt only.
  ownerReceiptRelay.request = async (address) => (address === v2.address ? purchase.request : null);
  ownerReceiptRelay.policy = async () => null;
}

// Permission requests: `?permission=vendor|grantee|expired|tampered` puts that
// fixture link's `#req=` fragment in the URL, as a requester's link would, and
// mounts Dashboard on the /app/requests/permission route. Deterministic keys;
// not a real vendor or budget.
const PERMISSION = new URLSearchParams(location.search).get("permission");
if (PERMISSION && !location.hash.includes("req=")) {
  const fragment = (orders as Record<string, { fragment?: string }>)[PERMISSION]?.fragment;
  if (fragment) history.replaceState(null, "", `${location.pathname}${location.search}#req=${fragment}`);
}
if (PERMISSION) chainpayClient.getCurrentSlot = async () => BigInt(orders.currentSlot);

// `?orders` adds accepted orders: a purchase order linked to the first
// permission with a receipt that matches it, and a budget request linked to
// the second, whose agent is the request's agent. The relay is a stand-in.
if (new URLSearchParams(location.search).has("orders")) {
  MANDATES[1] = { ...MANDATES[1], approvedAgent: orders.grantee.agent, status: "active", paused: false };
  const hex = (value: string) => Uint8Array.from(value.match(/../g)!.map((byte) => parseInt(byte, 16)));
  const matched: PaymentReceipt = {
    address:"4RcptMatchedPurchaseFixture11111111111111", mandate:MANDATES[0].address,
    invoiceHash:hex(orders.invoice.invoiceHash), paymentId:new Uint8Array(32).fill(6), mint:USDC,
    recipient:orders.vendor.ata,sourceTokenAccount:OWNER,recipientTokenAccount:orders.vendor.ata,amount:4500000n,
    agent:OWNER,executedAtSlot:399999300n,signatureReference:new Uint8Array(32).fill(7),status:"confirmed",onChainStatus:1,bump:253,
    policySnapshot:{ version:1, maxPerPayment:5_000_000n, totalLimit:50_000_000n, amountSpentAfter:4_500_000n, paymentCountAfter:1n, maxPaymentCount:0n, expiresAtSlot:406_479_000n, cooldownSlots:0n },
  };
  const budget: PaymentReceipt = {
    address:"5RcptBudgetFixture1111111111111111111111111", mandate:MANDATES[1].address,
    invoiceHash:new Uint8Array(32).fill(8), paymentId:new Uint8Array(32).fill(9), mint:USDC,
    recipient:OWNER,sourceTokenAccount:OWNER,recipientTokenAccount:"Dest1111111111111111111111111111111111111",amount:2000000n,
    agent:orders.grantee.agent,executedAtSlot:399999400n,signatureReference:new Uint8Array(32).fill(10),status:"confirmed",onChainStatus:1,bump:252,
    policySnapshot:null,
  };
  const all = [matched, budget];
  const previousPayments = chainpayClient.getPaymentsByMandate.bind(chainpayClient);
  chainpayClient.getPaymentsByMandate = async (address) => [
    ...all.filter((item) => item.mandate === address),
    ...(await previousPayments(address).catch(() => [])),
  ];
  chainpayClient.getMintDecimals = async () => 6;
  publicReceiptClient.getCurrentSlot = async () => 399_999_500n;
  const previousRead = publicReceiptClient.readPublicReceipt.bind(publicReceiptClient);
  publicReceiptClient.readPublicReceipt = async (address, ...rest) => {
    const found = all.find((item) => item.address === address);
    if (!found) return previousRead(address, ...rest);
    return {
      receipt:{valid:true,receipt:found},
      amount:{baseUnits:found.amount.toString(),decimals:6,display:(Number(found.amount) / 1e6).toFixed(6),displayKind:"ui-amount"},
      currentMandate:{status:"present",mandate:MANDATES.find((item) => item.address === found.mandate) ?? MANDATES[0]},
    } as never;
  };
  const previousRequest = ownerReceiptRelay.request;
  ownerReceiptRelay.request = async (address) => (address === matched.address ? orders.invoice.request : previousRequest(address));
  ownerReceiptRelay.policy = async () => null;
  ownerReceiptRelay.mandateRequest = async (mandate) => (
    mandate === MANDATES[0].address ? orders.vendor.request : mandate === MANDATES[1].address ? orders.grantee.request : null
  );
}

// `?link=fail` makes the stand-in relay refuse the first link attempt, so the
// retry path can be seen. Otherwise linking succeeds without a backend.
{
  let failures = new URLSearchParams(location.search).get("link") === "fail" ? 1 : 0;
  ownerReceiptRelay.linkMandateRequest = async () => {
    if (failures > 0) {
      failures -= 1;
      return new Response(JSON.stringify({ error: "The relay could not read the new permission yet" }), { status: 502 });
    }
    return new Response("{}", { status: 200 });
  };
}

// Exercise the post-wallet continuation without keys or any network submission.
const FIXTURE_APPROVAL = new URLSearchParams(location.search).has("fixture-approval");
const approvalEvidence = { signatures: 0, submissions: 0, links: 0, slot: orders.currentSlot };
Object.assign(window, { permissionApprovalEvidence: approvalEvidence });
let fixtureSigner: ((transaction: Transaction) => Promise<Transaction>) | undefined;
if (FIXTURE_APPROVAL) {
  chainpayClient.getCurrentSlot = async () => BigInt(approvalEvidence.slot);
  chainpayClient.connection.getLatestBlockhash = async () => ({ blockhash: OWNER, lastValidBlockHeight: 999999999 });
  fixtureSigner = async () => {
    approvalEvidence.signatures += 1;
    return { serialize: () => new Uint8Array([0]) } as unknown as Transaction;
  };
  setSessionWallet({ address: OWNER, signMessage: async () => new Uint8Array(64) } as never);
  // Deliberately no fallback: nothing in this fixture mode can reach a relay.
  window.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/v1/auth/challenge") return json({ challenge_id: "fixture", message: "Fixture sign-in" });
    if (url.pathname === "/v1/auth/session") return json({ token: "fixture", wallet: OWNER, expires_at_ms: Date.now() + 600000 });
    if (url.pathname === "/v1/transactions/submit") {
      approvalEvidence.submissions += 1;
      return json({ status: "confirmed", signature: "FixturePermissionSignature" });
    }
    return new Response("{}", { status: 404 });
  };
  const link = ownerReceiptRelay.linkMandateRequest;
  ownerReceiptRelay.linkMandateRequest = async (...args) => { approvalEvidence.links += 1; return link(...args); };
}

const EMPTY = new URLSearchParams(location.search).has("empty");

// Cards: `?tab=cards[&cards=empty|locked][&card=data|research|travel][&section=…][&new=1][&statement=<state>][&ack=1][&attest=verified|challenge_bound|mismatch|failed][&repay=unknown][&restore=tampered][&reads=unreadable]`.
// ILLUSTRATIVE fixtures through the same CardsSource interface the live SDK
// client implements. Nothing signs or reaches a network.
const CARD_QUERY = new URLSearchParams(location.search);
// Statement repayment needs a permission the owner signs: add one only for that view.
if (CARD_QUERY.has("repay")) MANDATES.push(mandate({ address: "MdT4dddddddddddddddddddddddddddddddddddddddd", approvedAgent: OWNER, amountSpent: 0n, paymentCount: 0n }));
setCardsSourceOverride(createFixtureCardsSource({
  empty: CARD_QUERY.get("cards") === "empty",
  unlocked: CARD_QUERY.get("cards") !== "locked",
  statement: (CARD_QUERY.get("statement") as never) ?? undefined,
  freezeAck: CARD_QUERY.has("ack"),
  attestation: (CARD_QUERY.get("attest") as never) ?? undefined,
  repay: (CARD_QUERY.get("repay") as never) ?? undefined,
  restore: (CARD_QUERY.get("restore") as never) ?? undefined,
  reads: (CARD_QUERY.get("reads") as never) ?? undefined,
}));
const CARD_KEY = CARD_QUERY.get("card") as keyof typeof FIXTURE_CARD_IDS | null;
type CardRoute = { cardsNew?: boolean; cardId?: string; cardSection?: CardSection };
const noop = async () => {};

function Harness() {
  const [tab, setTab] = useState<DashboardTab>(
    (new URLSearchParams(location.search).get("tab") as DashboardTab) || "overview",
  );
  const [cardRoute, setCardRoute] = useState<CardRoute>({
    cardsNew: CARD_QUERY.has("new") || undefined,
    cardId: CARD_KEY ? FIXTURE_CARD_IDS[CARD_KEY] : undefined,
    cardSection: (CARD_QUERY.get("section") as CardSection) ?? undefined,
  });
  return (
    <Dashboard
      wallet={OWNER}
      walletSigner={fixtureSigner}
      walletName="Jupiter"
      walletCapabilities={null}
      mandate={EMPTY ? null : MANDATES[0]}
      mandates={EMPTY ? [] : MANDATES}
      mandateAddress={EMPTY ? undefined : MANDATES[0].address}
      protocolConfig={EMPTY ? null : CONFIG}
      stablecoinOptions={STABLECOINS}
      mcpTools={EMPTY ? [] : (TOOLS as never)}
      mcpResult={null}
      integrationStatus="ready"
      integrationError=""
      switchingWalletAccount={false}
      tab={tab}
      permissionRequest={Boolean(PERMISSION)}
      cardsNew={cardRoute.cardsNew}
      cardId={cardRoute.cardId}
      cardSection={cardRoute.cardSection}
      onTabChange={(next, options) => { setTab(next); setCardRoute({ cardsNew: options?.cardsNew, cardId: options?.cardId, cardSection: options?.cardSection }); }}
      onNavigateHome={() => {}}
      onRefresh={noop}
      onSelectMandate={() => {}}
      onChangeAccount={() => {}}
      onDisconnect={() => {}}
      onChangeWallet={() => {}}
      onCallMcp={async () => ({ content: [] }) as never}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <ChainPayTheme><Router><Harness /></Router></ChainPayTheme>,
);
