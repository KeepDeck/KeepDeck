/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Default to pure-module tests (no DOM); files opt into a DOM via the
  // `// @vitest-environment happy-dom` pragma. `.tsx` is included for component
  // tests (e.g. portaled dialogs).
  test: {
    environment: "node",
    include: [
      "src/**/*.test.{ts,tsx}",
      "scripts/**/*.test.mjs",
      "packages/*/src/**/*.test.{ts,tsx}",
      "plugins/*/src/**/*.test.{ts,tsx}",
    ],
  },
}));
