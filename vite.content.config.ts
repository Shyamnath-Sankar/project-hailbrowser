import { defineConfig } from "vite";

// Content scripts cannot be ES modules in an MV3 manifest, so they get their own
// IIFE build that appends to the same dist/ directory.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    target: "chrome120",
    lib: {
      entry: "src/content/index.ts",
      name: "__pbContent",
      formats: ["iife"],
      fileName: () => "content.js",
    },
  },
});
