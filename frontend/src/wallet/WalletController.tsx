import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { getWallets } from "@wallet-standard/app";
import { configureSession, hasReadySession, subscribeSession, setSessionWallet } from "../session";
import { BACKEND_URL, MCP_URL, PROGRAM_ID, DEVNET_USDC_MINT, DEVNET_PYUSD_TOKEN_2022_MINT } from "../config/public";
import {
  connectChainPayWallet,
  getChainPayWalletOptions,
  type ChainPayWallet,
} from "./connect";
import { WalletPickerDialog } from "../ui/WalletPickerDialog";
import { WalletContextProvider, type WalletContextValue } from "./context";
import { PublicWalletProvider } from "./public-session";
import { useRoute } from "../routing/useRoute";

type Mandate = NonNullable<WalletContextValue["mandate"]>;

export default function WalletController({ children }: { children: ReactNode }) {
  const { navigate } = useRoute();
  const [walletConnection, setWalletConnection] = useState<ChainPayWallet | null>(null);
  const [connecting, setConnecting] = useState(false);
  const connectionInFlight = useRef(false);
  const signedIn = useSyncExternalStore(subscribeSession, hasReadySession, () => false);
  const [switchingWalletAccount, setSwitchingWalletAccount] = useState(false);
  const accountSwitchInProgress = useRef(false);
  const walletLoadGeneration = useRef(0);
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  const [walletOptions, setWalletOptions] = useState<WalletContextValue["walletOptions"]>([]);
  const [walletConnectionError, setWalletConnectionError] = useState("");
  const [mandateAddress, setMandateAddress] = useState("");
  const [mandate, setMandate] = useState<WalletContextValue["mandate"]>(null);
  const selectedMandateAddress = useRef<string | undefined>(undefined);
  const [mandates, setMandates] = useState<WalletContextValue["mandates"]>([]);
  const [protocolConfig, setProtocolConfig] = useState<WalletContextValue["protocolConfig"]>(null);
  const [registeredAssets, setRegisteredAssets] = useState<WalletContextValue["registeredAssets"]>([]);
  const [mcpTools, setMcpTools] = useState<WalletContextValue["mcpTools"]>([]);
  const [mcpResult, setMcpResult] = useState<WalletContextValue["mcpResult"]>(null);
  const [integrationStatus, setIntegrationStatus] = useState<WalletContextValue["integrationStatus"]>("idle");
  const [integrationError, setIntegrationError] = useState("");
  const wallet = walletConnection?.address ?? "";

  useEffect(() => {
    configureSession(BACKEND_URL, MCP_URL);
  }, []);

  const loadWalletState = useCallback(async (owner: string, preferredMandateAddress?: string) => {
    const loadGeneration = ++walletLoadGeneration.current;
    const [{ deriveMandateAddress }, { chainpayClient }, runtime] = await Promise.all([
      import("@chainpay/sdk"),
      import("../config/client"),
      import("../owner/runtime"),
    ]);
    const legacyAddress = deriveMandateAddress(owner, PROGRAM_ID);
    setMandateAddress(preferredMandateAddress ?? legacyAddress);
    setIntegrationStatus("loading");
    setIntegrationError("");

    const [configState, toolsState, assetsState] = await Promise.allSettled([
      chainpayClient.getConfig(),
      hasReadySession() ? runtime.mcpRequest<{ tools: WalletContextValue["mcpTools"] }>("tools/list", undefined, undefined, "passive") : Promise.resolve({ tools: [] }),
      chainpayClient.getSupportedAssets(),
    ]);
    if (loadGeneration !== walletLoadGeneration.current) return;

    const nextConfig = configState.status === "fulfilled" ? configState.value : null;
    if (configState.status === "fulfilled") setProtocolConfig(nextConfig);
    if (toolsState.status === "fulfilled") setMcpTools(toolsState.value.tools ?? []);
    const nextAssets = assetsState.status === "fulfilled" ? assetsState.value : [];
    if (assetsState.status === "fulfilled") setRegisteredAssets(nextAssets);

    const candidateMints = [...new Set([
      DEVNET_USDC_MINT,
      DEVNET_PYUSD_TOKEN_2022_MINT,
      ...(nextConfig?.supportedMints ?? []),
      ...nextAssets.map((asset) => asset.mint),
    ])];
    const candidateAddresses = [
      legacyAddress,
      ...candidateMints.map((mint) => deriveMandateAddress(owner, PROGRAM_ID, mint)),
    ];
    const discoveredState = await Promise.allSettled([
      chainpayClient.getMandatesByOwner(owner),
    ]);
    const mandateStates = await Promise.allSettled(
      [...new Set(candidateAddresses)].map((address) => chainpayClient.getMandate(address)),
    );
    if (loadGeneration !== walletLoadGeneration.current) return;
    const discoveredMandates = discoveredState[0]?.status === "fulfilled" ? discoveredState[0].value : [];
    const fallbackMandates = mandateStates
      .filter((state): state is PromiseFulfilledResult<Mandate | null> => state.status === "fulfilled")
      .map((state) => state.value)
      .filter((value): value is Mandate => value !== null);
    const nextMandates = Array.from(new Map(
      [...discoveredMandates, ...fallbackMandates].map((value) => [value.address, value]),
    ).values()).sort(runtime.compareMandatesByCreation);
    const usableMandates = (await Promise.all(
      nextMandates.map(async (value) => (await runtime.isPaymentMandateUsable(value) ? value : null)),
    )).filter((value): value is Mandate => value !== null);
    if (loadGeneration !== walletLoadGeneration.current) return;
    const selectedMandate = usableMandates.find((value) => value.address === preferredMandateAddress)
      ?? usableMandates.find((value) => value.allowedMint === DEVNET_USDC_MINT)
      ?? usableMandates[0]
      ?? nextMandates.find((value) => value.address === preferredMandateAddress && value.status === "active")
      ?? nextMandates.find((value) => value.status === "active")
      ?? nextMandates.find((value) => value.address === preferredMandateAddress && value.status !== "revoked")
      ?? nextMandates.find((value) => value.status !== "revoked")
      ?? nextMandates[0]
      ?? null;
    setMandates((current) => {
      if (discoveredState[0]?.status === "rejected" && current.length > 0) return current;
      return nextMandates;
    });
    setMandate(selectedMandate);
    selectedMandateAddress.current = selectedMandate?.address;
    setMandateAddress(selectedMandate?.address ?? legacyAddress);

    const mcpState = await Promise.allSettled([
      hasReadySession() ? runtime.mcpRequest<WalletContextValue["mcpResult"]>("tools/call", { name: "get_mandate", arguments: { address: selectedMandate?.address ?? legacyAddress } }, undefined, "passive") : Promise.resolve(null),
    ]);
    if (loadGeneration !== walletLoadGeneration.current) return;
    if (mcpState[0]?.status === "fulfilled") {
      setMcpResult(mcpState[0].value);
    }

    const errors = [configState, toolsState, assetsState, ...mandateStates]
      .filter((state): state is PromiseRejectedResult => state.status === "rejected")
      .map((state) => state.reason instanceof Error ? state.reason.message : String(state.reason));
    if (errors.length > 0) {
      setIntegrationStatus("error");
      setIntegrationError(errors.join(" · "));
    } else {
      setIntegrationStatus("ready");
    }
  }, []);

  const clearWalletScopedState = useCallback(() => {
    walletLoadGeneration.current += 1;
    setMandateAddress("");
    setMandate(null);
    selectedMandateAddress.current = undefined;
    setMandates([]);
    setProtocolConfig(null);
    setRegisteredAssets([]);
    setMcpTools([]);
    setMcpResult(null);
    setIntegrationStatus("idle");
    setIntegrationError("");
  }, []);

  const clearWalletState = useCallback(() => {
    setSessionWallet(null);
    setWalletConnection(null);
    clearWalletScopedState();
  }, [clearWalletScopedState]);

  const refreshWalletOptions = useCallback(() => {
    setWalletOptions(getChainPayWalletOptions(window.solana, window.phantom?.solana));
  }, []);

  useEffect(() => {
    refreshWalletOptions();
    const registry = getWallets();
    const unregister = registry.on("register", refreshWalletOptions);
    const unremove = registry.on("unregister", refreshWalletOptions);
    return () => { unregister(); unremove(); };
  }, [refreshWalletOptions]);

  useEffect(() => {
    if (signedIn && wallet) void loadWalletState(wallet, selectedMandateAddress.current);
  }, [signedIn, wallet, loadWalletState]);

  const requestWalletConnection = useCallback(() => {
    if (wallet || connecting) return;
    setWalletConnectionError("");
    setWalletOptions(getChainPayWalletOptions(window.solana, window.phantom?.solana));
    setWalletPickerOpen(true);
  }, [connecting, wallet]);

  const connectWallet = useCallback(async (optionId: string) => {
    if (wallet || connectionInFlight.current) return;
    connectionInFlight.current = true;
    setConnecting(true);
    setWalletConnectionError("");
    try {
      const connection = await connectChainPayWallet(optionId, window.solana, window.phantom?.solana);
      setSessionWallet(connection);
      setWalletConnection(connection);
      setWalletPickerOpen(false);
      void loadWalletState(connection.address);
      const path = window.location.pathname.replace(/\/+$/, "") || "/";
      if (path === "/") navigate({ kind: "app", tab: "overview" });
    } catch (cause) {
      setWalletConnectionError(cause instanceof Error ? cause.message : "Wallet connection failed.");
    } finally {
      connectionInFlight.current = false;
      setConnecting(false);
    }
  }, [connecting, loadWalletState, navigate, wallet]);

  const leaveCurrentWallet = useCallback(async (changeWallet: boolean) => {
    const currentConnection = walletConnection;
    clearWalletState();
    setWalletPickerOpen(false);
    setWalletConnectionError("");
    try {
      await currentConnection?.disconnect?.();
    } catch (cause) {
      if (changeWallet) {
        setWalletConnectionError(cause instanceof Error
          ? `The previous wallet did not disconnect cleanly: ${cause.message}`
          : "The previous wallet did not disconnect cleanly. Choose the wallet you want to use.");
      }
    }
    if (changeWallet) {
      setWalletOptions(getChainPayWalletOptions(window.solana, window.phantom?.solana));
      setWalletPickerOpen(true);
    }
  }, [clearWalletState, walletConnection]);

  const changeConnectedAccount = useCallback(async () => {
    if (!walletConnection || switchingWalletAccount) return;
    const previousAddress = walletConnection.address;
    accountSwitchInProgress.current = true;
    setSwitchingWalletAccount(true);
    try {
      setSessionWallet(null);
      const nextConnection = await walletConnection.changeAccount();
      setSessionWallet(nextConnection);
      setWalletConnection(nextConnection);
      if (nextConnection.address !== previousAddress) clearWalletScopedState();
      void loadWalletState(nextConnection.address);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Wallet account selection was cancelled.";
      clearWalletState();
      setWalletConnectionError(message);
    } finally {
      accountSwitchInProgress.current = false;
      setSwitchingWalletAccount(false);
    }
  }, [clearWalletScopedState, clearWalletState, loadWalletState, switchingWalletAccount, walletConnection]);

  useEffect(() => {
    if (!walletConnection?.subscribeToAccountChange) return;
    return walletConnection.subscribeToAccountChange((nextWallet) => {
      if (!nextWallet) {
        if (accountSwitchInProgress.current) return;
        clearWalletState();
        return;
      }
      if (nextWallet.address === walletConnection.address) return;
      setSessionWallet(nextWallet);
      setWalletConnection(nextWallet);
      clearWalletScopedState();
      void loadWalletState(nextWallet.address);
    });
  }, [clearWalletScopedState, clearWalletState, loadWalletState, walletConnection]);

  const value = useMemo<WalletContextValue>(() => ({
    wallet,
    walletName: walletConnection?.name ?? "",
    walletIcon: walletConnection?.icon,
    walletCapabilities: walletConnection?.capabilities ?? null,
    connecting,
    switchingWalletAccount,
    walletPickerOpen,
    walletOptions,
    walletConnectionError,
    mandateAddress,
    mandate,
    mandates,
    protocolConfig,
    registeredAssets,
    mcpTools,
    mcpResult,
    integrationStatus,
    integrationError,
    signTransaction: walletConnection
      ? async (transaction) => {
          const { guardPendingApprovals } = await import("../settlement");
          await guardPendingApprovals(wallet, transaction, PROGRAM_ID);
          return walletConnection.signTransaction(transaction);
        }
      : undefined,
    signMessage: walletConnection?.signMessage,
    requestWalletConnection,
    refreshWalletOptions,
    connectWallet,
    setWalletPickerOpen,
    changeConnectedAccount,
    disconnectWallet: () => leaveCurrentWallet(false),
    changeWallet: () => leaveCurrentWallet(true),
    refreshMandate: async (preferredMandateAddress?: string) => {
      if (wallet) await loadWalletState(wallet, preferredMandateAddress ?? mandate?.address);
    },
    selectMandate: (nextMandate) => {
      setMandate(nextMandate);
      selectedMandateAddress.current = nextMandate.address;
      setMandateAddress(nextMandate.address);
    },
    callMcp: async (name, args) => {
      const { callMcpTool } = await import("../owner/runtime");
      const result = await callMcpTool(name, args);
      setMcpResult(result);
      return result;
    },
  }), [
    changeConnectedAccount,
    connectWallet,
    connecting,
    integrationError,
    integrationStatus,
    leaveCurrentWallet,
    loadWalletState,
    mandate,
    mandateAddress,
    mandates,
    mcpResult,
    mcpTools,
    protocolConfig,
    registeredAssets,
    requestWalletConnection,
    refreshWalletOptions,
    switchingWalletAccount,
    wallet,
    walletConnection,
    walletConnectionError,
    walletOptions,
    walletPickerOpen,
  ]);

  return (
    <WalletContextProvider value={value}>
      <PublicWalletProvider value={{ wallet, connecting, requestWalletConnection }}>
        {children}
        <WalletPickerDialog
          isOpen={walletPickerOpen}
          wallets={walletOptions}
          connecting={connecting}
          error={walletConnectionError}
          onSelect={(optionId) => void connectWallet(optionId)}
          onOpenChange={setWalletPickerOpen}
          onRefresh={refreshWalletOptions}
        />
      </PublicWalletProvider>
    </WalletContextProvider>
  );
}
