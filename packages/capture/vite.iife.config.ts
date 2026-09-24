import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: false,
    lib: {
      entry: "src/index.ts",
      name: "PileCapture",
      formats: ["iife"],
      fileName: () => "capture.iife.js",
    },
    outDir: "dist",
    minify: true,
  },
});
