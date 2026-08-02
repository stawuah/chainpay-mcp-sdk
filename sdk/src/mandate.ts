import type {
  Address,
  ChainPayInstruction,
  PreparedMandate,
  PreparedTransaction,
  TokenProgram,
} from "./types.js";
import { DEFAULT_PROGRAM_ID } from "./constants.js";
import {
  encodeApproveChecked,
  encodeCreateMandate,
  encodePauseMandate,
  encodeRevokeDelegate,
  encodeRevokeMandate,
  encodeRegisterAsset,
  encodeSetAssetStatus,
  encodeUpdateMandate,
  instruction,
  meta,
  publicKey,
  systemProgramMeta,
  tokenProgramAddress,
  writeU64,
} from "./encoding.js";
import { deriveAssetAddress, deriveConfigAddress, deriveMandateAddress } from "./pda.js";

export type CreateMandateInput = {
  approvedAgent: Address;
  sourceTokenAccount: Address;
  allowedMint: Address;
  allowedRecipient: Address;
  maxPerPayment: bigint;
  totalLimit: bigint;
  expiresAtSlot: bigint;
  maxPaymentCount: bigint;
  cooldownSlots: bigint;
  tokenProgram: TokenProgram;
  delegateAmount?: bigint;
};

export type UpdateMandateInput = {
  approvedAgent: Address;
  allowedRecipient: Address;
  maxPerPayment: bigint;
  totalLimit: bigint;
  expiresAtSlot: bigint;
  maxPaymentCount: bigint;
  cooldownSlots: bigint;
  paused: boolean;
  tokenProgram: TokenProgram;
};

export type RegisterAssetInput = {
  mint: Address;
  tokenProgram: TokenProgram;
};

export function validateMandateInput(input: CreateMandateInput): void {
  publicKey(input.approvedAgent);
  publicKey(input.sourceTokenAccount);
  publicKey(input.allowedMint);
  publicKey(input.allowedRecipient);
  writeU64(input.maxPerPayment, "maxPerPayment");
  writeU64(input.totalLimit, "totalLimit");
  writeU64(input.expiresAtSlot, "expiresAtSlot");
  writeU64(input.maxPaymentCount, "maxPaymentCount");
  writeU64(input.cooldownSlots, "cooldownSlots");
  if (input.maxPerPayment <= 0n) {
    throw new Error("maxPerPayment must be positive");
  }
  if (input.totalLimit < input.maxPerPayment) {
    throw new Error("totalLimit must cover maxPerPayment");
  }
  if (input.expiresAtSlot <= 0n) {
    throw new Error("expiresAtSlot must be positive");
  }
  if (input.delegateAmount !== undefined) {
    writeU64(input.delegateAmount, "delegateAmount");
    if (input.delegateAmount <= 0n) throw new Error("delegateAmount must be positive");
  }
}

export function buildCreateMandateInstruction(
  input: CreateMandateInput,
  owner: Address,
  programId: Address = DEFAULT_PROGRAM_ID,
): ChainPayInstruction {
  validateMandateInput(input);
  const config = deriveConfigAddress(programId);
  const asset = deriveAssetAddress(input.allowedMint, programId);
  const mandate = deriveMandateAddress(owner, programId);
  const tokenProgram = tokenProgramAddress(input.tokenProgram);

  return instruction(
    "create_mandate",
    programId,
    [
      meta(config),
      meta(asset),
      meta(mandate, true),
      meta(owner, true, true),
      meta(input.allowedMint),
      meta(input.sourceTokenAccount),
      meta(input.allowedRecipient),
      meta(tokenProgram),
      systemProgramMeta(),
    ],
    encodeCreateMandate(input),
  );
}

export function buildRegisterAssetInstruction(
  input: RegisterAssetInput,
  authority: Address,
  programId: Address = DEFAULT_PROGRAM_ID,
): ChainPayInstruction {
  publicKey(input.mint);
  publicKey(authority);
  return instruction(
    "register_asset",
    programId,
    [
      meta(deriveConfigAddress(programId)),
      meta(deriveAssetAddress(input.mint, programId), true),
      meta(authority, false, true),
      meta(input.mint),
      meta(tokenProgramAddress(input.tokenProgram)),
      systemProgramMeta(),
    ],
    encodeRegisterAsset(input.mint),
  );
}

