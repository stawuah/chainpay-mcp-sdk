// Browser regression fixture: purchase cards from structured inbox fields, no wallet.
import "../../src/polyfills";
import { createRoot } from "react-dom/client";
import { PurchaseCard } from "../../src/dashboard/PurchaseCard";
import { inboxAttentionCounts, purchaseCardFromInboxItem } from "../../src/owner/purchaseCard";
import type { AgentInboxItem } from "../../src/owner/runtime";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import blocked from "./inbox-blocked.json";
import waiting from "./inbox-waiting.json";

const stablecoinOptions = [{
  value: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  label: "USDC",
  detail: "Devnet fixture",
  tokenProgram: "spl-token" as const,
}];

const inbox = [waiting, blocked] as AgentInboxItem[];
const counts = inboxAttentionCounts(inbox);

function Fixture() {
  const cards = inbox.map((item) => purchaseCardFromInboxItem(item, {
    stablecoinOptions,
    mandateDecimals: 6,
    mandate: null,
  }));
  return (
    <div className="dashboard-app cp-app" data-fixture="live-purchase" style={{ padding: 24 }}>
      <output data-testid="pending-total">{counts.pendingTotal}</output>
      <output data-testid="waiting">{counts.waiting}</output>
      <div className="purchase-card-grid">
        {cards.map((purchase) => (
          <PurchaseCard key={purchase.id} purchase={purchase} />
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ChainPayTheme><Fixture /></ChainPayTheme>,
);
