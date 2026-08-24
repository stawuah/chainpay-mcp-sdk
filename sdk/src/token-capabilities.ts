import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  getAccount,
  getCpiGuard,
  getDefaultAccountState,
  getEpochFee,
  getExtensionTypes,
  getMemoTransfer,
  getMint,
  getPausableConfig,
  getTransferFeeConfig,
  getTransferHook,
} from "@solana/spl-token";
import { PublicKey, type Commitment, type Connection } from "@solana/web3.js";
import type { Address, TokenCapabilityProfile, TokenProgram } from "./types.js";
import { publicKey } from "./encoding.js";

const CONFIDENTIAL_TRANSFER_FEE_CONFIG = 16;
const CONFIDENTIAL_TRANSFER_FEE_AMOUNT = 17;

const KNOWN_MINT_EXTENSIONS = new Set<number>([
  ExtensionType.TransferFeeConfig,
  ExtensionType.MintCloseAuthority,
  ExtensionType.ConfidentialTransferMint,
  ExtensionType.DefaultAccountState,
  ExtensionType.NonTransferable,
  ExtensionType.InterestBearingConfig,
  ExtensionType.PermanentDelegate,
  ExtensionType.TransferHook,
  CONFIDENTIAL_TRANSFER_FEE_CONFIG,
  ExtensionType.MetadataPointer,
  ExtensionType.TokenMetadata,
  ExtensionType.GroupPointer,
  ExtensionType.TokenGroup,
  ExtensionType.GroupMemberPointer,
  ExtensionType.TokenGroupMember,
  ExtensionType.ScaledUiAmountConfig,
  ExtensionType.PausableConfig,
  ExtensionType.PermissionedBurn,
]);

const KNOWN_ACCOUNT_EXTENSIONS = new Set<number>([
  ExtensionType.TransferFeeAmount,
  ExtensionType.ConfidentialTransferAccount,
  ExtensionType.ImmutableOwner,
  ExtensionType.MemoTransfer,
  ExtensionType.CpiGuard,
  ExtensionType.NonTransferableAccount,
  ExtensionType.TransferHookAccount,
  CONFIDENTIAL_TRANSFER_FEE_AMOUNT,
  ExtensionType.PausableAccount,
]);

function extensionName(extension: number): string {
  if (extension === CONFIDENTIAL_TRANSFER_FEE_CONFIG) return "ConfidentialTransferFeeConfig";
  if (extension === CONFIDENTIAL_TRANSFER_FEE_AMOUNT) return "ConfidentialTransferFeeAmount";
  return ExtensionType[extension as ExtensionType] ?? `UnknownExtension(${extension})`;
}

function unexpectedExtensions(
  extensions: ExtensionType[],
  known: ReadonlySet<number>,
  scope: string,
): string[] {
  return extensions
    .filter((extension) => !known.has(extension))
    .map((extension) => `${scope} has unsupported ${extensionName(extension)}`);
}

