// Before anyone can sign a tip, the page reads the chain (through the same RPC
// path it sends with) and checks the splitter is really set up on Devnet:
//   - the RPC answers with Devnet's genesis hash,
//   - the program is a deployed, executable program,
//   - the vault is the program's PDA, owned by the program, with the Vault layout,
//   - its two recipients are real keys and equal the configured ones,
//   - the vault's USDC account is the vault's ATA for Circle's Devnet USDC mint,
//     owned by the vault, with no delegate and no close authority,
//   - the mint is that USDC mint (6 decimals).
// Any miss blocks signing with a reason and a retry. It only reads; it never signs.
import { PublicKey } from "@solana/web3.js";
import {
  DEVNET_GENESIS_HASH,
  SUPPORT_SETTINGS,
  TOKEN_PROGRAM_ID,
  UPGRADEABLE_LOADER_ID,
  USDC_DECIMALS,
  USDC_MINT,
  realKey,
  supportConfigProblem,
  type SupportSettings,
} from "./config";
import { decodeVault, supportAccounts, type SupportAccounts, type VaultView } from "./donation";

// sha256("account:Vault")[..8]
export const VAULT_DISCRIMINATOR = [211, 8, 232, 43, 2, 152, 117, 119];
export const VAULT_SIZE = 8 + 64 + 40 + 40 + 1;
const TOKEN_ACCOUNT_SIZE = 165;
const MINT_SIZE = 82;

type AccountInfo = { owner: PublicKey; executable: boolean; data: Uint8Array } | null;
export type ReadinessRpc = {
  getGenesisHash(): Promise<string>;
  getAccountInfo(address: PublicKey, commitment?: "confirmed"): Promise<AccountInfo>;
};

export type Readiness =
  | { state: "ready"; accounts: SupportAccounts; vault: VaultView }
  | { state: "blocked"; reason: string; retry: boolean };

const blocked = (reason: string, retry = true): Readiness => ({ state: "blocked", reason, retry });
const keyAt = (data: Uint8Array, offset: number) => new PublicKey(data.slice(offset, offset + 32)).toBase58();
const u32 = (data: Uint8Array, offset: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);

/** Checks the vault USDC token account (SPL Token layout). Returns a problem or null. */
export function tokenAccountProblem(info: AccountInfo, vault: PublicKey, mint: PublicKey): string | null {
  if (!info) return "The vault's USDC account doesn't exist on Devnet yet.";
  if (!info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length !== TOKEN_ACCOUNT_SIZE) return "The vault's USDC account isn't a token account.";
  if (keyAt(info.data, 0) !== mint.toBase58()) return "The vault's USDC account holds a different token than Devnet USDC.";
  if (keyAt(info.data, 32) !== vault.toBase58()) return "The vault's USDC account belongs to someone else.";
  if (u32(info.data, 72) !== 0) return "The vault's USDC account has a delegate.";
  if (info.data[108] !== 1) return "The vault's USDC account isn't open.";
  if (u32(info.data, 129) !== 0) return "The vault's USDC account has a close authority.";
  return null;
}

/** Checks the vault account bytes against the program and the configured recipients. */
export function vaultProblem(info: AccountInfo, programId: PublicKey, recipients: readonly [string, string]): { problem: string } | { vault: VaultView } {
  if (!info) return { problem: "The support vault isn't set up on Devnet yet." };
  if (!info.owner.equals(programId)) return { problem: "The support vault isn't owned by the support program." };
  if (info.data.length !== VAULT_SIZE || VAULT_DISCRIMINATOR.some((byte, i) => info.data[i] !== byte)) {
    return { problem: "The support vault doesn't look like a splitter vault." };
  }
  const vault = decodeVault(info.data);
  const [a, b] = vault.recipients;
  if (!realKey(a) || !realKey(b) || a === b) return { problem: "The vault's recipients are placeholders." };
  if (a !== recipients[0] || b !== recipients[1]) return { problem: "The vault's recipients don't match the ones this page was set up with." };
  return { vault };
}

export async function checkSupportChain(rpc: ReadinessRpc, settings: SupportSettings = SUPPORT_SETTINGS): Promise<Readiness> {
  const configProblem = supportConfigProblem(settings);
  if (configProblem) return blocked(configProblem, false);
  let accounts: SupportAccounts;
  try {
    accounts = supportAccounts(settings.programId, USDC_MINT);
  } catch {
    return blocked("The support program address is not valid.", false);
  }
  try {
    if ((await rpc.getGenesisHash()) !== DEVNET_GENESIS_HASH) return blocked("The network this page reads isn't Devnet.");
    const program = await rpc.getAccountInfo(accounts.programId, "confirmed");
    if (!program) return blocked("The support program isn't deployed on Devnet.");
    if (!program.executable || program.owner.toBase58() !== UPGRADEABLE_LOADER_ID) return blocked("The support program address isn't a deployed program.");
    const vaultCheck = vaultProblem(await rpc.getAccountInfo(accounts.vault, "confirmed"), accounts.programId, settings.recipients);
    if ("problem" in vaultCheck) return blocked(vaultCheck.problem);
    const tokenProblem = tokenAccountProblem(await rpc.getAccountInfo(accounts.vaultUsdc, "confirmed"), accounts.vault, accounts.usdcMint);
    if (tokenProblem) return blocked(tokenProblem);
    const mint = await rpc.getAccountInfo(accounts.usdcMint, "confirmed");
    if (!mint || !mint.owner.equals(TOKEN_PROGRAM_ID) || mint.data.length !== MINT_SIZE || mint.data[44] !== USDC_DECIMALS || mint.data[45] !== 1) {
      return blocked("Devnet USDC doesn't look right on this network.");
    }
    return { state: "ready", accounts, vault: vaultCheck.vault };
  } catch {
    return blocked("We couldn't reach Devnet to check the support vault.");
  }
}
