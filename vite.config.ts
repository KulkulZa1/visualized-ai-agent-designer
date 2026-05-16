import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

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
        manualChunks: {
          "vendor-react":   ["react", "react-dom"],
          "vendor-flow":    ["@xyflow/react"],
          "vendor-zustand": ["zustand", "zundo"],
          "vendor-editor":  ["@monaco-editor/react"],
          "vendor-yaml":    ["yaml"],
        },
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
    alias: {
      "@tauri-apps/api/core": path.resolve(__dirname, "./src/ipc/mockTauri.ts"),
      "@tauri-apps/plugin-dialog": path.resolve(__dirname, "./src/ipc/mockPlugins.ts"),
      "@tauri-apps/plugin-fs": path.resolve(__dirname, "./src/ipc/mockPlugins.ts"),
    },
  },
}));
