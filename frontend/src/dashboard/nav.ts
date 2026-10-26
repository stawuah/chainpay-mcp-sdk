import type { DashboardTab } from "../routing/paths";
import { DASHBOARD_TABS } from "../routing/paths";
import { PAYPAL_TAB_ENABLED } from "../config/public";

export type DashboardNavItem = {
  id: DashboardTab;
  label: string;
  icon: string;
  group: "workspace" | "tools" | "admin" | "agents";
};

const ALL_NAV_ITEMS: DashboardNavItem[] = [
  { id: "overview", label: "Overview", icon: "house", group: "workspace" },
  { id: "agents", label: "Agents", icon: "bot", group: "workspace" },
  { id: "mandates", label: "Spending permissions", icon: "shield", group: "workspace" },
  { id: "cards", label: "Cards", icon: "credit-card", group: "workspace" },
  { id: "paypal", label: "PayPal", icon: "wallet", group: "workspace" },
  { id: "assistant", label: "Requests", icon: "inbox", group: "workspace" },
  { id: "payments", label: "Payments", icon: "payments", group: "workspace" },
  { id: "settings", label: "Settings", icon: "settings", group: "admin" },
];

/** Tabs that exist only behind a frontend flag. Off, they are not in the nav and their route is not found. */
export const FLAGGED_TABS: Partial<Record<DashboardTab, boolean>> = { paypal: PAYPAL_TAB_ENABLED };
export function tabEnabled(tab: DashboardTab): boolean {
  return FLAGGED_TABS[tab] ?? true;
}

export const DASHBOARD_NAV_ITEMS: DashboardNavItem[] = ALL_NAV_ITEMS.filter((item) => tabEnabled(item.id));

export function dashboardNavItems(group: DashboardNavItem["group"]) {
  return DASHBOARD_NAV_ITEMS.filter((item) => item.group === group);
}

/** Sidebar-visible tabs. `/app/connect-mcp` remains a compatibility route only. */
export const SIDEBAR_DASHBOARD_TABS = DASHBOARD_TABS.filter((tab) => !["connect-mcp", "receipts", "tools", "protocol"].includes(tab) && tabEnabled(tab));

export function dashboardNavCoversAllTabs() {
  const ids = DASHBOARD_NAV_ITEMS.map((item) => item.id);
  return SIDEBAR_DASHBOARD_TABS.every((tab) => ids.includes(tab)) && ids.length === SIDEBAR_DASHBOARD_TABS.length;
}
