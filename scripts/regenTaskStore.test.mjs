import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./lint/cliNames.mjs";

/**
 * The task store's codegen (scripts/regen-task-store.sh) leans on rustfmt:
 * `diesel print-schema` formats schema.rs through it, and without it writes
 * the same schema unformatted and says nothing. CI's "Generated code is
 * current" then fails on a diff nobody made — which is how pinning the
 * toolchain with clippy alone turned main red.
 */
describe("regen-task-store", () => {
  it("runs on a pinned Rust that carries rustfmt", () => {
    // A runner installs the pin with the minimal profile: a component that
    // is not listed does not arrive.
    const toolchain = readFileSync(join(REPO, "rust-toolchain.toml"), "utf8");
    expect(toolchain).toMatch(/^components = \[.*"rustfmt".*\]$/m);
  });

  it("refuses to regenerate when rustfmt does not run, instead of writing an unformatted schema", () => {
    // What a runner holds when the toolchain lacks the component: rustup's
    // proxy, which is on PATH and fails.
    const bin = mkdtempSync(join(tmpdir(), "regen-task-store-"));
    try {
      const rustfmt = join(bin, "rustfmt");
      writeFileSync(rustfmt, "#!/bin/sh\necho \"error: 'rustfmt' is not installed for the toolchain\" >&2\nexit 1\n");
      chmodSync(rustfmt, 0o755);
      const run = spawnSync("/bin/bash", [join(REPO, "scripts/regen-task-store.sh")], {
        env: { PATH: `${bin}:/usr/bin:/bin` },
        encoding: "utf8",
      });
      expect(run.stderr).toContain("rustfmt does not run here");
      expect(run.status).toBe(1);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
