import { createRoot } from "react-dom/client";
import { useState } from "react";
import { BamBamWorld } from "../../src/pet/world/BamBamWorld";

// Bam Bam's world on its own: ?game=snake|ttt, ?mode=panel|loader.
const params = new URLSearchParams(location.search);
const game = params.get("game") === "ttt" ? "ttt" : "snake";
const mode = params.get("mode") === "loader" ? "loader" : "panel";
declare global {
  interface Window {
    worldFixture: { closed: number; results: unknown[] };
  }
}
window.worldFixture = { closed: 0, results: [] };

function App() {
  const [open, setOpen] = useState(true);
  if (!open) return <button onClick={() => setOpen(true)}>Open world</button>;
  const world = (
    <BamBamWorld
      mode={mode}
      game={game}
      onClose={() => {
        window.worldFixture.closed += 1;
        setOpen(false);
      }}
      onFinish={(r) => window.worldFixture.results.push(r)}
    />
  );
  return mode === "loader" ? <div style={{ position: "fixed", inset: "64px 0 0", display: "flex" }}>{world}</div> : world;
}

createRoot(document.getElementById("root")!).render(<App />);
