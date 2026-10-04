// Builds the instructions for a contribution and reads the vault ledger.
//
// A SOL or USDC contribution is exactly three instructions (an "Other" token
// tip is built in swap.ts instead: compute budget, setup, one Jupiter swap, then
// the same memo + allocate_usdc). The optional watchdog, which lives outside this
// repo, compares the live page's transactions against these shapes:
//   1. transfer SOL (System) or USDC (transferChecked) from the donor to the vault
//   2. memo "chainpay-support:v1[ anon=1][ note=<text>]"
//   3. allocate_sol / allocate_usdc on the splitter
// There is deliberately no pay instruction here: a broken recipient account must
// never make someone's contribution fail.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MEMO_PROGRAM_ID,
  SOL_DECIMALS,
  TOKEN_PROGRAM_ID,
  USDC_DECIMALS,
} from "./config";

export type SupportAsset = "SOL" | "USDC";
export type Side = 0 | 1;

export const MEMO_PREFIX = "chainpay-support:v1";
export const NOTE_MAX = 80;

const DISCRIMINATORS = {
  allocateSol: [14, 16, 184, 134, 218, 1, 37, 35],
  allocateUsdc: [247, 47, 227, 223, 205, 143, 155, 56],
  paySol: [131, 101, 154, 50, 37, 136, 13, 67],
  payUsdc: [24, 1, 58, 95, 8, 82, 131, 221],
} as const;

export type SupportAccounts = {
  programId: PublicKey;
  vault: PublicKey;
  vaultUsdc: PublicKey;
  usdcMint: PublicKey;
};

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function supportAccounts(programId: string, usdcMint: string): SupportAccounts {
  const program = new PublicKey(programId);
  const mint = new PublicKey(usdcMint);
  const vault = PublicKey.findProgramAddressSync([new TextEncoder().encode("vault")], program)[0];
  return { programId: program, vault, vaultUsdc: associatedTokenAddress(vault, mint), usdcMint: mint };
}

/** Strips control characters and clamps to NOTE_MAX characters. */
export function cleanNote(note: string) {
  return Array.from(note.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim())
    .slice(0, NOTE_MAX)
    .join("");
}

export function buildMemo(note: string, hideAddress: boolean) {
  const cleaned = cleanNote(note);
  return [MEMO_PREFIX, hideAddress ? "anon=1" : "", cleaned ? `note=${cleaned}` : ""].filter(Boolean).join(" ");
}

/**
 * Parses a decimal amount ("0.1", "25") into exact base units. Returns null for
 * anything that isn't a positive number with at most `decimals` places.
 */
export function toBaseUnits(text: string, decimals: number): bigint | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units <= 0n || units > 0xffff_ffff_ffff_ffffn) return null;
  return units;
}

export function formatUnits(units: bigint, decimals: number) {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${fraction ? `.${fraction}` : ""}`;
}

export function decimalsFor(asset: SupportAsset) {
  return asset === "SOL" ? SOL_DECIMALS : USDC_DECIMALS;
}

function u64(value: bigint) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function transferCheckedIx(source: PublicKey, mint: PublicKey, destination: PublicKey, owner: PublicKey, amount: bigint, decimals: number) {
  const data = new Uint8Array(10);
  data[0] = 12; // TokenInstruction::TransferChecked
  data.set(u64(amount), 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export function allocateIx(asset: SupportAsset, accounts: SupportAccounts) {
  if (asset === "SOL") {
    return new TransactionInstruction({
      programId: accounts.programId,
      keys: [{ pubkey: accounts.vault, isSigner: false, isWritable: true }],
      data: Buffer.from(DISCRIMINATORS.allocateSol),
    });
  }
  return new TransactionInstruction({
    programId: accounts.programId,
    keys: [
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.vaultUsdc, isSigner: false, isWritable: false },
      { pubkey: accounts.usdcMint, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(DISCRIMINATORS.allocateUsdc),
  });
}

export function contributionInstructions(input: {
  donor: PublicKey;
  asset: SupportAsset;
  amount: bigint;
  note: string;
  hideAddress: boolean;
  accounts: SupportAccounts;
}) {
  const { donor, asset, amount, accounts } = input;
  const transfer =
    asset === "SOL"
      ? SystemProgram.transfer({ fromPubkey: donor, toPubkey: accounts.vault, lamports: amount })
      : transferCheckedIx(
          associatedTokenAddress(donor, accounts.usdcMint),
          accounts.usdcMint,
          accounts.vaultUsdc,
          donor,
          amount,
          USDC_DECIMALS,
        );
  const memo = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: donor, isSigner: true, isWritable: false }],
    data: Buffer.from(new TextEncoder().encode(buildMemo(input.note, input.hideAddress))),
  });
  return [transfer, memo, allocateIx(asset, accounts)];
}

/** Anyone may pay a side; the program decides where the money goes. */
export function payoutInstructions(input: {
  asset: SupportAsset;
  side: Side;
  recipient: PublicKey;
  payer: PublicKey;
  accounts: SupportAccounts;
}) {
  const { asset, side, recipient, payer, accounts } = input;
  if (asset === "SOL") {
    return [
      new TransactionInstruction({
        programId: accounts.programId,
        keys: [
          { pubkey: accounts.vault, isSigner: false, isWritable: true },
          { pubkey: recipient, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([...DISCRIMINATORS.paySol, side]),
      }),
    ];
  }
  const destination = associatedTokenAddress(recipient, accounts.usdcMint);
  // The recipient's USDC account may not exist yet; whoever presses "Pay out" funds it.
  const createDestination = new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: false },
      { pubkey: accounts.usdcMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
  return [
    createDestination,
    new TransactionInstruction({
      programId: accounts.programId,
      keys: [
        { pubkey: accounts.vault, isSigner: false, isWritable: true },
        { pubkey: accounts.vaultUsdc, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: accounts.usdcMint, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([...DISCRIMINATORS.payUsdc, side]),
    }),
  ];
}

export type LedgerView = { owed: [bigint, bigint]; allocatedEach: bigint; paid: [bigint, bigint] };
export type VaultView = { recipients: [string, string]; sol: LedgerView; usdc: LedgerView };

/** Decodes the on-chain Vault account (8-byte discriminator + borsh fields). */
export function decodeVault(data: Uint8Array): VaultView {
  if (data.length < 8 + 64 + 40 + 40 + 1) throw new Error("Vault account is too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const key = (offset: number) => new PublicKey(data.slice(offset, offset + 32)).toBase58();
  const ledger = (offset: number): LedgerView => ({
    owed: [view.getBigUint64(offset, true), view.getBigUint64(offset + 8, true)],
    allocatedEach: view.getBigUint64(offset + 16, true),
    paid: [view.getBigUint64(offset + 24, true), view.getBigUint64(offset + 32, true)],
  });
  return { recipients: [key(8), key(40)], sol: ledger(72), usdc: ledger(112) };
}

export function shortAddress(address: string) {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}
