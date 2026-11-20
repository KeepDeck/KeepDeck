// The host harness's binary: kd-host, the app on Tauri's test runtime
// (src-tauri/src/harness.rs). Built once per `pnpm test:host` run, as the
// run's global setup; cargo leaves a fresh build alone.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

/** Where cargo puts the host binary. */
export function hostBinary(): string {
  return join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "debug", "kd-host");
}

export default function setup(): void {
  const built = spawnSync("cargo", ["build", "--features", "host-harness", "--bin", "kd-host"], {
    cwd: join(root, "src-tauri"),
    stdio: "inherit",
  });
  if (built.status !== 0) throw new Error(`building kd-host failed (exit ${built.status ?? "signal"})`);
}
