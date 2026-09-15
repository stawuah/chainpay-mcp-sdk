import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";

export const chainPayTheme = defineTheme({
  name: "chainpay",
  extends: neutralTheme,
  typography: {
    body: { family: "Inter", fallbacks: "-apple-system, BlinkMacSystemFont, sans-serif" },
    heading: { family: "Inter", fallbacks: "-apple-system, BlinkMacSystemFont, sans-serif", weight: "normal" },
    code: { family: "JetBrains Mono", fallbacks: "ui-monospace, SFMono-Regular, monospace" },
  },
  tokens: {
    "--color-accent": "#0052ff",
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
    "--radius-container": "24px",
  },
});
