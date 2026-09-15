import { lazy, Suspense } from "react";
import { PendingSettlements } from "../settlement";
import { useRoute } from "../routing/useRoute";
import { useWallet } from "../wallet/context";
import { Button } from "@astryxdesign/core/Button";
import { FIRST_MANDATE_TITLE, LOGIN_VS_APPROVAL, OWNER_SETUP_PATH_SUMMARY, OWNER_SETUP_STEPS } from "../owner/onboarding";
import { buildStablecoinOptions } from "../owner/runtime";

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
      <section className="page-width owner-connect-prompt" style={{ padding: "64px 0" }}>
        <span className="section-kicker">OWNER WORKSPACE</span>
        <h1 className="t-xl">{FIRST_MANDATE_TITLE}.</h1>
        <p className="t-body">{OWNER_SETUP_PATH_SUMMARY} {LOGIN_VS_APPROVAL} Navigation does not keep an in-memory session.</p>
        <ol className="owner-setup-path connect-prompt-path">
          {OWNER_SETUP_STEPS.map((step, index) => (
            <li className="owner-setup-step" key={step.key}>
              <span className="owner-setup-index" aria-hidden="true">{index + 1}</span>
              <div>
                <strong>{step.label}</strong>
                <p>{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
        <Button type="button" variant="primary" label={connecting ? "Connecting…" : "Connect wallet"} isDisabled={connecting} onClick={requestWalletConnection} />
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
