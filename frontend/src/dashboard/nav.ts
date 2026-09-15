import type { DashboardTab } from "../routing/paths";
import { DASHBOARD_TABS } from "../routing/paths";

export type DashboardNavItem = {
  id: DashboardTab;
  label: string;
  icon: string;
  group: "workspace" | "tools" | "admin";
};

export const DASHBOARD_NAV_ITEMS: DashboardNavItem[] = [
  { id: "overview", label: "Overview", icon: "⌂", group: "workspace" },
  { id: "mandates", label: "Mandates", icon: "◇", group: "workspace" },
  { id: "payments", label: "Payments", icon: "↗", group: "workspace" },
  { id: "agents", label: "Agents", icon: "⌁", group: "workspace" },
  { id: "receipts", label: "Receipts", icon: "▤", group: "workspace" },
  { id: "assistant", label: "AI inbox", icon: "◉", group: "workspace" },
  { id: "tools", label: "Tools", icon: "⌘", group: "tools" },
  { id: "connect-mcp", label: "Connect MCP", icon: "＋", group: "tools" },
  { id: "protocol", label: "Protocol", icon: "⚖", group: "admin" },
  { id: "settings", label: "Settings", icon: "⚙", group: "admin" },
];

export function dashboardNavItems(group: DashboardNavItem["group"]) {
  return DASHBOARD_NAV_ITEMS.filter((item) => item.group === group);
}

export function dashboardNavCoversAllTabs() {
  const ids = DASHBOARD_NAV_ITEMS.map((item) => item.id);
  return DASHBOARD_TABS.every((tab) => ids.includes(tab)) && ids.length === DASHBOARD_TABS.length;
}
