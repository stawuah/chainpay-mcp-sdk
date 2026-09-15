export const DASHBOARD_TABS = [
  "overview",
  "mandates",
  "payments",
  "agents",
  "receipts",
  "assistant",
  "tools",
  "connect-mcp",
  "settings",
  "protocol",
] as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[number];

export type AppRoute =
  | { kind: "landing" }
  | { kind: "app"; tab: DashboardTab; mandateBuilder?: boolean }
  | { kind: "verify"; receiptPda: string };

export function isDashboardTab(value: string): value is DashboardTab {
  return (DASHBOARD_TABS as readonly string[]).includes(value);
}

export function parsePathname(pathname: string): AppRoute {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  if (normalized === "/") return { kind: "landing" };

  if (normalized === "/app") return { kind: "app", tab: "overview" };

  if (normalized.startsWith("/app/")) {
    const rest = normalized.slice("/app/".length);
    if (rest === "mandates/new") return { kind: "app", tab: "mandates", mandateBuilder: true };
    const tab = rest.split("/")[0] ?? "";
    if (isDashboardTab(tab) && rest === tab) return { kind: "app", tab };
    return { kind: "app", tab: "overview" };
  }

  if (normalized === "/verify") return { kind: "verify", receiptPda: "" };

  if (normalized.startsWith("/verify/")) {
    const encoded = normalized.slice("/verify/".length);
    try {
      return { kind: "verify", receiptPda: decodeURIComponent(encoded) };
    } catch {
      return { kind: "verify", receiptPda: encoded };
    }
  }

  return { kind: "landing" };
}

export function buildPath(route: AppRoute): string {
  if (route.kind === "landing") return "/";
  if (route.kind === "verify") {
    return route.receiptPda ? `/verify/${encodeURIComponent(route.receiptPda)}` : "/verify";
  }
  if (route.mandateBuilder && route.tab === "mandates") return "/app/mandates/new";
  return `/app/${route.tab}`;
}

export function pathsDiffer(pathname: string, route: AppRoute): boolean {
  const current = pathname.replace(/\/+$/, "") || "/";
  const next = buildPath(route);
  return current !== next;
}
