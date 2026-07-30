import { PublicKey } from "@solana/web3.js";
import type { Address, ChainPayInstruction, TokenProgram } from "./types.js";
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
