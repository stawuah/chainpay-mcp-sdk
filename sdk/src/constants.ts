import type { Address } from "./types.js";

export const DEFAULT_PROGRAM_ID: Address =
  "3H9TV1EPR2BAQgVmcMqpufiZKPXbAMnjHp13LA9Lndv4";
export const DEVNET_RPC_URL = "https://api.devnet.solana.com";
export const SYSTEM_PROGRAM_ID: Address = "11111111111111111111111111111111";
export const SPL_TOKEN_PROGRAM_ID: Address =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID: Address =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM_ID: Address =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

export const DISCRIMINATORS = {
  initializeConfig: Uint8Array.from([208, 127, 21, 1, 194, 190, 196, 70]),
  createMandate: Uint8Array.from([230, 170, 158, 68, 33, 169, 16, 158]),
  executePayment: Uint8Array.from([86, 4, 7, 7, 120, 139, 232, 139]),
  pauseMandate: Uint8Array.from([192, 108, 97, 124, 56, 229, 236, 3]),
  revokeMandate: Uint8Array.from([252, 97, 140, 119, 67, 43, 177, 108]),
  updateMandate: Uint8Array.from([69, 131, 248, 29, 105, 50, 139, 30]),
  registerAsset: Uint8Array.from([21, 80, 155, 149, 117, 207, 235, 16]),
  setAssetStatus: Uint8Array.from([58, 54, 181, 102, 68, 238, 240, 245]),
  approveChecked: Uint8Array.from([13]),
  revokeDelegate: Uint8Array.from([5]),
} as const;

export const ACCOUNT_DISCRIMINATORS = {
  protocolConfig: Uint8Array.from([207, 91, 250, 28, 152, 179, 215, 209]),
  supportedAsset: Uint8Array.from([129, 27, 96, 192, 89, 180, 227, 200]),
  paymentMandate: Uint8Array.from([139, 106, 43, 122, 82, 211, 96, 162]),
  paymentReceipt: Uint8Array.from([168, 198, 209, 4, 60, 235, 126, 109]),
} as const;

export const MANDATE_SEED = "mandate";
export const CONFIG_SEED = "config";
export const RECEIPT_SEED = "receipt";
export const ASSET_SEED = "asset";

export const RECEIPT_STATUS_SETTLED = 1;
