import { defineConfig } from "vite";
import path from "path";

// harness run: the shared engine bundled for Node (npm run build:cli → cli/dist/harness-run.mjs).
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The engine reaches Tauri only through providerAdapter's Channel.
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/cli/tauriShim.ts"),
    },
  },
  // Everything in one file, so the bundle runs without resolving app packages.
  ssr: { noExternal: true },
  build: {
    ssr: "src/cli/runCli.ts",
    outDir: "cli/dist",
    emptyOutDir: true,
    target: "node18",
    minify: false,
    rollupOptions: { output: { entryFileNames: "harness-run.mjs", format: "es" } },
  },
});
