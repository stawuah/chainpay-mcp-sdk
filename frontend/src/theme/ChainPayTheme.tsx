import { Theme } from "@astryxdesign/core/theme";
import type { ReactNode } from "react";
import { chainPayTheme } from "./chainpay-theme";

/*
  `mode` is pinned to "light" deliberately. Astryx's neutral tokens are defined with
  light-dark() — `--color-text-primary` is light-dark(#000000, #ffffff). The default
  mode is "system", so on an OS in dark mode those tokens flipped to their dark values
  while every ChainPay rule kept painting var(--canvas)/#fff, producing white text on
  white cards. ChainPay has no dark theme; until it does, the app declares light.
*/
export function ChainPayTheme({ children }: { children: ReactNode }) {
  return <Theme theme={chainPayTheme} mode="light">{children}</Theme>;
}
