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
  | { kind: "app"; tab: DashboardTab; mandateBuilder?: boolean; mandateDetail?: string; receiptDetail?: string }
  | { kind: "app-not-found"; path: string }
  | { kind: "public-not-found"; path: string }
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
    if (rest === "requests") return { kind: "app", tab: "assistant" };
    if (rest === "settings/advanced" || rest === "settings/advanced/tools") return { kind: "app", tab: "tools" };
    if (rest === "settings/advanced/protocol") return { kind: "app", tab: "protocol" };
    if (rest === "receipts") return { kind: "app", tab: "payments" };
    if (rest === "mandates/new") return { kind: "app", tab: "mandates", mandateBuilder: true };
    if (/^mandates\/[^/]+$/.test(rest)) {
      const encoded = rest.slice("mandates/".length);
      try {
        return { kind: "app", tab: "mandates", mandateDetail: decodeURIComponent(encoded) };
      } catch {
        return { kind: "app", tab: "mandates", mandateDetail: encoded };
      }
    }
    if (/^receipts\/[^/]+$/.test(rest)) {
      const encoded = rest.slice("receipts/".length);
      try {
        return { kind: "app", tab: "receipts", receiptDetail: decodeURIComponent(encoded) };
      } catch {
        return { kind: "app", tab: "receipts", receiptDetail: encoded };
      }
    }
    const tab = rest.split("/")[0] ?? "";
    if (isDashboardTab(tab) && rest === tab) return { kind: "app", tab };
    return { kind: "app-not-found", path: normalized };
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

  return { kind: "public-not-found", path: normalized };
}

export function buildPath(route: AppRoute): string {
  if (route.kind === "landing") return "/";
  if (route.kind === "verify") {
    return route.receiptPda ? `/verify/${encodeURIComponent(route.receiptPda)}` : "/verify";
  }
  if (route.kind === "app-not-found" || route.kind === "public-not-found") return route.path;
  if (route.mandateBuilder && route.tab === "mandates") return "/app/mandates/new";
  if (route.mandateDetail && route.tab === "mandates") return `/app/mandates/${encodeURIComponent(route.mandateDetail)}`;
  if (route.receiptDetail && route.tab === "receipts") return `/app/receipts/${encodeURIComponent(route.receiptDetail)}`;
  if (route.tab === "assistant") return "/app/requests";
  if (route.tab === "tools") return "/app/settings/advanced/tools";
  if (route.tab === "protocol") return "/app/settings/advanced/protocol";
  if (route.tab === "receipts") return "/app/payments";
  return `/app/${route.tab}`;
}

export function pathsDiffer(pathname: string, route: AppRoute): boolean {
  const current = pathname.replace(/\/+$/, "") || "/";
  const next = buildPath(route);
  return current !== next;
}
