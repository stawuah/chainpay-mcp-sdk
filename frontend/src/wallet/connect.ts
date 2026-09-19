import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from "@wallet-standard/features";
import {
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignMessageFeature,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { Transaction } from "@solana/web3.js";
import {
  reportLegacyInjectedWallet,
  reportWalletCapabilities,
  type WalletCapabilityReport,
} from "./capabilities";
import { resolveConnectedWalletIcon } from "./icons";

const DEVNET_CHAIN = "solana:devnet";

type StandardConnectFeature = {
  readonly [StandardConnect]: {
    readonly connect: (input?: { silent?: boolean }) => Promise<{
      readonly accounts: readonly WalletAccount[];
    }>;
  };
};

type StandardSolanaWallet = Wallet & {
  readonly features: Wallet["features"] &
    StandardConnectFeature & SolanaSignTransactionFeature;
};

export type ChainPayWalletOption = {
  id: string;
  name: string;
  icon?: string;
  standard: boolean;
};

export type ChainPayWallet = {
  address: string;
  name: string;
  icon?: string;
  capabilities: WalletCapabilityReport;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
  disconnect?: () => Promise<void>;
  changeAccount: () => Promise<ChainPayWallet>;
  subscribeToAccountChange?: (listener: (wallet: ChainPayWallet | null) => void) => () => void;
};

function supportsSolanaDevnet(wallet: Wallet) {
  const features = wallet.features as Record<string, unknown>;
  return (
    (wallet.chains.includes(DEVNET_CHAIN) || wallet.chains.some((chain) => chain.startsWith("solana:"))) &&
    StandardConnect in features &&
    SolanaSignTransaction in features
  );
}

function standardWallets() {
  return getWallets().get().filter(supportsSolanaDevnet) as StandardSolanaWallet[];
}

function solanaAccount(accounts: readonly WalletAccount[]) {
  const compatible = accounts.filter((candidate) =>
    candidate.chains.includes(DEVNET_CHAIN) || candidate.chains.some((chain) => chain.startsWith("solana:")),
  );
  return compatible[0];
}

async function connectStandardWallet(wallet: StandardSolanaWallet, accountProvider?: LegacyProvider): Promise<ChainPayWallet> {
  const connection = await wallet.features[StandardConnect].connect({ silent: false });
  const account = solanaAccount(connection.accounts);
  if (!account) throw new Error(`${wallet.name} did not return a Solana account.`);

  return walletAdapter(wallet, account, accountProvider);
}

function walletAdapter(wallet: StandardSolanaWallet, account: WalletAccount, accountProvider?: LegacyProvider): ChainPayWallet {
  const disconnectFeature = (wallet.features as Wallet["features"] & Partial<StandardDisconnectFeature>)[StandardDisconnect];
  const signMessageFeature = (wallet.features as Wallet["features"] & Partial<SolanaSignMessageFeature>)[SolanaSignMessage];

  return {
    address: account.address,
    name: wallet.name,
    icon: resolveConnectedWalletIcon(wallet.name, wallet.icon),
    capabilities: reportWalletCapabilities({
      source: "wallet-standard",
      name: wallet.name,
      address: account.address,
      standardVersion: wallet.version,
      chains: wallet.chains,
      accountChains: account.chains,
      features: wallet.features as Record<string, unknown>,
    }),
    signTransaction: async (transaction) => {
      const unsignedTransaction = transaction.serialize({
        requireAllSignatures: false,
        verifySignatures: false,
      });
      const [signed] = await wallet.features[SolanaSignTransaction].signTransaction({
        account,
        chain: DEVNET_CHAIN,
        transaction: unsignedTransaction,
        options: { preflightCommitment: "confirmed" },
      });
      if (!signed) throw new Error(`${wallet.name} did not return a signed transaction.`);
      return Transaction.from(signed.signedTransaction);
    },
    signMessage: signMessageFeature
      ? async (message) => {
          const [signed] = await signMessageFeature.signMessage({ account, message });
          if (!signed) throw new Error(`${wallet.name} did not return a message signature.`);
          return signed.signature;
        }
      : accountProvider?.signMessage
        ? async (message) => (await accountProvider.signMessage!(message, "utf8")).signature
        : undefined,
    disconnect: accountProvider?.disconnect
      ? () => accountProvider.disconnect!()
      : disconnectFeature
        ? () => disconnectFeature.disconnect()
        : undefined,
    changeAccount: async () => {
      if (accountProvider) {
        await accountProvider.disconnect?.();
        return connectLegacyWallet(accountProvider, wallet.name, true);
      }
      await disconnectFeature?.disconnect();
      return connectStandardWallet(wallet, accountProvider);
    },
    subscribeToAccountChange: (listener) => {
      const events = (wallet.features as Wallet["features"] & Partial<StandardEventsFeature>)[StandardEvents];
      if (!events) return () => undefined;
      return events.on("change", ({ accounts }) => {
        if (!accounts) return;
        const nextAccount = solanaAccount(accounts);
        listener(nextAccount ? walletAdapter(wallet, nextAccount, accountProvider) : null);
      });
    },
  };
}

type LegacyProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect?: (options?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: { toString(): string } }>;
  disconnect?: () => Promise<void>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
  signMessage?: (message: Uint8Array, display?: "utf8" | "hex") => Promise<{ signature: Uint8Array }>;
  on?: (event: "accountChanged", listener: (publicKey: { toString(): string } | null) => void) => void;
  removeListener?: (event: "accountChanged", listener: (publicKey: { toString(): string } | null) => void) => void;
};

