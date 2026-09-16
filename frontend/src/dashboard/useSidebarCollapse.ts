import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "chainpay.sidebar.collapsed";

/*
  Collapsed/expanded state for the desktop sidebar rail, remembered across
  visits. Reading localStorage can throw in a private window or with site data
  blocked, so every access is guarded and the expanded state is the fallback.

  Below 900px the sidebar is not rendered at all — navigation is the drawer — so
  this value is only consulted on desktop.
*/
function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useSidebarCollapse() {
  const [collapsed, setCollapsed] = useState(readStored);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // A remembered preference is a convenience; losing it changes nothing.
    }
  }, [collapsed]);

  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  return { collapsed, toggle };
}
