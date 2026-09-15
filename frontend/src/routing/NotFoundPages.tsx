import { BrandLogo } from "../brand/Brand";

export function PublicNotFoundPage({ path }: { path: string }) {
  return (
    <main className="site-shell cp-app verify-page">
      <header className="topbar page-width">
        <a className="brand" href="/" aria-label="ChainPay home">
          <BrandLogo />
        </a>
        <a className="login-link" href="/">Back to ChainPay</a>
      </header>
      <section className="page-width receipt-page-state" style={{ padding: "48px 0 80px" }} role="alert">
        <span className="section-kicker">NOT FOUND</span>
        <h1 className="t-xl">This page is not available.</h1>
        <p className="t-body">ChainPay could not find a public page at <code>{path}</code>.</p>
        <a className="receipt-page-home" href="/">Return to ChainPay</a>
      </section>
    </main>
  );
}

export function AppNotFoundPage({ path, onOpenOverview }: { path: string; onOpenOverview: () => void }) {
  return (
    <main className="site-shell cp-app dashboard-shell">
      <section className="page-width receipt-page-state dashboard-card" style={{ margin: "48px auto", maxWidth: 720 }} role="alert">
        <span className="section-kicker">NOT FOUND</span>
        <h1 className="t-xl">This dashboard page is not available.</h1>
        <p className="t-body">ChainPay kept the URL <code>{path}</code> but does not recognize this app route.</p>
        <button type="button" className="button button-primary" onClick={onOpenOverview}>Open overview</button>
      </section>
    </main>
  );
}
