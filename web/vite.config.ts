import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// The build lands in web/dist, which five serves beside the API.
// `npm run dev` proxies the API to five on :5555.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // No inline script or data: modules: the served CSP allows 'self' only.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    sourcemap: false,
  },
  server: {
    proxy: { "/api": "http://localhost:5555" },
  },
});
