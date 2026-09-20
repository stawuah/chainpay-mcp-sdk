import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@astryxdesign") || id.includes("node_modules/@stylexjs")) return "astryx";
          if (
            id.includes("/src/ui/")
            || id.includes("/src/routing/")
            || id.includes("/src/wallet/public-session")
            || id.includes("/src/config/public")
            || id.includes("/src/config/knownAssets")
          ) return "app-shared";
          if (
            id.includes("/src/session")
            || id.includes("/src/wallet/connect")
            || id.includes("/src/wallet/context")
            || id.includes("node_modules/@solana")
            || id.includes("node_modules/@wallet-standard")
          ) return "wallet";
          if (id.includes("/src/dashboard/") || id.includes("/src/owner/") || id.includes("/src/receipts/") || id.includes("/src/config/client") || id.includes("/sdk/") || id.includes("/src/settlement")) return "dashboard";
          if (id.includes("/src/verify/")) return "verify";
          if (id.includes("/src/embed/")) return "embed";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Local development fallback. Deployed builds use the Render URLs from
      // frontend/.env.example or the production defaults in config/public.ts.
      "/api": {
        target: "https://chainpay-backend.onrender.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/rpc": {
        target: "https://chainpay-backend.onrender.com",
        changeOrigin: true,
      },
    },
  },
});
