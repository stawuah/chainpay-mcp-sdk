// Crossmint orders stay hidden until a devnet order has been paid through a
// spending permission and Crossmint has marked it paid.
export const CROSSMINT_ENABLED = import.meta.env.VITE_CHAINPAY_CROSSMINT === "true";
export const PROGRAM_ID = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEVNET_PYUSD_TOKEN_2022_MINT = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM";
export const DEVNET_EURC_MINT = "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr";
export const DEVNET_USDG_TOKEN_2022_MINT = "4F6PM96JJxngmHnZLBh9n58RH4aTVNWvDs2nuwrT5BP7";
export const HOSTED_BACKEND_URL = "https://chainpay-relay.vercel.app";
export const BACKEND_URL = import.meta.env.VITE_CHAINPAY_BACKEND_URL ?? HOSTED_BACKEND_URL;
export const HOSTED_RPC_URL = `${BACKEND_URL.replace(/\/$/, "")}/rpc`;
const configuredRpcUrl = (import.meta.env.VITE_CHAINPAY_RPC_URL ?? "").replace(/\/$/, "");
export const RPC_URL = configuredRpcUrl && configuredRpcUrl !== "https://api.devnet.solana.com"
  ? configuredRpcUrl
  : HOSTED_RPC_URL;
export const MCP_URL = import.meta.env.VITE_CHAINPAY_MCP_URL ?? "https://chainpay-mcp.vercel.app/mcp";
export const AGENT_URL = import.meta.env.VITE_CHAINPAY_AGENT_URL
  ?? `${MCP_URL.replace(/\/mcp\/?$/, "")}/agent/chat`;
/** card_policy program on Devnet (same as the SDK's CARD_POLICY_PROGRAM_ID). Override per environment. */
export const CARD_POLICY_PROGRAM_ID = import.meta.env.VITE_CHAINPAY_CARD_POLICY_PROGRAM_ID || "Cz9vYKFZFwx8Bqag95xZtw8dqUjS4k9AoyMh1pFo82F";
/** Card issuer environment. Only Lithic sandbox exists today, so anything but "production" is sandbox. */
export type CardIssuerEnvironment = "sandbox" | "production";
export const CARD_ISSUER_ENV: CardIssuerEnvironment = import.meta.env.VITE_CHAINPAY_CARD_ISSUER_ENV === "production" ? "production" : "sandbox";
/** Simulated credit partner's Devnet USDC token account. Statement repayment is unavailable until it is set. */
export const CARD_PARTNER_TOKEN_ACCOUNT: string | null = import.meta.env.VITE_CHAINPAY_CARD_PARTNER_TOKEN_ACCOUNT || null;
