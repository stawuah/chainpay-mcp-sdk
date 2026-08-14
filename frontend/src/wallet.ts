import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect } from "@wallet-standard/features";
import {
  SolanaSignTransaction,
  type SolanaSignTransactionFeature,
} from "@solana/wallet-standard-features";
import { Transaction } from "@solana/web3.js";

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

export type ChainPayWallet = {
  address: string;
  name: string;
  signTransaction: (transaction: Transaction) => Promise<Transaction>;
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

async function connectStandardWallet(wallet: StandardSolanaWallet): Promise<ChainPayWallet> {
  const connection = await wallet.features[StandardConnect].connect();
  const account = connection.accounts.find((candidate) =>
    candidate.chains.includes(DEVNET_CHAIN) || candidate.chains.some((chain) => chain.startsWith("solana:")),
  );
  if (!account) throw new Error(`${wallet.name} did not return a Solana account.`);

  return walletAdapter(wallet, account);
}

function walletAdapter(wallet: StandardSolanaWallet, account: WalletAccount): ChainPayWallet {

  return {
    address: account.address,
    name: wallet.name,
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
  };
}

type LegacyProvider = {
  isPhantom?: boolean;
  publicKey?: { toString(): string };
  connect?: () => Promise<{ publicKey: { toString(): string } }>;
  signTransaction?: (transaction: Transaction) => Promise<Transaction>;
};

async function connectLegacyWallet(provider: LegacyProvider): Promise<ChainPayWallet> {
  if (!provider.connect || !provider.signTransaction) {
    throw new Error("No compatible wallet signing method was found.");
  }
  const result = await provider.connect();
  return {
    address: result.publicKey.toString(),
    name: provider.isPhantom ? "Phantom" : "Injected Solana wallet",
    signTransaction: provider.signTransaction.bind(provider),
  };
}

export async function connectChainPayWallet(
  legacyProvider?: LegacyProvider,
  phantomProvider?: LegacyProvider,
): Promise<ChainPayWallet> {
  const phantom = phantomProvider?.isPhantom
    ? phantomProvider
    : legacyProvider?.isPhantom
      ? legacyProvider
      : undefined;
  if (phantom) return connectLegacyWallet(phantom);

  const [wallet] = standardWallets();
  if (wallet) return connectStandardWallet(wallet);
  if (legacyProvider) return connectLegacyWallet(legacyProvider);
  throw new Error("No Wallet Standard Solana wallet was found. Install Phantom, Backpack, or Solflare.");
}

export function restoreChainPayWallet(
  legacyProvider?: LegacyProvider,
  phantomProvider?: LegacyProvider,
): ChainPayWallet | null {
  const phantom = phantomProvider?.isPhantom
    ? phantomProvider
    : legacyProvider?.isPhantom
      ? legacyProvider
      : undefined;
  if (phantom?.publicKey && phantom.signTransaction) {
    return {
      address: phantom.publicKey.toString(),
      name: "Phantom",
      signTransaction: phantom.signTransaction.bind(phantom),
    };
  }

  if (legacyProvider?.publicKey && legacyProvider.signTransaction) {
    return {
      address: legacyProvider.publicKey.toString(),
      name: "Injected Solana wallet",
      signTransaction: legacyProvider.signTransaction.bind(legacyProvider),
    };
  }

  // Do not silently restore the first Wallet Standard wallet. If a user has
  // multiple browser wallets installed, they must explicitly connect one.
  return null;
}

export function getRegisteredWalletNames() {
  return standardWallets().map((wallet) => wallet.name);
}
