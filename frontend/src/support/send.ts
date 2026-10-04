// Signs once, then sends the same signed bytes until the outcome is known.
// Re-sending identical bytes can never create a second contribution: the
// network treats it as the same transaction (same signature).
import { Connection, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import type { ChainPayWallet, SolanaChain } from "../wallet/connect";
import { SUPPORT_RPC_URL, WALLET_CHAIN } from "./config";
import { associatedTokenAddress, type SupportAccounts, type SupportAsset } from "./donation";

export type SendOutcome =
  | { status: "confirmed"; signature: string }
  | { status: "failed"; signature: string; message: string }
  | { status: "unknown"; signature: string };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array) {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += "1";
  }
  return out + digits.reverse().map((d) => B58[d]).join("");
}

let connection: Connection | null = null;
export function supportConnection() {
  connection ??= new Connection(SUPPORT_RPC_URL, "confirmed");
  return connection;
}

const FEE_BUFFER_LAMPORTS = 10_000n;

/** Returns a plain-English problem, or null when the wallet can cover it. */
export async function checkBalance(owner: PublicKey, asset: SupportAsset, amount: bigint, accounts: SupportAccounts) {
  const rpc = supportConnection();
  const lamports = BigInt(await rpc.getBalance(owner, "confirmed"));
  const network = WALLET_CHAIN === "solana:mainnet" ? "mainnet" : "devnet";
  const hint = `If your wallet is set to a different network, switch it to ${network} and try again.`;
  if (asset === "SOL") {
    if (lamports < amount + FEE_BUFFER_LAMPORTS) return `Not enough SOL in this wallet on ${network}. ${hint}`;
    return null;
  }
  if (lamports < FEE_BUFFER_LAMPORTS) return `This wallet needs a little SOL on ${network} for the network fee.`;
  const ata = associatedTokenAddress(owner, accounts.usdcMint);
  try {
    const balance = await rpc.getTokenAccountBalance(ata, "confirmed");
    if (BigInt(balance.value.amount) < amount) return `Not enough USDC in this wallet on ${network}. ${hint}`;
  } catch {
    return `No USDC in this wallet on ${network}. ${hint}`;
  }
  return null;
}

export async function signForSupport(wallet: ChainPayWallet, instructions: TransactionInstruction[]) {
  const rpc = supportConnection();
  const { blockhash, lastValidBlockHeight } = await rpc.getLatestBlockhash("confirmed");
  const transaction = new Transaction({ feePayer: new PublicKey(wallet.address), blockhash, lastValidBlockHeight });
  transaction.add(...instructions);
  const signed = await wallet.signTransaction(transaction, { chain: WALLET_CHAIN as SolanaChain });
  if (!signed.signature) throw new Error("The wallet didn't sign the transaction.");
  return {
    raw: signed.serialize(),
    signature: base58(signed.signature),
    lastValidBlockHeight,
  };
}

function isSimulationFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /simulation failed|custom program error|insufficient|InstructionError/i.test(message);
}

/** Sends signed bytes and waits for a definite answer, or says it doesn't know. */
export async function sendSigned(signed: { raw: Uint8Array; signature: string; lastValidBlockHeight: number }): Promise<SendOutcome> {
  const rpc = supportConnection();
  try {
    await rpc.sendRawTransaction(signed.raw, { maxRetries: 3, preflightCommitment: "confirmed" });
  } catch (error) {
    if (isSimulationFailure(error)) {
      return { status: "failed", signature: signed.signature, message: friendlyError(error) };
    }
    // The network may have it anyway. Fall through and ask.
  }
  return waitForOutcome(signed.signature, signed.lastValidBlockHeight);
}

export async function waitForOutcome(signature: string, lastValidBlockHeight: number): Promise<SendOutcome> {
  const rpc = supportConnection();
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const { value } = await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = value[0];
      if (status?.err) return { status: "failed", signature, message: "The transaction failed on-chain. Nothing was taken except the network fee." };
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        return { status: "confirmed", signature };
      }
      const height = await rpc.getBlockHeight("confirmed");
      if (!status && height > lastValidBlockHeight) {
        return { status: "failed", signature, message: "It expired before landing. Nothing was sent. You can try again." };
      }
    } catch {
      // RPC hiccup: keep asking.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return { status: "unknown", signature };
}

export function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/reject|denied|cancel/i.test(message)) return "You cancelled it in your wallet. Nothing was sent.";
  if (/insufficient/i.test(message)) return "Not enough funds in this wallet for this amount plus the network fee.";
  return "Something went wrong before it was sent. Nothing left your wallet.";
}
