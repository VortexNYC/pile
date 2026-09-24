import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: true,
    lib: {
      entry: "src/index.ts",
      name: "PileChat",
      formats: ["iife"],
      fileName: () => "chat.iife.js",
    },
  },
});
