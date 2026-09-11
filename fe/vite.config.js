import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, /api is proxied to the agent service so there is no CORS and SSE streams through.
// In production the service serves fe/dist itself, so everything is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.CKG_URL || "http://127.0.0.1:8787", changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
