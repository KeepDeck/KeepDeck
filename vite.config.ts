/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    rollupOptions: {
      input: {
        index: "index.html",
        // The five bridge chunks plugin bundles resolve through the
        // production import map (see index.html). They need STABLE
        // filenames — a plugin's import map entry can't chase a content
        // hash across app releases — so they get explicit `entryFileNames`
        // below, while every other entry (the app itself) keeps the normal
        // hashed name for cache-busting.
        "react-bridge": "src/plugins/bridges/react.js",
        "react-jsx-runtime-bridge": "src/plugins/bridges/react-jsx-runtime.js",
        "react-dom-bridge": "src/plugins/bridges/react-dom.js",
        "react-dom-client-bridge": "src/plugins/bridges/react-dom-client.js",
        "plugin-api-bridge": "src/plugins/bridges/plugin-api.js",
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name.endsWith("-bridge")
            ? `assets/${chunk.name}.js`
            : "assets/[name]-[hash].js",
      },
      // Vite's app build defaults to `preserveEntrySignatures: false`, which
      // STRIPS a chunk's exports once it decides the chunk is an "entry" —
      // verified in a live spike: without this, the bridge chunks build
      // clean but export nothing, so the import map resolves plugin imports
      // to a module with no named bindings. "exports-only" keeps each
      // entry's exports (bridges need it) without generating the full
      // preserved-facade output shape a plain library build would.
      preserveEntrySignatures: "exports-only",
    },
  },

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
