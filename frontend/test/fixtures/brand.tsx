import { createRoot } from "react-dom/client";
import "../../skill/assets/design-token.css";
import "../../src/theme/astryx.css";
import "../../src/styles.css";
import { ChainPayTheme } from "../../src/theme/ChainPayTheme";
import { BrandLogo } from "../../src/brand/Brand";
import { Button } from "@astryxdesign/core/Button";
import "./brand.css";
createRoot(document.getElementById("root")!).render(<ChainPayTheme><main className="cp-app identity-preview">
  <header><p>CHAINPAY / CONNECTION</p><h1>One family. Every size.</h1><p>Shared symbol, medium-weight wordmark, and the same Inter typography throughout.</p></header>
  <section className="identity-hero"><BrandLogo size="large" /><img src="/brand/chainpay-icon.svg" width="100" height="100" alt="ChainPay app icon" /></section>
  <div className="identity-grid">
    <section><p className="identity-caption">NAVIGATION</p><BrandLogo size="compact" /><hr /><p>Overview</p><p>Spending permissions</p><p>Payments</p></section>
    <section><p className="identity-caption">DASHBOARD</p><BrandLogo /><hr /><h2>Spending permissions</h2><p>Set the limits. Stay in control.</p><Button label="Open dashboard" href="/app/overview" variant="primary" /></section>
    <section><p className="identity-caption">RECEIPT</p><BrandLogo /><hr /><h2>4.50 USDC</h2><p>Illustrative amount · no payment made</p><p>Payment receipt</p></section>
  </div>
  <section className="identity-scale"><p className="identity-caption">ICON SCALE</p>{[16,24,32,48,64].map(size=><figure key={size}><img src="/brand/chainpay-icon.svg" width={size} height={size} alt={`${size}px icon`} /><figcaption>{size}px</figcaption></figure>)}</section>
  <footer><a href="/">Back to landing page</a><span>Body 400 · Headings & wordmark 500 · Labels 600</span></footer>
</main></ChainPayTheme>);
