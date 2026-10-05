// Harness for /verify/card: ILLUSTRATIVE fixture card, real SDK disclosure +
// verification, commitment read stubbed in memory. `?state=verified|tampered|superseded|invalid|empty|rpc_error|no_commitment`.
import "../../src/polyfills";
import { createRoot } from "react-dom/client";
import { encodeDisclosureFragment } from "@chainpay/sdk";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import { CardVerifyPage, setCardCommitmentReader } from "../../src/verify/CardVerifyPage";
import { createFixtureCardsSource, FIXTURE_CARD_IDS } from "../../src/dashboard/cards/fixtureSource";

const state = new URLSearchParams(location.search).get("state") ?? "verified";
const source = createFixtureCardsSource({ unlocked: true, delayMs: 0 });
const card = await source.getCard(FIXTURE_CARD_IDS.data);
const bundle = await source.disclose(card, [2, 9, 13]);
const commitment = await source.commitmentFor(bundle.binding);
setCardCommitmentReader(async () => {
  if (state === "rpc_error") throw new Error("Fixture: RPC unavailable");
  return {
    address: "CardCommitPdaFixture1111111111111111111111",
    commitment: state === "no_commitment" ? null : commitment && state === "superseded" ? { ...commitment, seq: commitment.seq + 2n } : commitment,
  };
});
if (state === "tampered") bundle.leaves[1].value = "ffff000000000000";
const fragment = state === "invalid" ? "disclose=bm90LWpzb24" : state === "empty" ? "" : encodeDisclosureFragment(bundle);
history.replaceState(null, "", `${location.pathname}${location.search}${fragment ? `#${fragment}` : ""}`);

createRoot(document.getElementById("root")!).render(<ChainPayTheme><CardVerifyPage /></ChainPayTheme>);
