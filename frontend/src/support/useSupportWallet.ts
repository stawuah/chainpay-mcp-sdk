import { useCallback, useEffect, useState } from "react";
import { connectChainPayWallet, getChainPayWalletOptions, type ChainPayWallet, type ChainPayWalletOption } from "../wallet/connect";

/** Page-level wallet state for /support, shared by the tip card and the maintainer panel. */
export function useSupportWallet() {
  const [wallet, setWallet] = useState<ChainPayWallet | null>(null);
  const [options, setOptions] = useState<ChainPayWalletOption[]>([]);
  const [connectingId, setConnectingId] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(() => setOptions(getChainPayWalletOptions(window.solana, window.phantom?.solana)), []);

  useEffect(() => {
    refresh();
    // Extensions can register a moment after load.
    const timer = window.setTimeout(refresh, 800);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!wallet?.subscribeToAccountChange) return;
    return wallet.subscribeToAccountChange((next) => setWallet(next));
  }, [wallet]);

  const connect = useCallback(async (optionId: string) => {
    setConnectingId(optionId);
    setError("");
    try {
      const connected = await connectChainPayWallet(optionId, window.solana, window.phantom?.solana);
      setWallet(connected);
      return connected;
    } catch (cause) {
      setError(cause instanceof Error && /reject|cancel|denied/i.test(cause.message)
        ? "Connection cancelled in your wallet."
        : "Couldn't connect that wallet. Unlock it and try again.");
      return null;
    } finally {
      setConnectingId("");
    }
  }, []);

  const disconnect = useCallback(() => {
    void wallet?.disconnect?.();
    setWallet(null);
  }, [wallet]);

  return { wallet, options, connectingId, error, refresh, connect, disconnect };
}

export type SupportWalletState = ReturnType<typeof useSupportWallet>;
