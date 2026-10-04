import { lazy, Suspense, useEffect } from "react";
import { clearJustSignedIn, useJustSignedIn } from "../owner/signInMoment";
import { hasReadySession } from "../session";
import { OwnerEntry } from "../owner/OwnerEntry";
import { useOwnerSignIn } from "../owner/useOwnerSignIn";
import "./workspace.css";
import { useRoute } from "../routing/useRoute";
import { useWallet } from "../wallet/context";
import { OwnerWelcome } from "../owner/OwnerWelcome";
import { buildStablecoinOptions } from "../owner/runtime";
import { clearWalletDrafts } from "../wallet/draftStore";

const Dashboard = lazy(() => import("./Dashboard"));
// Preloaded while the sign-in card is up so it can paint the moment sign-in finishes.
const loadBamBamLoader = () => import("../owner/BamBamLoader");
const BamBamLoader = lazy(loadBamBamLoader);

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
  const signIn = useOwnerSignIn();
  const justSignedIn = useJustSignedIn();
  const awaitingSignIn = Boolean(wallet.wallet) && signIn.status !== "ready";
  useEffect(() => {
    if (awaitingSignIn) void loadBamBamLoader();
  }, [awaitingSignIn]);
  if (currentRoute.kind !== "app") return null;
  if (!wallet.wallet) return <OwnerWelcome />;

  if (signIn.status !== "ready") return <OwnerEntry wallet={wallet.wallet} walletName={wallet.walletName} walletIcon={wallet.walletIcon} signing={signIn.status === "signing"} error={signIn.error} onSignIn={() => void signIn.signIn()} onChangeWallet={() => void wallet.changeWallet()} />;

  return (
    <>
      {justSignedIn ? (
        <Suspense fallback={null}>
          <BamBamLoader
            integrationStatus={wallet.integrationStatus}
            loadStage={wallet.loadStage}
            withAgents={hasReadySession()}
            onDone={clearJustSignedIn}
          />
        </Suspense>
      ) : null}
      {/* The dashboard really loads under Bam Bam's loader; it's inert until he steps aside. */}
      <div inert={justSignedIn || undefined} style={{ display: "contents" }}>
      <Suspense fallback={<RouteFallback />}>
        {/*
          Keyed by address so switching accounts remounts the dashboard. An account
          switch replaces wallet.wallet in place without ever emptying it, so this
          component never unmounts on its own, and Dashboard's draft state — invoice,
          amount, recipient, the CSV batch, the mandate builder — would otherwise stay
          on screen under the new wallet and be saved into its draft slot.
        */}
        <Dashboard
          key={wallet.wallet}
          wallet={wallet.wallet}
          walletName={wallet.walletName || "Solana wallet"}
          walletIcon={wallet.walletIcon}
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
          receiptDetail={currentRoute.receiptDetail}
          permissionRequest={currentRoute.permissionRequest}
          cardsNew={currentRoute.cardsNew}
          cardId={currentRoute.cardId}
          cardSection={currentRoute.cardSection}
          onTabChange={(tab, options) => navigate({
            kind: "app",
            tab,
            mandateBuilder: options?.mandateBuilder,
            mandateDetail: options?.mandateDetail,
            receiptDetail: options?.receiptDetail,
            cardsNew: options?.cardsNew,
            cardId: options?.cardId,
            cardSection: options?.cardSection,
          })}
          onNavigateHome={() => navigate({ kind: "landing" })}
          onRefresh={wallet.refreshMandate}
          onSelectMandate={wallet.selectMandate}
          onChangeAccount={() => void wallet.changeConnectedAccount()}
          onDisconnect={() => {
            // Drafts are per-wallet and survive an account switch on purpose, so that
            // switching back restores them. Disconnecting is the one point they should go.
            clearWalletDrafts(wallet.wallet);
            void wallet.disconnectWallet();
            navigate({ kind: "landing" });
          }}
          onChangeWallet={() => void wallet.changeWallet()}
          onCallMcp={wallet.callMcp}
        />
      </Suspense>
      </div>
    </>
  );
}