export function buildSetAssetStatusInstruction(
  mint: Address,
  authority: Address,
  enabled: boolean,
  programId: Address = DEFAULT_PROGRAM_ID,
): ChainPayInstruction {
  publicKey(mint);
  publicKey(authority);
  return instruction(
    "set_asset_status",
    programId,
    [
      meta(deriveConfigAddress(programId)),
      meta(deriveAssetAddress(mint, programId), true),
      meta(authority, false, true),
    ],
    encodeSetAssetStatus(enabled),
  );
}

export function buildApproveDelegateInstruction(
  input: Pick<CreateMandateInput, "sourceTokenAccount" | "allowedMint" | "tokenProgram" | "totalLimit"> & {
    owner: Address;
    mandate?: Address;
    delegateAmount?: bigint;
    decimals: number;
  },
): ChainPayInstruction {
  const mandate = input.mandate ?? deriveMandateAddress(input.owner);
  const amount = input.delegateAmount ?? input.totalLimit;
  writeU64(amount, "delegateAmount");

  return instruction(
    "approve_delegate",
    tokenProgramAddress(input.tokenProgram),
    [
      meta(input.sourceTokenAccount, true),
      meta(input.allowedMint),
      meta(mandate),
      meta(input.owner, false, true),
    ],
    encodeApproveChecked(amount, input.decimals),
  );
}

export function buildRevokeDelegateInstruction(
  sourceTokenAccount: Address,
  owner: Address,
  tokenProgram: TokenProgram,
): ChainPayInstruction {
  return instruction(
    "revoke_delegate",
    tokenProgramAddress(tokenProgram),
    [meta(sourceTokenAccount, true), meta(owner, false, true)],
    encodeRevokeDelegate(),
  );
}

export function buildCreateMandateTransaction(
  input: CreateMandateInput,
  owner: Address,
  programId: Address = DEFAULT_PROGRAM_ID,
  decimals?: number,
): PreparedMandate {
  validateMandateInput(input);
  const mandateAddress = deriveMandateAddress(owner, programId);
  if (decimals === undefined) {
    throw new Error("Token decimals are required to prepare delegate approval");
  }
  const create = buildCreateMandateInstruction(input, owner, programId);
  const approve = buildApproveDelegateInstruction({
    ...input,
    owner,
    mandate: mandateAddress,
    decimals,
  });
  const transaction: PreparedTransaction = {
    instructions: [create, approve],
    requiredSigners: [owner],
    feePayer: owner,
  };

  return {
    mandateAddress,
    configAddress: deriveConfigAddress(programId),
    transaction,
  };
}

export function buildUpdateMandateInstruction(
  input: UpdateMandateInput,
  owner: Address,
  programId: Address = DEFAULT_PROGRAM_ID,
): ChainPayInstruction {
  publicKey(owner);
  publicKey(input.approvedAgent);
  publicKey(input.allowedRecipient);
  writeU64(input.maxPerPayment, "maxPerPayment");
  writeU64(input.totalLimit, "totalLimit");
  writeU64(input.expiresAtSlot, "expiresAtSlot");
  writeU64(input.maxPaymentCount, "maxPaymentCount");
  writeU64(input.cooldownSlots, "cooldownSlots");
  if (input.maxPerPayment <= 0n) throw new Error("maxPerPayment must be positive");
  if (input.totalLimit < input.maxPerPayment) throw new Error("totalLimit must cover maxPerPayment");

  return instruction(
    "update_mandate",
    programId,
    [
      meta(deriveMandateAddress(owner, programId), true),
      meta(owner, false, true),
      meta(input.allowedRecipient),
      meta(tokenProgramAddress(input.tokenProgram)),
    ],
    encodeUpdateMandate(input),
  );
}

export function buildPauseMandateInstruction(
  owner: Address,
  programId: Address = DEFAULT_PROGRAM_ID,
): ChainPayInstruction {
  return instruction(
    "pause_mandate",
    programId,
    [meta(deriveMandateAddress(owner, programId), true), meta(owner, false, true)],
    encodePauseMandate(),
  );
}

export function buildRevokeMandateInstruction(
  owner: Address,
  programId: Address = DEFAULT_PROGRAM_ID,
): ChainPayInstruction {
  return instruction(
    "revoke_mandate",
    programId,
    [meta(deriveMandateAddress(owner, programId), true), meta(owner, false, true)],
    encodeRevokeMandate(),
  );
}
