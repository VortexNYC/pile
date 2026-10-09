import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The console is served same-origin by the Pile Worker at /app (Workers
// Static Assets), so Better Auth session cookies need no CORS. In dev the
// Vite server proxies API + auth calls to `wrangler dev` on :8787.
const apiTarget = process.env.PILE_API_URL ?? "http://localhost:8787";
const remoteTarget = !apiTarget.includes("localhost");
// Remote targets enforce a CSRF origin allowlist and Better Auth checks
// trusted origins, so spoof the SPA's production origin on the way out —
// identical to the same-origin traffic prod serves at /app.
const remoteHeaders = remoteTarget ? { headers: { origin: apiTarget } } : {};

export default defineConfig({
  base: "/app/",
  plugins: [
    tailwindcss(),
    tanstackRouter({ autoCodeSplitting: true }),
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    port: 5181,
    strictPort: true,
    proxy: {
      // Host rewrite only when pointing at a remote origin (PILE_API_URL)
      // — wrangler dev on :8787 doesn't route by Host, pile.nyc does.
      "/api": {
        target: apiTarget,
        changeOrigin: remoteTarget,
        ...remoteHeaders,
      },
      "/workspaces": {
        target: apiTarget,
        changeOrigin: remoteTarget,
        ...remoteHeaders,
      },
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 1600,
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
