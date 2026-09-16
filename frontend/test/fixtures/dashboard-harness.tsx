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
import { useState } from "react";
import { createRoot } from "react-dom/client";
import Dashboard from "../../src/dashboard/Dashboard";
import type { DashboardTab } from "../../src/routing/paths";
import type { Mandate } from "@chainpay/sdk";
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

const EMPTY = new URLSearchParams(location.search).has("empty");
const noop = async () => {};

function Harness() {
  const [tab, setTab] = useState<DashboardTab>(
    (new URLSearchParams(location.search).get("tab") as DashboardTab) || "overview",
  );
  return (
    <Dashboard
      wallet={OWNER}
      walletName="Design Harness"
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
