export const DEVNET_CHAIN = "solana:devnet";

export type WalletCapabilitySource = "wallet-standard" | "legacy-injected";

export type WalletCapabilityReport = {
  name: string;
  address?: string;
  standardVersion: string | null;
  productVersion: string | null;
  source: WalletCapabilitySource;
  advertisedVersions: string[];
  v1Advertisement: "advertised" | "unverified";
  devnetChain: "advertised" | "other-solana" | "unverified";
  chains: string[];
  productionTransactionFormat: "legacy";
};

export type WalletCapabilitySnapshot = {
  name: string;
  address?: string;
  standardVersion?: string | null;
  productVersion?: string | null;
  source: WalletCapabilitySource;
  chains?: readonly string[];
  accountChains?: readonly string[];
  features?: Record<string, unknown>;
  advertisedVersions?: readonly unknown[];
};

const VERSION_ORDER = ["legacy", "0", "1"];

export function normalizeAdvertisedVersion(value: unknown): string | null {
  if (value === "legacy") return "legacy";
  if (value === 0 || value === "0") return "0";
  if (value === 1 || value === "1") return "1";
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function uniqueSortedVersions(values: readonly unknown[]): string[] {
  const versions = new Set<string>();
  for (const value of values) {
    const normalized = normalizeAdvertisedVersion(value);
    if (normalized) versions.add(normalized);
  }
  return [...versions].sort((left, right) => {
    const leftIndex = VERSION_ORDER.indexOf(left);
    const rightIndex = VERSION_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
}

export function readSupportedTransactionVersions(features: Record<string, unknown> | undefined): string[] {
  if (!features) return [];
  const advertised: unknown[] = [];
  for (const name of ["solana:signTransaction", "solana:signAndSendTransaction"] as const) {
    const feature = features[name];
    if (!feature || typeof feature !== "object") continue;
    const versions = (feature as { supportedTransactionVersions?: unknown }).supportedTransactionVersions;
    if (!Array.isArray(versions)) continue;
    advertised.push(...versions);
  }
  return uniqueSortedVersions(advertised);
}

function solanaChains(chains: readonly string[]): string[] {
  return [...new Set(chains.filter((chain) => chain.startsWith("solana:")))];
}

function devnetChainStatus(chains: readonly string[]): WalletCapabilityReport["devnetChain"] {
  if (chains.includes(DEVNET_CHAIN)) return "advertised";
  if (chains.some((chain) => chain.startsWith("solana:"))) return "other-solana";
  return "unverified";
}

export function reportWalletCapabilities(snapshot: WalletCapabilitySnapshot): WalletCapabilityReport {
  if (snapshot.source === "legacy-injected") {
    return {
      name: snapshot.name,
      address: snapshot.address,
      standardVersion: null,
      productVersion: null,
      source: "legacy-injected",
      advertisedVersions: [],
      v1Advertisement: "unverified",
      devnetChain: "unverified",
      chains: [],
      productionTransactionFormat: "legacy",
    };
  }

  const chains = solanaChains([...(snapshot.chains ?? []), ...(snapshot.accountChains ?? [])]);
  const advertisedVersions = snapshot.advertisedVersions
    ? uniqueSortedVersions(snapshot.advertisedVersions)
    : readSupportedTransactionVersions(snapshot.features);

  return {
    name: snapshot.name,
    address: snapshot.address,
    standardVersion: snapshot.standardVersion ?? null,
    productVersion: snapshot.productVersion ?? null,
    source: "wallet-standard",
    advertisedVersions,
    v1Advertisement: advertisedVersions.includes("1") ? "advertised" : "unverified",
    devnetChain: devnetChainStatus(chains),
    chains,
    productionTransactionFormat: "legacy",
  };
}

export function reportLegacyInjectedWallet(input: { name: string; address?: string }): WalletCapabilityReport {
  return reportWalletCapabilities({ source: "legacy-injected", name: input.name, address: input.address });
}

export function describeWalletCapabilities(report: WalletCapabilityReport) {
  const versionsLabel = report.source === "legacy-injected"
    ? "Not read. Legacy injected providers are not Wallet Standard evidence."
    : report.advertisedVersions.length > 0
      ? report.advertisedVersions.join(", ")
      : "Not advertised";
  const v1Label = report.v1Advertisement === "advertised"
    ? "Advertised. That is not a signed Devnet test."
    : "Unverified";
  const chainLabel = report.devnetChain === "advertised"
    ? "solana:devnet advertised"
    : report.devnetChain === "other-solana"
      ? `${report.chains.join(", ") || "solana"} advertised; solana:devnet missing`
      : "solana:devnet unverified";
  const identity = [report.name, report.productVersion ? `product ${report.productVersion}` : null, report.standardVersion ? `Wallet Standard ${report.standardVersion}` : null]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  const summary = report.source === "legacy-injected"
    ? `${report.name} connected through a legacy injected provider. Wallet Standard supportedTransactionVersions were not read. Transaction v1 is unverified. ChainPay still builds legacy transactions.`
    : report.v1Advertisement === "advertised"
      ? `${identity} advertised transaction versions: ${versionsLabel}. That advertisement is not a signed Devnet test. ${chainLabel}. ChainPay still builds legacy transactions.`
      : `${identity} advertised transaction versions: ${versionsLabel}. Transaction v1 is unverified. ${chainLabel}. ChainPay still builds legacy transactions.`;
  return {
    identity,
    versionsLabel,
    v1Label,
    chainLabel,
    productionLabel: "Legacy. v1 production is off.",
    summary,
  };
}
