import { lazy, Suspense } from "react";
import { PendingSettlements } from "../settlement";
import { useRoute } from "../routing/useRoute";
import { useWallet } from "../wallet/context";
import { OwnerWelcome } from "../owner/OwnerWelcome";
import { buildStablecoinOptions } from "../owner/runtime";

const Dashboard = lazy(() => import("./Dashboard"));

function RouteFallback() {
  return (
    <main className="site-shell cp-app" aria-busy="true">
      <p className="page-width t-body" style={{ padding: "48px 0" }}>Loading workspace…</p>
    </main>
  );
}

export default function AppWorkspace() {
  const { currentRoute, navigate } = useRoute();
  const wallet = useWallet();
  if (currentRoute.kind !== "app") return null;
  if (!wallet.wallet) return <OwnerWelcome />;

  return (
    <>
      <PendingSettlements wallet={wallet.wallet} />
      <Suspense fallback={<RouteFallback />}>
        <Dashboard
          wallet={wallet.wallet}
          walletName={wallet.walletName || "Solana wallet"}
          walletCapabilities={wallet.walletCapabilities}
          walletSigner={wallet.signTransaction}
          walletMessageSigner={wallet.signMessage}
          mandateAddress={wallet.mandate?.address}
          mandate={wallet.mandate}
          mandates={wallet.mandates}
          protocolConfig={wallet.protocolConfig}
          stablecoinOptions={buildStablecoinOptions(wallet.registeredAssets)}
          mcpTools={wallet.mcpTools}
          mcpResult={wallet.mcpResult}
          integrationStatus={wallet.integrationStatus}
          integrationError={wallet.integrationError}
          switchingWalletAccount={wallet.switchingWalletAccount}
          tab={currentRoute.tab}
          mandateBuilder={currentRoute.mandateBuilder}
          onTabChange={(tab, options) => navigate({ kind: "app", tab, mandateBuilder: options?.mandateBuilder })}
          onNavigateHome={() => navigate({ kind: "landing" })}
          onRefresh={wallet.refreshMandate}
          onSelectMandate={wallet.selectMandate}
          onChangeAccount={() => void wallet.changeConnectedAccount()}
          onDisconnect={() => {
            void wallet.disconnectWallet();
            navigate({ kind: "landing" });
          }}
          onChangeWallet={() => void wallet.changeWallet()}
          onCallMcp={wallet.callMcp}
        />
      </Suspense>
    </>
  );
}
