import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyLegacyHashRedirect } from "./legacyHash";
import { buildPath, parsePathname, pathsDiffer, type AppRoute } from "./paths";

export type NavigateOptions = { replace?: boolean };
export type NavigateFn = (route: AppRoute, options?: NavigateOptions) => void;

type RouteContextValue = {
  currentRoute: AppRoute;
  navigate: NavigateFn;
};

const RouteContext = createContext<RouteContextValue | null>(null);

function readRoute(): AppRoute {
  applyLegacyHashRedirect();
  return parsePathname(window.location.pathname);
}

export function Router({ children }: { children: ReactNode }) {
  const [currentRoute, setCurrentRoute] = useState<AppRoute>(readRoute);

  useEffect(() => {
    const sync = () => {
      applyLegacyHashRedirect();
      setCurrentRoute(parsePathname(window.location.pathname));
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    sync();
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  useEffect(() => {
    if (!pathsDiffer(window.location.pathname, currentRoute)) return;
    window.history.replaceState(window.history.state, "", buildPath(currentRoute) + window.location.hash);
  }, [currentRoute]);

  const navigate = useCallback<NavigateFn>((route, options) => {
    const path = buildPath(route);
    if (options?.replace) window.history.replaceState(window.history.state, "", path);
    else window.history.pushState(window.history.state, "", path);
    setCurrentRoute(route);
  }, []);

  const value = useMemo(() => ({ currentRoute, navigate }), [currentRoute, navigate]);

  return <RouteContext.Provider value={value}>{children}</RouteContext.Provider>;
}

export function useRoute(): RouteContextValue {
  const value = useContext(RouteContext);
  if (!value) throw new Error("useRoute must be used inside Router.");
  return value;
}
