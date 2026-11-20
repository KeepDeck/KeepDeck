/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The page's tests on the real host: the app itself (src-tauri's kd-host, on
// Tauri's test runtime) in a process of its own per test, over a pipe. Run
// apart from `pnpm test`, which needs no Rust: `pnpm test:host`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    setupFiles: ["src/actEnvironment.test-support.ts"],
    include: ["src/**/*.host.test.{ts,tsx}", "integration/**/*.host.test.{ts,tsx}"],
    globalSetup: ["src/testing/host/build.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
