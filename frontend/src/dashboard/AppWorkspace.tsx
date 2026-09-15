import { lazy, Suspense } from "react";
import { PendingSettlements } from "../settlement";
import { useRoute } from "../routing/useRoute";
import { useWallet } from "../wallet/context";
import { buildStablecoinOptions } from "../owner/runtime";
import { Arrow } from "../ui/marks";

const Dashboard = lazy(() => import("./Dashboard"));

function RouteFallback() {
  return (
    <main className="site-shell cp-app" aria-busy="true">
      <p className="page-width t-body" style={{ padding: "48px 0" }}>Loading workspace…</p>
    </main>
  );
}

function ConnectPrompt() {
  const { connecting, requestWalletConnection } = useWallet();
  return (
    <main className="dashboard-app cp-app">
      <section className="page-width" style={{ padding: "64px 0" }}>
        <span className="section-kicker">OWNER WORKSPACE</span>
        <h1 className="t-xl">Connect the owner wallet.</h1>
        <p className="t-body">This route stays available after refresh. Sign in again to load mandates and receipts. Navigation does not keep an in-memory session.</p>
        <button className="button button-primary" onClick={requestWalletConnection}>
          {connecting ? "Connecting…" : "Connect wallet"} <Arrow />
        </button>
      </section>
    </main>
  );
}

export default function AppWorkspace() {
  const { currentRoute, navigate } = useRoute();
  const wallet = useWallet();
  if (currentRoute.kind !== "app") return null;
  if (!wallet.wallet) return <ConnectPrompt />;

  return (
    <>
      <PendingSettlements wallet={wallet.wallet} />
      <Suspense fallback={<RouteFallback />}>
        <Dashboard
          wallet={wallet.wallet}
          walletName={wallet.walletName || "Solana wallet"}
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
