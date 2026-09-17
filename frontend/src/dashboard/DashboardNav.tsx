import { House, Bot, ShieldCheck, Inbox, ArrowUpRight, Settings2, PanelLeftClose, PanelLeftOpen, ArrowLeft, LayoutGrid } from "lucide-react";
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
  const Icon = ({ overview: House, agents: Bot, mandates: ShieldCheck, assistant: Inbox, payments: ArrowUpRight, settings: Settings2 } as Partial<Record<DashboardTab, typeof House>>)[item.id] ?? Settings2;
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
      icon={<span className="sidebar-glyph" aria-hidden="true" title={collapsed ? item.label : undefined}><Icon size={20} strokeWidth={1.75} /></span>}
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
        <a className="brand" href="#dashboard" aria-label="ChainPay dashboard" onClick={(event) => { event.preventDefault(); onSelect("overview"); }}>
          <BrandLogo />
        </a>
        {onToggleCollapsed ? (
          <IconButton
            type="button"
            variant="ghost"
            className="sidebar-collapse-toggle"
            label={collapsed ? "Expand navigation" : "Collapse navigation"}
            icon={<span aria-hidden="true">{collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}</span>}
            aria-expanded={!collapsed}
            onClick={onToggleCollapsed}
          />
        ) : null}
      </div>
      <div className="sidebar-scroll-content">
      <div className="owner-workspace-label"><LayoutGrid size={18} /><span>Personal workspace<small>Owner account</small></span></div>
      <nav className="dashboard-nav" aria-label="Dashboard navigation">
        {dashboardNavItems("workspace").map((item) => (
          <NavButton
            key={item.id}
            item={item}
            current={tab === item.id || (item.id === "agents" && tab === "connect-mcp") || (item.id === "payments" && tab === "receipts") || (item.id === "settings" && ["tools", "protocol"].includes(tab))}
            endLabel={item.id === "assistant" && approvalCount > 0 ? String(approvalCount) : undefined}
            collapsed={collapsed}
            onSelect={onSelect}
          />
        ))}
      </nav>
      <div className="sidebar-bottom-spacer" />
      {dashboardNavItems("admin").map((item) => (
        <NavButton
          key={item.id}
          item={item}
          current={tab === item.id || (item.id === "agents" && tab === "connect-mcp") || (item.id === "payments" && tab === "receipts") || (item.id === "settings" && ["tools", "protocol"].includes(tab))}
          muted={item.id === "settings"}
          collapsed={collapsed}
          onSelect={onSelect}
        />
      ))}
      <div className="sidebar-bottom">

        <Button
          type="button"
          variant="ghost"
          className="side-link muted sidebar-back"
          isIconOnly={collapsed}
          label="Back to site"
          icon={<span className="sidebar-glyph" aria-hidden="true" title={collapsed ? "Back to site" : undefined}><ArrowLeft size={18} /></span>}
          onClick={onNavigateHome}
        />
      </div>
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
