import { Theme } from "@astryxdesign/core/theme";
import type { ReactNode } from "react";
import { chainPayTheme } from "./chainpay-theme";

export function ChainPayTheme({ children }: { children: ReactNode }) {
  return <Theme theme={chainPayTheme}>{children}</Theme>;
}
