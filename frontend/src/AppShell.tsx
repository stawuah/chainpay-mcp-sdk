import { lazy, Suspense } from "react";
import { Router } from "./routing/Router";
import { useRoute } from "./routing/useRoute";
import { LandingPage } from "./landing/LandingPage";
import { AppNotFoundPage, PublicNotFoundPage } from "./routing/NotFoundPages";
import { usePublicWallet } from "./wallet/public-session";
import { PetMount } from "./pet/PetMount";

const WalletController = lazy(() => import("./wallet/WalletController"));
const AppWorkspace = lazy(() => import("./dashboard/AppWorkspace"));
const VerifyPage = lazy(() => import("./verify/VerifyPage"));
const CardVerifyPage = lazy(() => import("./verify/CardVerifyPage"));
const CommunityRoom = lazy(() => import("./pet/shared/CommunityRoom"));
const EmbedOverview = lazy(() => import("./embed/EmbedOverview"));
const StatusPage = lazy(() => import("./status/StatusPage"));
const UseCasesPage = lazy(() => import("./use-cases/UseCasesPage"));
const UseCaseDetail = lazy(() => import("./use-cases/UseCaseDetail"));

function isWalletlessRoute(kind: string) {
  return kind === "pet" || kind === "verify" || kind === "verify-card" || kind === "embed-overview" || kind === "status" || kind === "use-cases" || kind === "use-case";
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

  if (currentRoute.kind === "pet") {
    return import.meta.env.VITE_CHAINPAY_SHARED_PET === "on" ? <Suspense fallback={<RouteFallback />}><CommunityRoom /></Suspense> : <PublicNotFoundPage path="/pet" />;
  }

  if (currentRoute.kind === "verify") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <VerifyPage receiptPda={currentRoute.receiptPda} />
      </Suspense>
    );
  }

  if (currentRoute.kind === "verify-card") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <CardVerifyPage />
      </Suspense>
    );
  }

  if (currentRoute.kind === "status") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <StatusPage />
      </Suspense>
    );
  }

  if (currentRoute.kind === "use-cases") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <UseCasesPage />
      </Suspense>
    );
  }

  if (currentRoute.kind === "use-case") {
    return (
      <Suspense fallback={<RouteFallback />}>
        <UseCaseDetail slug={currentRoute.slug} />
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

function Pet() {
  const { currentRoute } = useRoute();
  return <PetMount routeKind={currentRoute.kind} routeKey={JSON.stringify(currentRoute)} />;
}

export default function AppShell() {
  return (
    <Router>
      <Shell />
      <Pet />
    </Router>
  );
}
