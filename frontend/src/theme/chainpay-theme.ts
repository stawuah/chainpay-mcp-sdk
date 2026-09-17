import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

export const chainPayTheme = defineTheme({
  name: "chainpay",
  extends: neutralTheme,
  typography: {
    body: { family: "Inter", fallbacks: "-apple-system, BlinkMacSystemFont, sans-serif" },
    heading: { family: "Inter", fallbacks: "-apple-system, BlinkMacSystemFont, sans-serif", weight: "medium" },
    code: { family: "JetBrains Mono", fallbacks: "ui-monospace, SFMono-Regular, monospace" },
  },
  tokens: {
    // Mirrors theme/chainpay-overrides.css. Astryx components read --color-*;
    // anything not named here keeps theme-neutral's light-dark() default, which
    // is how input values ended up pure #000000 against #14213d body copy.
    "--color-text-primary": "#14213d",
    "--color-text-secondary": "#56647d",
    "--color-text-disabled": "#8a95a8",
    "--color-background-surface": "#ffffff",
    "--color-background-card": "#ffffff",
    "--color-background-muted": "#eff4ff",
    "--color-border": "#dbe2ef",
    "--color-border-emphasized": "#c6d1e6",
    "--radius-inner": "6px",
    "--radius-element": "10px",
    "--color-accent": "#0052ff",
    "--color-on-accent": "#ffffff",
    "--color-text-accent": "#0052ff",
    "--color-icon-accent": "#0052ff",
    "--color-border-blue": "#0052ff",
    "--color-icon-blue": "#0052ff",
    "--font-family-body": "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    "--font-family-heading": "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    "--font-family-code": "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
    "--size-element-sm": "44px",
    "--size-element-md": "44px",
    "--size-element-lg": "48px",
    "--radius-container": "12px",
  },
});
