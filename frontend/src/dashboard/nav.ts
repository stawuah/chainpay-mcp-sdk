import type { DashboardTab } from "../routing/paths";
import { DASHBOARD_TABS } from "../routing/paths";

export type DashboardNavItem = {
  id: DashboardTab;
  label: string;
  icon: string;
  group: "workspace" | "tools" | "admin" | "agents";
};

export const DASHBOARD_NAV_ITEMS: DashboardNavItem[] = [
  { id: "overview", label: "Overview", icon: "⌂", group: "workspace" },
  { id: "agents", label: "Agents", icon: "⌁", group: "workspace" },
  { id: "mandates", label: "Spending permissions", icon: "◇", group: "workspace" },
  { id: "payments", label: "Payments", icon: "↗", group: "workspace" },
  { id: "receipts", label: "Receipts", icon: "▤", group: "workspace" },
  { id: "assistant", label: "Requests", icon: "◉", group: "workspace" },
  { id: "tools", label: "Developer tools", icon: "⌘", group: "tools" },
  { id: "protocol", label: "Protocol", icon: "⚖", group: "admin" },
  { id: "settings", label: "Settings", icon: "⚙", group: "admin" },
];

export function dashboardNavItems(group: DashboardNavItem["group"]) {
  return DASHBOARD_NAV_ITEMS.filter((item) => item.group === group);
}

/** Sidebar-visible tabs. `/app/connect-mcp` remains a compatibility route only. */
export const SIDEBAR_DASHBOARD_TABS = DASHBOARD_TABS.filter((tab) => tab !== "connect-mcp");

export function dashboardNavCoversAllTabs() {
  const ids = DASHBOARD_NAV_ITEMS.map((item) => item.id);
  return SIDEBAR_DASHBOARD_TABS.every((tab) => ids.includes(tab)) && ids.length === SIDEBAR_DASHBOARD_TABS.length;
}
