// /support runs on its own cluster config, separate from the devnet app config
// in ../config/public.ts. Nothing here is secret: the RPC must be a public,
// keyless endpoint because everything in a Vite env var ships to the browser.
import { PublicKey } from "@solana/web3.js";

export type SupportCluster = "mainnet" | "devnet";

const env = import.meta.env;

export const SUPPORT_LIVE = env.VITE_SUPPORT_LIVE === "true";
export const SUPPORT_CLUSTER: SupportCluster = env.VITE_SUPPORT_CLUSTER === "devnet" ? "devnet" : "mainnet";

// Set after the mainnet deploy (DEPLOY.md gate 3). Until then the page shows "Opening soon".
export const SUPPORT_PROGRAM_ID = env.VITE_SUPPORT_PROGRAM_ID ?? "";

export const SUPPORT_RPC_URL =
  env.VITE_SUPPORT_RPC_URL ??
  (SUPPORT_CLUSTER === "devnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");

// Convex HTTP route that serves the indexed contributions (convex/http.ts).
export const SUPPORT_TRACKER_URL = env.VITE_SUPPORT_TRACKER_URL ?? "";

// Circle's published USDC mints, classic SPL Token program.
export const USDC_MINTS: Record<SupportCluster, string> = {
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
};
export const USDC_MINT = USDC_MINTS[SUPPORT_CLUSTER];
export const USDC_DECIMALS = 6;
export const SOL_DECIMALS = 9;

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// Public GitHub handles shown next to each side. Side A is index 0 on-chain.
export const MAINTAINER_LABELS = ["@tantshirt", "@stawuah"] as const;

export const WALLET_CHAIN = SUPPORT_CLUSTER === "devnet" ? "solana:devnet" : "solana:mainnet";

export function explorerTx(signature: string) {
  const cluster = SUPPORT_CLUSTER === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

export function explorerAddress(address: string) {
  const cluster = SUPPORT_CLUSTER === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/address/${address}${cluster}`;
}

/** True only when every value the page needs to send money is present. */
export function supportReady() {
  return SUPPORT_LIVE && SUPPORT_PROGRAM_ID.length > 0;
}