export async function inspectTokenCapabilities(
  connection: Connection,
  input: {
    mint: Address;
    sourceTokenAccount: Address;
    recipientTokenAccount: Address;
    tokenProgram: TokenProgram;
    commitment?: Commitment;
  },
): Promise<TokenCapabilityProfile> {
  const programId = input.tokenProgram === "token-2022"
    ? SPL_TOKEN_2022_PROGRAM_ID
    : SPL_TOKEN_PROGRAM_ID;
  const mintAddress = publicKey(input.mint);
  const commitment = input.commitment ?? "confirmed";
  const [mint, source, recipient] = await Promise.all([
    getMint(connection, mintAddress, commitment, programId),
    getAccount(connection, publicKey(input.sourceTokenAccount), commitment, programId),
    getAccount(connection, publicKey(input.recipientTokenAccount), commitment, programId),
  ]);
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!mint.isInitialized) blockers.push("mint is not initialized");
  if (!source.isInitialized) blockers.push("source token account is not initialized");
  if (!recipient.isInitialized) blockers.push("recipient token account is not initialized");
  if (!source.mint.equals(mintAddress)) blockers.push("source token account mint does not match payment mint");
  if (!recipient.mint.equals(mintAddress)) blockers.push("recipient token account mint does not match payment mint");
  if (source.isFrozen) blockers.push("source token account is frozen");
  if (recipient.isFrozen) blockers.push("recipient token account is frozen");

  const mintExtensions = input.tokenProgram === "token-2022" ? getExtensionTypes(mint.tlvData) : [];
  const sourceExtensions = input.tokenProgram === "token-2022" ? getExtensionTypes(source.tlvData) : [];
  const recipientExtensions = input.tokenProgram === "token-2022" ? getExtensionTypes(recipient.tlvData) : [];
  let transferFee: TokenCapabilityProfile["transferFee"];
  let transferHookProgram: Address | undefined;

  if (input.tokenProgram === "token-2022") {
    blockers.push(...unexpectedExtensions(mintExtensions, KNOWN_MINT_EXTENSIONS, "mint"));
    blockers.push(...unexpectedExtensions(sourceExtensions, KNOWN_ACCOUNT_EXTENSIONS, "source account"));
    blockers.push(...unexpectedExtensions(recipientExtensions, KNOWN_ACCOUNT_EXTENSIONS, "recipient account"));

    if (mintExtensions.includes(ExtensionType.NonTransferable)) {
      blockers.push("mint is non-transferable");
    }
    if (sourceExtensions.includes(ExtensionType.NonTransferableAccount) || recipientExtensions.includes(ExtensionType.NonTransferableAccount)) {
      blockers.push("payment uses a non-transferable token account");
    }

    const feeConfig = getTransferFeeConfig(mint);
    if (feeConfig) {
      const epoch = BigInt((await connection.getEpochInfo(commitment)).epoch);
      const fee = getEpochFee(feeConfig, epoch);
      transferFee = {
        basisPoints: fee.transferFeeBasisPoints,
        maximumFee: fee.maximumFee,
      };
      if (fee.transferFeeBasisPoints !== 0 || fee.maximumFee !== 0n) {
        blockers.push("non-zero transfer fees require gross/net/withheld-fee receipt support");
      }
    }

    const hook = getTransferHook(mint);
    if (hook && !hook.programId.equals(PublicKey.default)) {
      transferHookProgram = hook.programId.toBase58();
      blockers.push("active transfer hook requires verified on-chain extra-account resolution and a Devnet-tested adapter");
    }

    const memo = getMemoTransfer(recipient);
    if (memo?.requireIncomingTransferMemos) {
      blockers.push("recipient requires an incoming memo, but the memo-aware settlement adapter is not enabled");
    }
    const cpiGuard = getCpiGuard(source);
    if (cpiGuard?.lockCpi) {
      blockers.push("source account CPI guard blocks the current Anchor delegate transfer path");
    }
    const pausable = getPausableConfig(mint);
    if (pausable?.paused) blockers.push("mint transfers are paused");

    const defaultState = getDefaultAccountState(mint);
    if (defaultState?.state === AccountState.Frozen) {
      warnings.push("mint defaults new token accounts to frozen; current source and recipient were checked individually");
    }
    if (mintExtensions.includes(ExtensionType.ConfidentialTransferMint)) {
      warnings.push("confidential extension is present; ChainPay uses only the transparent transfer_checked balance path");
    }
  }

  return {
    mint: mint.address.toBase58(),
    tokenProgram: input.tokenProgram,
    compatible: blockers.length === 0,
    mintExtensions: mintExtensions.map(extensionName),
    sourceAccountExtensions: sourceExtensions.map(extensionName),
    recipientAccountExtensions: recipientExtensions.map(extensionName),
    blockers,
    warnings,
    ...(transferFee ? { transferFee } : {}),
    ...(transferHookProgram ? { transferHookProgram } : {}),
  };
}
