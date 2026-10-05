// /support runs on its own cluster config, separate from the devnet app config
// in ../config/public.ts. Nothing here is secret: the RPC must be a public,
// keyless endpoint because everything in a Vite env var ships to the browser.
//
// This release is Devnet only (audit 2026-10-05, R4). The page fails closed:
// it stays "Opening soon" unless every value below is present, well formed and
// says Devnet. Mainnet, an absent cluster or a mismatched value never opens it.
import { PublicKey } from "@solana/web3.js";

export type SupportCluster = "devnet";

const env = import.meta.env;

export const SUPPORT_LIVE = env.VITE_SUPPORT_LIVE === "true";
/** What the deploy asked for. Only an explicit "devnet" can open the page. */
export const SUPPORT_CLUSTER_SETTING: string = env.VITE_SUPPORT_CLUSTER ?? "";
/** The only cluster this release talks to, whatever the env says. */
export const SUPPORT_CLUSTER: SupportCluster = "devnet";

// Set after the authorized Devnet deploy (DEPLOY.md, "Devnet-only release").
export const SUPPORT_PROGRAM_ID: string = env.VITE_SUPPORT_PROGRAM_ID ?? "";

// The two recipient wallets from the signed setup comments. The page checks the
// initialized vault holds exactly these before it lets anyone sign.
export const SUPPORT_RECIPIENTS: readonly [string, string] = [env.VITE_SUPPORT_RECIPIENT_A ?? "", env.VITE_SUPPORT_RECIPIENT_B ?? ""];

// Convex HTTP route that serves the indexed contributions (convex/http.ts).
export const SUPPORT_TRACKER_URL: string = env.VITE_SUPPORT_TRACKER_URL ?? "";

// The page talks to the narrow relay next to the tracker (convex/supportRpc.ts),
// which keeps any RPC key server-side. VITE_SUPPORT_RPC_URL overrides it with a
// public, keyless Devnet endpoint.
const relayUrl = SUPPORT_TRACKER_URL.endsWith("/support/v1") ? SUPPORT_TRACKER_URL.replace(/\/support\/v1$/, "/support/rpc") : "";
export const SUPPORT_RPC_URL: string = env.VITE_SUPPORT_RPC_URL ?? (relayUrl || "https://api.devnet.solana.com");

// Circle's published Devnet USDC mint, classic SPL Token program. Test tokens only.
export const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const USDC_DECIMALS = 6;
export const SOL_DECIMALS = 9;

// The genesis hash Solana Devnet answers with. Anything else is another cluster.
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const UPGRADEABLE_LOADER_ID = "BPFLoaderUpgradeab1e11111111111111111111111";

// Throwaway keys from the splitter's test-config build. Never real recipients.
export const TEST_CONFIG_KEYS = new Set([
  "7v54NWdBtkjuAFJrLGsS2SXnuk8nKam81mZJeeYxVFi9",
  "6TcyBfPdBt1kjsvDZLzmBFnuMaLWiTaAt4RjUr9VA5YD",
  "AB3FQHskSYuWVw4M9EpGdxNzrAjBNiYGpbH4CVzLFene",
]);
const ALL_ZERO = "11111111111111111111111111111111";

// Public GitHub handles shown next to each side. Side A is index 0 on-chain.
export const MAINTAINER_LABELS = ["@tantshirt", "@stawuah"] as const;

// "Other token" swaps go through Jupiter, which only routes on mainnet. Off for
// the Devnet release: only Devnet SOL and Devnet USDC are offered.
export const SWAP_ENABLED = false;

export const WALLET_CHAIN = "solana:devnet" as const;

/** Always Devnet, so the explorer never shows a mainnet page for a test tip. */
export function explorerTx(signature: string) {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

export function explorerAddress(address: string) {
  return `https://explorer.solana.com/address/${address}?cluster=devnet`;
}

/** A real, non-placeholder public key, or null. */
export function realKey(value: string): PublicKey | null {
  if (!value || value === ALL_ZERO || TEST_CONFIG_KEYS.has(value)) return null;
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value ? key : null;
  } catch {
    return null;
  }
}

export type SupportSettings = {
  live: boolean;
  cluster: string;
  programId: string;
  trackerUrl: string;
  recipients: readonly [string, string];
};

export const SUPPORT_SETTINGS: SupportSettings = {
  live: SUPPORT_LIVE,
  cluster: SUPPORT_CLUSTER_SETTING,
  programId: SUPPORT_PROGRAM_ID,
  trackerUrl: SUPPORT_TRACKER_URL,
  recipients: SUPPORT_RECIPIENTS,
};

/**
 * Why this build can't open the page, or null when its settings are complete.
 * It reads only the build settings; readiness.ts then checks the chain.
 */
export function supportConfigProblem(settings: SupportSettings = SUPPORT_SETTINGS): string | null {
  if (!settings.live) return "Support is switched off.";
  if (settings.cluster !== "devnet") return "Support opens on Devnet only, and this build doesn't say Devnet.";
  if (!realKey(settings.programId)) return "The support program address is missing or not valid.";
  if (!/^https:\/\/[^/?#@]+\/support\/v1$/.test(settings.trackerUrl)) return "The support ledger address is missing or not valid.";
  const [a, b] = settings.recipients;
  if (!realKey(a) || !realKey(b)) return "The two recipient wallets are missing or still placeholders.";
  if (a === b) return "The two recipient wallets are the same.";
  return null;
}

/** True only when the build is complete for Devnet. Signing also waits for the on-chain check. */
export function supportReady(settings: SupportSettings = SUPPORT_SETTINGS) {
  return supportConfigProblem(settings) === null;
}
