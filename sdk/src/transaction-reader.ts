import { getTransactionDecoder, getTransactionEncoder } from "@solana/transactions";
import { getCompiledTransactionMessageDecoder, getCompiledTransactionMessageEncoder } from "@solana/transaction-messages";

/** Read-only official codec boundary. Production construction remains legacy. */
export function decodeSupportedTransaction(bytes: Uint8Array) {
  if (bytes.length === 0 || bytes.length > 4096) throw new Error("Transaction exceeds the supported wire size");
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 1 && bytes.length > 1232) throw new Error("Legacy/v0 transaction exceeds 1232 bytes");
  const canonicalMessage = getCompiledTransactionMessageEncoder().encode(message);
  if (canonicalMessage.length !== transaction.messageBytes.length || canonicalMessage.some((value, index) => value !== transaction.messageBytes[index])) throw new Error("Noncanonical transaction message bytes");
  const canonical = getTransactionEncoder().encode(transaction);
  if (canonical.length !== bytes.length || canonical.some((value, index) => value !== bytes[index])) throw new Error("Noncanonical transaction wire bytes");
  return { transaction, message };
}
