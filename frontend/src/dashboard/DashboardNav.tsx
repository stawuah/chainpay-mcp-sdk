import { BrandLogo } from "../brand/Brand";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import type { DashboardTab } from "../routing/paths";
import { Shield } from "../ui/marks";
import { DASHBOARD_NAV_ITEMS, dashboardNavItems } from "./nav";

export type DashboardNavProps = {
  tab: DashboardTab;
  /** Icon-rail mode. The drawer always renders expanded. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
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
  collapsed,
  onSelect,
}: {
  item: (typeof DASHBOARD_NAV_ITEMS)[number];
  current: boolean;
  endLabel?: string;
  muted?: boolean;
  collapsed?: boolean;
  onSelect: (tab: DashboardTab) => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      // isIconOnly keeps `label` as the accessible name while removing it from
      // the visual flow. The label span's class is StyleX-generated, so hiding
      // it from CSS is not an option.
      isIconOnly={collapsed}
      className={`${muted ? "side-link muted" : "side-link"}${current ? " active" : ""}`}
      label={item.label}
      icon={<span className="sidebar-glyph" aria-hidden="true" title={collapsed ? item.label : undefined}>{item.icon}</span>}
      endContent={endLabel ? <b className="tool-count">{endLabel}</b> : undefined}
      onClick={() => onSelect(item.id)}
      aria-current={current ? "page" : undefined}
    />
  );
}

export function DashboardNav({ tab, approvalCount = 0, toolCount = 0, collapsed = false, onToggleCollapsed, onSelect, onNavigateHome }: DashboardNavProps) {
  return (
    <>
      <div className="dashboard-sidebar-brand">
        <a className="brand" href="#dashboard" aria-label="ChainPay dashboard">
          <BrandLogo />
        </a>
        {onToggleCollapsed ? (
          <IconButton
            type="button"
            variant="ghost"
            className="sidebar-collapse-toggle"
            label={collapsed ? "Expand navigation" : "Collapse navigation"}
            icon={<span aria-hidden="true">{collapsed ? "»" : "«"}</span>}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          />
        ) : null}
      </div>
      <div className="sidebar-label">WORKSPACE</div>
      <nav className="dashboard-nav" aria-label="Dashboard navigation">
        {dashboardNavItems("workspace").map((item) => (
          <NavButton
            key={item.id}
            item={item}
            current={tab === item.id || (item.id === "agents" && tab === "connect-mcp")}
            endLabel={item.id === "assistant" && approvalCount > 0 ? String(approvalCount) : undefined}
            collapsed={collapsed}
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
          endLabel={item.id === "tools" && toolCount > 0 ? String(toolCount) : undefined}
          collapsed={collapsed}
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
          collapsed={collapsed}
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
      <DashboardNav {...nav} collapsed={false} onToggleCollapsed={undefined} />
    </MobileNav>
  );
}
