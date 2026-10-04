import { useEffect, type MouseEvent, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { BrandLogo } from "../brand/Brand";
import { parsePathname } from "../routing/paths";
import { useRoute } from "../routing/useRoute";
import "../landing/landing.css";
import "./use-cases.css";

const MCP_DOCS_URL = "https://chainpay-mcp.vercel.app/docs";
const REPOSITORY_URL = "https://github.com/stawuah/chainpay-mcp-sdk";

// Same-tab clicks stay in the SPA; modified clicks keep the browser's own behavior.
export function useInternalLink() {
  const { navigate } = useRoute();
  return (event: MouseEvent<HTMLAnchorElement>) => {
    const href = event.currentTarget.getAttribute("href");
    if (!href?.startsWith("/") || event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(parsePathname(href));
    window.scrollTo({ top: 0 });
  };
}

export function UseCaseChrome({ title, children }: { title: string; children: ReactNode }) {
  const onLink = useInternalLink();

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <div className="site-shell cp-app landing use-cases">
      <a className="landing-skip" href="#use-cases-main">Skip to content</a>
      <header className="topbar page-width">
        <a className="brand" href="/" aria-label="ChainPay home" onClick={onLink}>
          <BrandLogo />
        </a>
        <nav className="main-nav uc-nav" aria-label="Use cases">
          <a href="/use-cases" onClick={onLink}>Use cases</a>
          <a href={MCP_DOCS_URL} target="_blank" rel="noreferrer">MCP docs</a>
        </nav>
        <div className="top-actions">
          <Button variant="primary" size="sm" label="Open dashboard" isDisabled={false} href="/app" />
        </div>
      </header>

      <main id="use-cases-main" tabIndex={-1}>{children}</main>

      <footer className="landing-footer page-width">
        <a className="brand" href="/" aria-label="ChainPay home" onClick={onLink}>
          <BrandLogo />
        </a>
        <p className="t-body-sm">Policy-controlled agent payments on Solana Devnet. The owner wallet holds the funds.</p>
        <div className="landing-footer-links">
          <a href="/use-cases" onClick={onLink}>Use cases</a>
          <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">GitHub</a>
          <a href={MCP_DOCS_URL} target="_blank" rel="noreferrer">MCP docs</a>
          <a href="/support" onClick={onLink}>Support</a>
        </div>
      </footer>
    </div>
  );
}
