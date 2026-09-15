import { lazy, Suspense } from "react";
import { Router } from "./routing/Router";
import { useRoute } from "./routing/useRoute";
import { LandingPage } from "./landing/LandingPage";
import { usePublicWallet } from "./wallet/public-session";

const WalletController = lazy(() => import("./wallet/WalletController"));
const AppWorkspace = lazy(() => import("./dashboard/AppWorkspace"));
const VerifyPage = lazy(() => import("./verify/VerifyPage"));

function RouteFallback() {
  return (
    <main className="site-shell cp-app" aria-busy="true">
      <p className="page-width t-body" style={{ padding: "48px 0" }}>Loading…</p>
    </main>
  );
}

function Routes() {
  const { currentRoute, navigate } = useRoute();
  const { wallet, connecting, requestWalletConnection } = usePublicWallet();

  if (currentRoute.kind === "verify") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <VerifyPage receiptPda={currentRoute.receiptPda} />
      </Suspense>
    );
  }

  if (currentRoute.kind === "app") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <AppWorkspace />
      </Suspense>
    );
  }

  return (
    <LandingPage
      wallet={wallet}
      connecting={connecting}
      onConnect={requestWalletConnection}
      onOpenDashboard={() => navigate({ kind: "app", tab: "overview" })}
    />
  );
}

function Shell() {
  const { currentRoute, navigate } = useRoute();
  const landingFallback = (
    <LandingPage
      wallet=""
      connecting={false}
      onConnect={() => undefined}
      onOpenDashboard={() => navigate({ kind: "app", tab: "overview" })}
    />
  );

  // /verify/<pda> exists so a finance reader with no wallet can open a receipt.
  // Mounting WalletController around every route pulled its chunk —
  // @solana/web3.js and @wallet-standard — onto that page anyway. The landing
  // keeps it, because it does offer a connect action; verify never signs.
  if (currentRoute.kind === "verify") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <Routes />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={currentRoute.kind === "landing" ? landingFallback : <RouteFallback />}>
      <WalletController>
        <Routes />
      </WalletController>
    </Suspense>
  );
}

export default function AppShell() {
  return (
    <Router>
      <Shell />
    </Router>
  );
}
