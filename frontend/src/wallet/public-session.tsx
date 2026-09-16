import { createContext, useContext, type ReactNode } from "react";

export type PublicWalletSession = {
  wallet: string;
  connecting: boolean;
  requestWalletConnection: () => void;
};

const PublicWalletContext = createContext<PublicWalletSession>({
  wallet: "",
  connecting: false,
  requestWalletConnection: () => {},
});

export function PublicWalletProvider({
  value,
  children,
}: {
  value: PublicWalletSession;
  children: ReactNode;
}) {
  return <PublicWalletContext.Provider value={value}>{children}</PublicWalletContext.Provider>;
}

export function usePublicWallet(): PublicWalletSession {
  return useContext(PublicWalletContext);
}
