import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  resolve: {
    alias: {
      "@keepdeck/plugin-guest": resolve(__dirname, "../packages/plugin-guest/src/index.ts"),
      "@keepdeck/plugin-api": resolve(__dirname, "../packages/plugin-api/src/index.ts"),
    },
  },
  build: {
    lib: { entry: "logic.ts", formats: ["es"], fileName: () => "logic" },
    outDir: "out",
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: "logic.js" } },
  },
});
