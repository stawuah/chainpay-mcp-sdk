import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../skill/assets/design-token.css";
import "./styles.css";
import "./polyfills";

const rootElement = document.getElementById("root");

if (!rootElement) throw new Error("ChainPay root element is missing.");

const root = createRoot(rootElement);

void import("./App")
  .then(({ default: App }) => {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((cause: unknown) => {
    const detail = cause instanceof Error ? cause.message : "Unknown startup error";
    console.error("ChainPay failed to start", cause);
    root.render(
      <main className="startup-error" role="alert">
        <span>CHAINPAY DEVELOPMENT</span>
        <h1>The interface could not start.</h1>
        <p>{import.meta.env.DEV ? detail : "Reload the page. If the problem continues, contact ChainPay support."}</p>
      </main>,
    );
  });
