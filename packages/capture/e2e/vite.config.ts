import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: {
      entry: "src/index.ts",
      name: "PileCapture",
      formats: ["iife"],
      fileName: () => "capture.js",
    },
    outDir: "e2e/.bundle",
    minify: false,
  },
});
