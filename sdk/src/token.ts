import { PublicKey } from "@solana/web3.js";
import type { Address, ChainPayInstruction, PaymentPreflightContext, TokenProgram } from "./types.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "./constants.js";
import {
  instruction,
  meta,
  publicKey,
  systemProgramMeta,
  tokenProgramAddress,
} from "./encoding.js";

export function deriveAssociatedTokenAddress(
  owner: Address,
  mint: Address,
  tokenProgram: TokenProgram,
): Address {
  // The ATA program derives addresses from owner, token program, and mint.
  // Keeping this helper in the SDK avoids making callers duplicate the
  // classic SPL versus Token-2022 distinction.
  return PublicKey.findProgramAddressSync(
    [
      publicKey(owner).toBytes(),
      publicKey(tokenProgramAddress(tokenProgram)).toBytes(),
      publicKey(mint).toBytes(),
    ],
    publicKey(ASSOCIATED_TOKEN_PROGRAM_ID),
  )[0].toBase58();
}

export function buildCreateAssociatedTokenAccountInstruction(input: {
  payer: Address;
  owner: Address;
  mint: Address;
  tokenProgram: TokenProgram;
}): ChainPayInstruction {
  const associatedTokenAccount = deriveAssociatedTokenAddress(
    input.owner,
    input.mint,
    input.tokenProgram,
  );

  return instruction(
    "create_associated_token_account",
    ASSOCIATED_TOKEN_PROGRAM_ID,
    [
      meta(input.payer, true, true),
      meta(associatedTokenAccount, true),
      meta(input.owner),
      meta(input.mint),
      systemProgramMeta(),
      meta(tokenProgramAddress(input.tokenProgram)),
    ],
    new Uint8Array(),
  );
}

export function associatedTokenProgramAddress(): Address {
  return ASSOCIATED_TOKEN_PROGRAM_ID;
}

export type TokenAccountFields = {
  mint: Address;
  owner: Address;
  balance: bigint;
  delegate: Address | null;
  delegatedAmount: bigint;
};

export function readTokenAccountFields(data: Uint8Array | Buffer): TokenAccountFields | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < 165) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const delegateOption = view.getUint32(72, true);
  return {
    mint: new PublicKey(bytes.slice(0, 32)).toBase58(),
    owner: new PublicKey(bytes.slice(32, 64)).toBase58(),
    balance: view.getBigUint64(64, true),
    delegate: delegateOption === 0 ? null : new PublicKey(bytes.slice(76, 108)).toBase58(),
    delegatedAmount: bytes.length >= 129 ? view.getBigUint64(121, true) : 0n,
  };
}

export function paymentPreflightContextFromTokenAccount(
  data: Uint8Array | Buffer,
): PaymentPreflightContext | null {
  const fields = readTokenAccountFields(data);
  if (!fields) return null;
  return {
    sourceBalance: fields.balance,
    sourceOwner: fields.owner,
    delegate: fields.delegate,
    delegatedAmount: fields.delegatedAmount,
  };
}
