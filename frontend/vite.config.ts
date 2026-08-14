import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Local development fallback. Deployed builds use the Render URLs from
      // frontend/.env.example or the production defaults in App.tsx.
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
