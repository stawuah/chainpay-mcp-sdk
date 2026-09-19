// Browser design harness: the real Dashboard, all tabs, no wallet and no backend.
//
// AppWorkspace gates the dashboard on a single truthy string (AppWorkspace.tsx:23),
// and hands Dashboard every piece of state it needs as a prop. So mounting Dashboard
// directly with fixture props renders the genuine panels with zero production changes.
//
// Test-only Vite entry. Not imported by production and not in its build. It cannot
// sign or submit a transaction: every handler here is inert. Amounts are fixture
// base units, not balances.
import "../../src/polyfills";
import { chainpayClient, publicReceiptClient } from "../../src/config/client";
import { PublicKey } from "@solana/web3.js";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "../../src/dashboard/Dashboard";
import type { DashboardTab } from "../../src/routing/paths";
import type { Mandate, PaymentReceipt } from "@chainpay/sdk";
import { Router } from "../../src/routing/Router";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";

const OWNER = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function mandate(over: Partial<Mandate> & { address: string }): Mandate {
  return {
    owner: OWNER,
    approvedAgent: "AgEnT111111111111111111111111111111111111111",
    sourceTokenAccount: "SrcAta11111111111111111111111111111111111111",
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

if (new URLSearchParams(location.search).has("receipts")) {
  const receipt: PaymentReceipt = {
    address:"2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1", mandate:MANDATES[0].address,
    invoiceHash:new Uint8Array(32).fill(1), paymentId:new Uint8Array(32).fill(2), mint:USDC,
    recipient:OWNER,sourceTokenAccount:OWNER,recipientTokenAccount:OWNER,amount:4500001n,
    agent:OWNER,executedAtSlot:399999000n,signatureReference:new Uint8Array(32),status:"confirmed",onChainStatus:1,bump:255,
  };
  chainpayClient.getPaymentsByMandate = async () => [receipt];
  chainpayClient.getMintDecimals = async () => 6;
  publicReceiptClient.readPublicReceipt = async () => ({
    receipt:{valid:true,receipt}, amount:{baseUnits:"4500001",decimals:6,display:"4.500001",displayKind:"ui-amount"}, currentMandate:{status:"absent"},
  }) as never;
}

const EMPTY = new URLSearchParams(location.search).has("empty");
const noop = async () => {};

function Harness() {
  const [tab, setTab] = useState<DashboardTab>(
    (new URLSearchParams(location.search).get("tab") as DashboardTab) || "overview",
  );
  return (
    <Dashboard
      wallet={OWNER}
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
      onTabChange={(next) => setTab(next)}
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
