// Real dashboard and submission handler; fake account reads and an inert signer.
// The browser runner intercepts every service request. No valid signed wire exists.
import "../../src/polyfills";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { createRoot } from "react-dom/client";
import { PublicKey, type Transaction } from "@solana/web3.js";
import type { Mandate } from "@chainpay/sdk";
import { Dashboard } from "../../src/dashboard/Dashboard";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import { Router } from "../../src/routing/Router";
import { chainpayClient, publicReceiptClient } from "../../src/config/client";
import { BACKEND_URL, MCP_URL, DEVNET_USDC_MINT as MINT } from "../../src/config/public";
import { callMcpTool } from "../../src/owner/runtime";
import { configureSession, setSessionWallet, ensureSessionReady } from "../../src/session";

const OWNER = "11111111111111111111111111111111";
const MANDATE = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
const RECEIPT = "2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const mandate = {
  address: MANDATE, owner: OWNER, approvedAgent: OWNER, sourceTokenAccount: OWNER,
  allowedMint: MINT, maxPerPayment: 5_000_000n, totalLimit: 10_000_000n,
  amountSpent: 0n, paymentCount: 0n, expiresAtSlot: 400_000_000n,
  maxPaymentCount: 10n, cooldownSlots: 0n, lastPaymentSlot: 0n,
  paused: false, revoked: false, status: "active", tokenProgram: "spl-token",
} as Mandate;
const state = { approvals: 0 };
Object.assign(window, { submissionFixture: state });
chainpayClient.getMintDecimals = async () => 6;
chainpayClient.getPaymentsByMandate = async () => [];
chainpayClient.connection.getAccountInfo = async () => {
  const data = Buffer.alloc(165);
  data.set(new PublicKey(MINT).toBytes(), 0);
  data.set(new PublicKey(OWNER).toBytes(), 32);
  data.writeBigUInt64LE(10_000_000n, 64);
  data.writeUInt32LE(1, 72);
  data.set(new PublicKey(MANDATE).toBytes(), 76);
  data[108] = 1;
  data.writeBigUInt64LE(10_000_000n, 121);
  return { data, owner: new PublicKey(TOKEN_PROGRAM), executable: false, lamports: 2039280, rentEpoch: 0 };
};
chainpayClient.connection.getTokenAccountBalance = async () => ({ context: { slot: 1 }, value: { amount: "10000000", decimals: 6, uiAmount: 10, uiAmountString: "10" } });
chainpayClient.connection.getLatestBlockhash = async () => ({ blockhash: OWNER, lastValidBlockHeight: 100 });
chainpayClient.preparePayment = async request => ({
  request, receiptAddress: RECEIPT, preflight: { valid: true, checks: [{ name: "fixture-policy", ok: true, message: "Fixture policy passes" }] },
  transaction: { instructions: [], feePayer: OWNER, requiredSigners: [OWNER] },
}) as never;
// The success branch exposes a link; receipt content itself is tested elsewhere.
publicReceiptClient.readPublicReceipt = async () => { throw new Error("Fixture receipt read unavailable"); };
configureSession(BACKEND_URL, MCP_URL);
setSessionWallet({ address: OWNER, signMessage: async () => new Uint8Array(64) } as never);
await ensureSessionReady();
const noop = () => {};
createRoot(document.getElementById("root")!).render(<ChainPayTheme><Router><Dashboard
  wallet={OWNER} walletName="Fixture wallet" walletCapabilities={null}
  walletSigner={async () => { state.approvals++; return { serialize: () => new Uint8Array([0]) } as unknown as Transaction; }}
  mandate={mandate} mandates={[mandate]} mandateAddress={MANDATE}
  protocolConfig={{ authority: OWNER, supportedMints: [MINT], bump: 0 }}
  stablecoinOptions={[{ value: MINT, mint: MINT, label: "USDC", detail: "Local fixture", tokenProgram: "spl-token" }]}
  mcpTools={[]} mcpResult={null} integrationStatus="ready" integrationError=""
  switchingWalletAccount={false} tab="payments" onTabChange={noop} onNavigateHome={noop}
  onRefresh={async () => {}} onSelectMandate={noop} onChangeAccount={noop}
  onDisconnect={noop} onChangeWallet={noop} onCallMcp={callMcpTool}
/></Router></ChainPayTheme>);
