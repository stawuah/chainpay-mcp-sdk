import { BrandLogo } from "../brand/Brand";
import { Button } from "@astryxdesign/core/Button";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import type { DashboardTab } from "../routing/paths";
import { Shield } from "../ui/marks";
import { DASHBOARD_NAV_ITEMS, dashboardNavItems } from "./nav";

export type DashboardNavProps = {
  tab: DashboardTab;
  approvalCount?: number;
  toolCount?: number;
  onSelect: (tab: DashboardTab) => void;
  onNavigateHome: () => void;
};

function NavButton({
  item,
  current,
  endLabel,
  muted,
  onSelect,
}: {
  item: (typeof DASHBOARD_NAV_ITEMS)[number];
  current: boolean;
  endLabel?: string;
  muted?: boolean;
  onSelect: (tab: DashboardTab) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={`${muted ? "side-link muted" : "side-link"}${current ? " active" : ""}`}
      label={item.label}
      icon={<span className="sidebar-glyph" aria-hidden="true">{item.icon}</span>}
      endContent={endLabel ? <b className="tool-count">{endLabel}</b> : undefined}
      onClick={() => onSelect(item.id)}
      aria-current={current ? "page" : undefined}
    />
  );
}

export function DashboardNav({ tab, approvalCount = 0, toolCount = 0, onSelect, onNavigateHome }: DashboardNavProps) {
  return (
    <>
      <div className="dashboard-sidebar-brand">
        <a className="brand" href="#dashboard" aria-label="ChainPay dashboard">
          <BrandLogo />
        </a>
      </div>
      <div className="sidebar-label">WORKSPACE</div>
      <nav className="dashboard-nav" aria-label="Dashboard navigation">
        {dashboardNavItems("workspace").map((item) => (
          <NavButton
            key={item.id}
            item={item}
            current={tab === item.id || (item.id === "agents" && tab === "connect-mcp")}
            endLabel={item.id === "assistant" && approvalCount > 0 ? String(approvalCount) : undefined}
            onSelect={onSelect}
          />
        ))}
      </nav>
      <div className="sidebar-separator" />
      <div className="sidebar-label">DEVELOPER</div>
      {dashboardNavItems("tools").map((item) => (
        <NavButton
          key={item.id}
          item={item}
          current={tab === item.id || (item.id === "agents" && tab === "connect-mcp")}
          endLabel={item.id === "tools" ? String(toolCount || 4) : undefined}
          onSelect={onSelect}
        />
      ))}
      <div className="sidebar-separator" />
      <div className="sidebar-label">ADMIN</div>
      {dashboardNavItems("admin").map((item) => (
        <NavButton
          key={item.id}
          item={item}
          current={tab === item.id || (item.id === "agents" && tab === "connect-mcp")}
          muted={item.id === "settings"}
          onSelect={onSelect}
        />
      ))}
      <div className="sidebar-bottom">
        <div className="sidebar-safe"><Shield /><span><b>Wallet protected</b><small>Agent keys never stored</small></span></div>
        <Button
          type="button"
          variant="ghost"
          className="side-link muted sidebar-back"
          label="Back to site"
          icon={<span className="sidebar-glyph" aria-hidden="true">‹</span>}
          onClick={onNavigateHome}
        />
      </div>
    </>
  );
}

export function DashboardMobileNav({
  isOpen,
  onOpenChange,
  ...nav
}: DashboardNavProps & { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <MobileNav
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      header="ChainPay"
      label="Dashboard navigation"
      side="start"
      width={280}
      data-testid="dashboard-mobile-nav"
    >
      <DashboardNav {...nav} />
    </MobileNav>
  );
}
