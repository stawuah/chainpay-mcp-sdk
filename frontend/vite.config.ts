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
            // The asset table has no imports of its own; keeping it here stops
            // app-shared depending on the dashboard chunk that holds the SDK.
            || id.includes("/sdk/dist/known-assets")
            || id.includes("/sdk/src/known-assets")
          ) return "app-shared";
          if (
            id.includes("/src/session")
            || id.includes("/src/wallet/connect")
            || id.includes("/src/wallet/context")
            || id.includes("node_modules/@solana")
            || id.includes("node_modules/@wallet-standard")
          ) return "wallet";
          // Card dashboard code rides the lazy CardsArea chunk, so /verify and /verify/card
          // (which share the dashboard chunk through receipts) don't download it. Only
          // the small modules receipts and Overview import statically stay in the dashboard
          // chunk. Anything else here imported statically from dashboard code makes the two
          // chunks import each other and the app dies on load with a TDZ ReferenceError.
          if (id.includes("/src/dashboard/cards/") && !/\/src\/dashboard\/cards\/(lifecycle|ui|source)\.tsx?$/.test(id)) return "cards";
          if (id.includes("/sdk/dist/cards/private-repayment") || id.includes("/sdk/src/cards/private-repayment")) return "cards";
          if (id.includes("/src/dashboard/") || id.includes("/src/owner/") || id.includes("/src/receipts/") || id.includes("/src/config/client") || id.includes("/sdk/") || id.includes("/src/settlement")) return "dashboard";
          if (id.includes("/src/verify/")) return "verify";
          if (id.includes("/src/embed/")) return "embed";
          // three.js only loads after the page is idle, through PetMount's lazy
          // import. PetMount itself sits on the every-route path, so it stays out
          // of the pet chunk.
          if (id.includes("/node_modules/three/") || id.includes("/node_modules/@react-three/")) return "pet-3d";
          if (id.includes("/src/pet/") && !id.includes("/src/pet/PetMount")) return "pet";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Local development fallback. Deployed builds use the configured service URLs from
      // frontend/.env.example or the production defaults in config/public.ts.
      "/api": {
        target: "https://chainpay-relay.vercel.app",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/rpc": {
        target: "https://chainpay-relay.vercel.app",
        changeOrigin: true,
      },
    },
  },
});
