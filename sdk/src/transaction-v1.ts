import { address as kitAddress } from "@solana/addresses";
import { AccountRole } from "@solana/instructions";
import type { Blockhash } from "@solana/rpc-types";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageLoadedAccountsDataSizeLimit,
} from "@solana/transaction-messages";
import { compileTransaction, getTransactionEncoder } from "@solana/transactions";
import { SYSTEM_PROGRAM_ID } from "./constants.js";
import { address } from "./encoding.js";
import type { Address, ChainPayInstruction, PreparedTransaction } from "./types.js";

/** Dashboard and unsigned wallets stay on this unless compile is called with version 1. */
export const DEFAULT_TRANSACTION_VERSION = "legacy" as const;
export type ProductionTransactionVersion = typeof DEFAULT_TRANSACTION_VERSION | 1;

/** Explicit v1 budgets. Defaults are unused; v1 treats omitted limits as zero. */
export const V1_COMPUTE_UNIT_LIMIT = 200_000;
export const V1_LOADED_ACCOUNTS_DATA_SIZE_LIMIT = 65_536;

export type V1CompileOptions = {
  version: 1;
  lifetime: {
    blockhash: string;
    lastValidBlockHeight: bigint;
  };
  computeUnitLimit: number;
  loadedAccountsDataSizeLimit: number;
};

function accountRole(key: ChainPayInstruction["keys"][number]): AccountRole {
  if (key.isSigner && key.isWritable) return AccountRole.WRITABLE_SIGNER;
  if (key.isSigner) return AccountRole.READONLY_SIGNER;
  if (key.isWritable) return AccountRole.WRITABLE;
  return AccountRole.READONLY;
}

function kitInstruction(instruction: ChainPayInstruction) {
  return {
    programAddress: kitAddress(address(instruction.programId)),
    accounts: instruction.keys.map((key) => ({
      address: kitAddress(address(key.address)),
      role: accountRole(key),
    })),
    data: instruction.data,
  };
}

export function systemTransferInstruction(from: Address, to: Address, lamports: bigint): ChainPayInstruction {
  if (lamports <= 0n) throw new Error("amount must be positive");
  const data = new Uint8Array(12);
  data[0] = 2;
  const view = new DataView(data.buffer);
  view.setBigUint64(4, lamports, true);
  return {
    name: "system_transfer",
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { address: address(from), isSigner: true, isWritable: true },
      { address: address(to), isSigner: false, isWritable: true },
    ],
    data,
  };
}

export function compileV1TransactionBytes(
  prepared: PreparedTransaction,
  options: V1CompileOptions,
): Uint8Array {
  if (options.version !== 1) throw new Error("compileV1TransactionBytes requires version 1");
  if (options.computeUnitLimit <= 0 || options.computeUnitLimit > 1_400_000) {
    throw new Error("V1 compute unit limit must be explicit and at most 1400000");
  }
  if (options.loadedAccountsDataSizeLimit <= 0 || options.loadedAccountsDataSizeLimit > 64 * 1024 * 1024) {
    throw new Error("V1 loaded accounts data size limit must be explicit and at most 64 MiB");
  }
  if (prepared.instructions.length === 0) throw new Error("A prepared transaction needs instructions");
  const feePayer = prepared.feePayer ?? prepared.requiredSigners[0];
  if (!feePayer) throw new Error("A prepared transaction needs a fee payer");

  const empty = createTransactionMessage({ version: 1 });
  const withFeePayer = setTransactionMessageFeePayer(kitAddress(address(feePayer)), empty);
  const withLifetime = setTransactionMessageLifetimeUsingBlockhash({
    blockhash: options.lifetime.blockhash as Blockhash,
    lastValidBlockHeight: options.lifetime.lastValidBlockHeight,
  }, withFeePayer);
  const withCompute = setTransactionMessageComputeUnitLimit(options.computeUnitLimit, withLifetime);
  const withDataLimit = setTransactionMessageLoadedAccountsDataSizeLimit(options.loadedAccountsDataSizeLimit, withCompute);
  const withInstructions = appendTransactionMessageInstructions(
    prepared.instructions.map(kitInstruction),
    withDataLimit,
  );
  const compiled = compileTransaction(withInstructions);
  return new Uint8Array(getTransactionEncoder().encode(compiled));
}
