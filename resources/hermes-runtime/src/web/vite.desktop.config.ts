import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  base: "./",
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "../electron/dist/renderer",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        index: path.resolve(root, "desktop.html"),
      },
    },
  },
});
