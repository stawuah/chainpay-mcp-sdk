// Browser regression fixture: sidebar destinations without wallet or backend.
import "../../src/polyfills";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { DashboardTab } from "../../src/routing/paths";
import { DashboardNav } from "../../src/dashboard/DashboardNav";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";

function Fixture() {
  const [tab, setTab] = useState<DashboardTab>("overview");
  const [last, setLast] = useState("overview");
  return (
    <div className="dashboard-app cp-app" data-fixture="dashboard-nav">
      <DashboardNav
        tab={tab}
        approvalCount={2}
        toolCount={4}
        onSelect={(next) => { setTab(next); setLast(next); }}
        onNavigateHome={() => setLast("home")}
      />
      <main className="dashboard-main" style={{ padding: 24 }}>
        <p data-testid="active-tab">{last}</p>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ChainPayTheme><Fixture /></ChainPayTheme>,
);
