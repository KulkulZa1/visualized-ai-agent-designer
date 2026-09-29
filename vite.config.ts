import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Object-form manualChunks only names each package's entry module. For CJS
// packages (react, react-dom) that is an empty interop stub, so the real code
// landed in vendor-flow / index and vendor-react was emitted empty. Match by
// module id instead; the trailing slash keeps `react` from matching
// `react-dom` or `react-remove-scroll`. Modules a group pulls in that no group
// names (e.g. @xyflow/system, d3-*) still follow it, as with the object form.
const VENDOR_CHUNKS: Record<string, string[]> = {
  "vendor-react":   ["react", "react-dom", "scheduler"],
  "vendor-flow":    ["@xyflow/react"],
  "vendor-zustand": ["zustand", "zundo"],
  "vendor-editor":  ["@monaco-editor/react"],
  "vendor-yaml":    ["yaml"],
};

function manualChunks(id: string): string | undefined {
  // Rollup ids may use backslashes (Windows) and carry \0 / ?query interop suffixes.
  const normalized = id.replace(/\\/g, "/");
  // Keep CSS with its importer. A stylesheet placed in a manual chunk becomes that
  // chunk's own .css, linked before index.css, which would flip the cascade between
  // src/App.css and @xyflow/react/dist/style.css.
  if (/\.css(\?|$)/.test(normalized)) return undefined;
  for (const chunk of Object.keys(VENDOR_CHUNKS)) {
    if (VENDOR_CHUNKS[chunk].some((pkg) => normalized.indexOf(`/node_modules/${pkg}/`) !== -1)) return chunk;
  }
  return undefined;
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    // Stale agent worktrees under .claude/ carry their own test copies that
    // reference modules absent from this repo — never run them.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**", "**/src-tauri/**"],
    alias: {
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/ipc/mockTauri.ts"),
      "@tauri-apps/plugin-dialog": path.resolve(__dirname, "./src/ipc/mockPlugins.ts"),
      "@tauri-apps/plugin-fs": path.resolve(__dirname, "./src/ipc/mockPlugins.ts"),
    },
  },
}));
