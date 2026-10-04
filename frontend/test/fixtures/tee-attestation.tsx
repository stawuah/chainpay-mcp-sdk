// Harness for the privacy check's attestation line with the REAL browser check:
// a fresh quote from devnet-tee.magicblock.app, Intel DCAP verified in this
// browser (@phala/dcap-qvl), measurements compared to MagicBlock's pinned
// Devnet build. The owner/stranger reads around it are ILLUSTRATIVE fixtures.
// Needs network. `window.__attestation` exposes the raw result for tests.
import "../../src/polyfills";
import { createRoot } from "react-dom/client";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import "../../src/dashboard/workspace.css";
import "../../src/dashboard/cards/cards.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import { CardPrivacyCheck } from "../../src/dashboard/cards/CardPrivacyCheck";
import { createFixtureCardsSource, FIXTURE_CARD_IDS } from "../../src/dashboard/cards/fixtureSource";
import { checkTeeAttestation } from "../../src/dashboard/cards/teeAttestation";

const fixture = createFixtureCardsSource({ unlocked: true, delayMs: 0 });
const card = await fixture.getCard(FIXTURE_CARD_IDS.data);
const source = {
  ...fixture,
  async privacyCheck(view: typeof card) {
    const base = await fixture.privacyCheck(view);
    const attestation = await checkTeeAttestation();
    (window as unknown as { __attestation: unknown }).__attestation = attestation;
    return { ...base, checkedAt: new Date().toISOString(), attestation };
  },
};

createRoot(document.getElementById("root")!).render(
  <ChainPayTheme>
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 16 }} className="cp-cards">
      <CardPrivacyCheck source={source} card={card} unlocked onUnlocked={() => {}} />
    </main>
  </ChainPayTheme>,
);
