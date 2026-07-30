import {
  Connection,
  Transaction,
  TransactionInstruction,
  type Commitment,
} from "@solana/web3.js";
import type { ChainPayInstruction, PreparedTransaction, SimulationResult } from "./types.js";
import { publicKey } from "./encoding.js";

export function toWeb3Instruction(instruction: ChainPayInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: publicKey(instruction.programId),
    keys: instruction.keys.map((key) => ({
      pubkey: publicKey(key.address),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(instruction.data),
  });
}

export function toWeb3Transaction(prepared: PreparedTransaction, recentBlockhash: string): Transaction {
  const feePayer = prepared.feePayer ?? prepared.requiredSigners[0];
  if (!feePayer) throw new Error("A prepared transaction needs a fee payer");
  return new Transaction({ feePayer: publicKey(feePayer), recentBlockhash }).add(
    ...prepared.instructions.map(toWeb3Instruction),
  );
}

export async function simulatePrepared(
  connection: Connection,
  prepared: PreparedTransaction,
  commitment: Commitment,
): Promise<SimulationResult> {
  const { blockhash } = await connection.getLatestBlockhash(commitment);
  const result = await connection.simulateTransaction(
    toWeb3Transaction(prepared, blockhash),
    undefined,
    false,
  );
  return {
    ok: result.value.err === null,
    logs: result.value.logs ?? [],
    unitsConsumed: result.value.unitsConsumed == null ? undefined : BigInt(result.value.unitsConsumed),
    error: result.value.err ? JSON.stringify(result.value.err) : undefined,
  };
}

export { Connection };
