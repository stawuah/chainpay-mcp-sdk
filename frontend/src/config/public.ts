export const PROGRAM_ID = "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const DEVNET_PYUSD_TOKEN_2022_MINT = "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM";
export const HOSTED_BACKEND_URL = "https://chainpay-backend.onrender.com";
export const BACKEND_URL = import.meta.env.VITE_CHAINPAY_BACKEND_URL ?? HOSTED_BACKEND_URL;
export const HOSTED_RPC_URL = `${BACKEND_URL.replace(/\/$/, "")}/rpc`;
const configuredRpcUrl = (import.meta.env.VITE_CHAINPAY_RPC_URL ?? "").replace(/\/$/, "");
export const RPC_URL = configuredRpcUrl && configuredRpcUrl !== "https://api.devnet.solana.com"
  ? configuredRpcUrl
  : HOSTED_RPC_URL;
export const MCP_URL = import.meta.env.VITE_CHAINPAY_MCP_URL ?? "https://chainpay-mcp.onrender.com/mcp";
export const AGENT_URL = import.meta.env.VITE_CHAINPAY_AGENT_URL
  ?? `${MCP_URL.replace(/\/mcp\/?$/, "")}/agent/chat`;
