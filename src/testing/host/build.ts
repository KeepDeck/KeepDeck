// The host harness's binary: kd-host, the app on Tauri's test runtime
// (src-tauri/src/harness.rs). Built once per `pnpm test:host` run, as the
// run's global setup — cargo leaves a fresh build alone — and handed to the
// tests by path.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    /** Where the host binary was built. */
    hostBinary: string;
  }
}

export default function setup(project: TestProject): void {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const built = spawnSync("cargo", ["build", "--features", "host-harness", "--bin", "kd-host"], {
    cwd: join(root, "src-tauri"),
    stdio: "inherit",
  });
  if (built.status !== 0) throw new Error(`building kd-host failed (exit ${built.status ?? "signal"})`);
  project.provide("hostBinary", join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "debug", "kd-host"));
}
