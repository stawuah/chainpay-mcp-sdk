// A real, finalized ChainPay receipt on Solana Devnet that anyone can open
// without a wallet. It is an older receipt (no on-chain limits snapshot), so
// its card says the limits at payment were not recorded.
// A constant on purpose: the landing bundle never reads build-time env values.
export const DEMO_RECEIPT_PDA = "7R1i9ccD7tZoXozceTMeTueWSfSs9F1jANQcCHcEsh2q";
export const DEMO_RECEIPT_PATH = `/verify/${DEMO_RECEIPT_PDA}`;
