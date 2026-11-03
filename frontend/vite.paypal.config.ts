import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Separate build and dev server: never inherits the Colosseum relay/RPC proxies.
export default defineConfig({
  plugins: [react(), { name: "paypal-routes", configureServer(server) {
    server.middlewares.use((request, _response, next) => {
      const path = request.url?.split("?")[0] ?? "";
      if ((path === "/" || path === "/paypal" || path.startsWith("/paypal/")) && request.headers.accept?.includes("text/html")) request.url = "/paypal.html";
      next();
    });
  } }],
  build: { outDir: "dist-paypal", rollupOptions: { input: "paypal.html" } },
  server: { host: "127.0.0.1", port: 5197 },
});