function legacyWalletAdapter(provider: LegacyProvider, address: string, name: string): ChainPayWallet {
  if (!provider.signTransaction) throw new Error("No compatible wallet signing method was found.");
  return {
    address,
    name,
    icon: resolveConnectedWalletIcon(name),
    capabilities: reportLegacyInjectedWallet({ name, address }),
    signTransaction: provider.signTransaction.bind(provider),
    signMessage: provider.signMessage
      ? async (message) => (await provider.signMessage!(message, "utf8")).signature
      : undefined,
    disconnect: provider.disconnect?.bind(provider),
    changeAccount: async () => {
      await provider.disconnect?.();
      return connectLegacyWallet(provider, name, true);
    },
    subscribeToAccountChange: provider.on
      ? (listener) => {
          const handleChange = (publicKey: { toString(): string } | null) => {
            listener(publicKey ? legacyWalletAdapter(provider, publicKey.toString(), name) : null);
          };
          provider.on?.("accountChanged", handleChange);
          return () => provider.removeListener?.("accountChanged", handleChange);
        }
      : undefined,
  };
}

async function connectLegacyWallet(provider: LegacyProvider, name: string, forcePrompt = false): Promise<ChainPayWallet> {
  if (!provider.connect || !provider.signTransaction) {
    throw new Error("No compatible wallet signing method was found.");
  }
  const result = await provider.connect(forcePrompt ? { onlyIfTrusted: false } : undefined);
  return legacyWalletAdapter(provider, result.publicKey.toString(), name);
}

export function getChainPayWalletOptions(
  legacyProvider?: LegacyProvider,
  phantomProvider?: LegacyProvider,
): ChainPayWalletOption[] {
  const options: ChainPayWalletOption[] = standardWallets().map((wallet) => ({
    id: `standard:${wallet.name}`,
    name: wallet.name,
    icon: resolveConnectedWalletIcon(wallet.name, wallet.icon),
    standard: true,
  }));
  const names = new Set(options.map((option) => option.name.toLowerCase()));
  const phantom = phantomProvider?.isPhantom
    ? phantomProvider
    : legacyProvider?.isPhantom
      ? legacyProvider
      : undefined;
  if (phantom && !names.has("phantom")) {
    options.push({ id: "legacy:phantom", name: "Phantom", icon: resolveConnectedWalletIcon("Phantom"), standard: false });
    names.add("phantom");
  }
  if (legacyProvider && legacyProvider !== phantom && !names.has("injected solana wallet")) {
    options.push({ id: "legacy:injected", name: "Injected Solana wallet", standard: false });
  }
  return options;
}

export async function connectChainPayWallet(
  optionId: string,
  legacyProvider?: LegacyProvider,
  phantomProvider?: LegacyProvider,
): Promise<ChainPayWallet> {
  const phantom = phantomProvider?.isPhantom
    ? phantomProvider
    : legacyProvider?.isPhantom
      ? legacyProvider
      : undefined;

  if (optionId.startsWith("standard:")) {
    const walletName = optionId.slice("standard:".length);
    const wallet = standardWallets().find((candidate) => candidate.name === walletName);
    if (!wallet) throw new Error(`${walletName} is no longer available. Reopen the wallet list and try again.`);
    const directAccountProvider = wallet.name.toLowerCase() === "phantom" ? phantom : undefined;
    if (directAccountProvider) return connectLegacyWallet(directAccountProvider, wallet.name, true);
    return connectStandardWallet(wallet, directAccountProvider);
  }

  if (optionId === "legacy:phantom" && phantom) return connectLegacyWallet(phantom, "Phantom", true);
  if (optionId === "legacy:injected" && legacyProvider) {
    return connectLegacyWallet(legacyProvider, "Injected Solana wallet");
  }
  throw new Error("No Wallet Standard Solana wallet was found. Install Phantom, Backpack, or Solflare.");
}
