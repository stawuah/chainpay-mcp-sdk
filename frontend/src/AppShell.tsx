import { lazy, Suspense } from "react";
import { Router } from "./routing/Router";
import { useRoute } from "./routing/useRoute";
import { LandingPage } from "./landing/LandingPage";
import { AppNotFoundPage, PublicNotFoundPage } from "./routing/NotFoundPages";
import { usePublicWallet } from "./wallet/public-session";

const WalletController = lazy(() => import("./wallet/WalletController"));
const AppWorkspace = lazy(() => import("./dashboard/AppWorkspace"));
const VerifyPage = lazy(() => import("./verify/VerifyPage"));
const EmbedOverview = lazy(() => import("./embed/EmbedOverview"));

function isWalletlessRoute(kind: string) {
  return kind === "verify" || kind === "embed-overview";
}

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

  if (currentRoute.kind === "embed-overview") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <EmbedOverview owner={currentRoute.owner} />
      </Suspense>
    );
  }

  if (currentRoute.kind === "public-not-found") {
    return <PublicNotFoundPage path={currentRoute.path} />;
  }

  if (currentRoute.kind === "app-not-found") {
    return (
      <AppNotFoundPage
        path={currentRoute.path}
        onOpenOverview={() => navigate({ kind: "app", tab: "overview" })}
      />
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

  // /verify/<pda> and /embed/overview exist so a finance reader with no wallet
  // can open a receipt or spend snapshot. Mounting WalletController around
  // every route pulled its chunk onto those pages anyway.
  if (isWalletlessRoute(currentRoute.kind)) {
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
