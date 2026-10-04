import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import BamBamLoader from "../../src/owner/BamBamLoader";
import { PetMount } from "../../src/pet/PetMount";
import type { WalletContextValue } from "../../src/wallet/context";

// The sign-in loader over a fake dashboard. Drive it from the page:
// window.loaderFixture.set({ status, stage }); window.loaderFixture.done counts exits.
type Status = WalletContextValue["integrationStatus"];
type Stage = WalletContextValue["loadStage"];
declare global {
  interface Window {
    loaderFixture: { set: (next: { status?: Status; stage?: Stage }) => void; done: number };
  }
}

function App() {
  const [status, setStatus] = useState<Status>("loading");
  const [stage, setStage] = useState<Stage>("wallet");
  const [open, setOpen] = useState(true);
  useEffect(() => {
    window.loaderFixture = {
      done: 0,
      set: (next) => {
        if (next.status) setStatus(next.status);
        if (next.stage !== undefined) setStage(next.stage);
      },
    };
  }, []);
  return (
    <>
      <main id="dashboard" style={{ padding: 48, fontFamily: "Inter, sans-serif" }}>
        <h1>Dashboard</h1>
        <button type="button">A dashboard button</button>
      </main>
      {open ? (
        <BamBamLoader
          integrationStatus={status}
          loadStage={stage}
          withAgents
          onDone={() => {
            window.loaderFixture.done += 1;
            setOpen(false);
          }}
        />
      ) : null}
      <PetMount routeKind="app" routeKey="app" />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
