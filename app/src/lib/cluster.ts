export const DEVNET_RPC_URL = "https://api.devnet.solana.com";

export function requiresDevnetWarning(cluster: string): boolean {
  return cluster !== "devnet";
}
