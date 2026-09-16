// Actual controller, routes and scenes with a deliberately fake wallet. Browser runner blocks all live services.
import "../../src/polyfills";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { createRoot } from "react-dom/client";
import { getWallets } from "@wallet-standard/app";
import type { Wallet } from "@wallet-standard/base";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import { Router } from "../../src/routing/Router";
import WalletController from "../../src/wallet/WalletController";
import AppWorkspace from "../../src/dashboard/AppWorkspace";

const address = "11111111111111111111111111111111";
const account = { address, publicKey: new Uint8Array(32), chains: ["solana:devnet" as const], features: ["solana:signTransaction", "solana:signMessage"] };
const state = { connects: 0, messages: 0, transactions: 0, rejectLogin: true, unregister: () => {} };
const fixture = {
  state,
  register: () => {
    const wallet = {
      version: "1.0.0", name: "Fixture Wallet", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
      chains: ["solana:devnet"], accounts: [], features: {
        "standard:connect": { version: "1.0.0", connect: async () => { state.connects++; return { accounts: [account] }; } },
        "standard:disconnect": { version: "1.0.0", disconnect: async () => {} },
        "solana:signMessage": { version: "1.0.0", signMessage: async () => {
          state.messages++;
          if (state.rejectLogin) throw new Error("Fixture login canceled");
          return [{ signedMessage: new Uint8Array(), signature: new Uint8Array(64) }];
        } },
        "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy"], signTransaction: async () => {
          state.transactions++;
          throw new Error("Financial actions are forbidden in this fixture");
        } },
      },
    } as unknown as Wallet;
    state.unregister = getWallets().register(wallet);
  },
};
Object.assign(window, { onboardingFixture: fixture });
history.replaceState(null, "", "/app");
createRoot(document.getElementById("root")!).render(<ChainPayTheme><Router><WalletController><AppWorkspace /></WalletController></Router></ChainPayTheme>);
