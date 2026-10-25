import { createRoot } from "react-dom/client";
import { ChainPayTheme } from "../theme/ChainPayTheme";
import "../../skill/assets/design-token.css";
import "../theme/astryx.css";
import { apiOrigin } from "./client";
import App from "./App";
import "./paypal.css";

const root = createRoot(document.getElementById("root")!);
try {
  if (import.meta.env.VITE_CHAINPAY_PAYPAL !== "true") {
    root.render(<main className="paypal-shell"><h1>PayPal workspace is disabled</h1><p>This deployment has not enabled the sandbox extension.</p></main>);
  } else {
    const origin = apiOrigin(import.meta.env.VITE_CHAINPAY_PAYPAL_API_ORIGIN);
    root.render(<ChainPayTheme><App origin={origin} /></ChainPayTheme>);
  }
} catch (error) {
  root.render(<main className="paypal-shell" role="alert"><h1>PayPal setup is incomplete</h1><p>{error instanceof Error ? error.message : "Check the isolated deployment configuration."}</p></main>);
}
