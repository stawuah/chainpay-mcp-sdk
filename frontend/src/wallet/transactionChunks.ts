import type { PreparedTransaction } from "@chainpay/sdk";
import { toWeb3Transaction } from "@chainpay/sdk";

export const DEFAULT_TX_SIZE_LIMIT = 1_100;

export function chunkPreparedTransactions(
  transactions: PreparedTransaction[],
  blockhash: string,
  sizeLimit = DEFAULT_TX_SIZE_LIMIT,
): PreparedTransaction[] {
  const chunks: PreparedTransaction[] = [];
  let current: PreparedTransaction = { instructions: [], requiredSigners: [], feePayer: transactions[0]?.feePayer ?? "" };

  for (const transaction of transactions) {
    const candidate: PreparedTransaction = {
      instructions: [...current.instructions, ...transaction.instructions],
      requiredSigners: [...new Set([...current.requiredSigners, ...transaction.requiredSigners])],
      feePayer: current.feePayer || transaction.feePayer,
    };
    const size = toWeb3Transaction(candidate, blockhash).serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    if (current.instructions.length > 0 && size > sizeLimit) {
      chunks.push(current);
      current = { ...transaction, instructions: [...transaction.instructions] };
      const singleSize = toWeb3Transaction(current, blockhash).serialize({ requireAllSignatures: false, verifySignatures: false }).length;
      if (singleSize > sizeLimit) {
        throw new Error("One operation is too large to fit in a single transaction.");
      }
      continue;
    }
    current = candidate;
  }

  if (current.instructions.length > 0) chunks.push(current);
  return chunks;
}
