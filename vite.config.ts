import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Side panel (HTML) + background service worker. Both ship as ES modules.
// Paths are relative to the project root, which Vite resolves for us - `__dirname`
// does not exist in this ESM config.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    rollupOptions: {
      input: {
        sidepanel: "src/sidepanel/index.html",
        background: "src/background/index.ts",
      },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
