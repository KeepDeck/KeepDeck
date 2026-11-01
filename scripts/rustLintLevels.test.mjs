import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO } from "./lint/cliNames.mjs";
import { inlineSuppressions } from "./lint/rustTokens.mjs";

/**
 * No Rust source silences a lint inline (task-584) — the Rust half of what
 * ESLint's `noInlineConfig` is for TypeScript. A warning is fixed at its
 * cause; the policy for what is a warning lives in one place, the clippy
 * gate CI runs (`cargo clippy --workspace --all-targets -- -D warnings`).
 */
describe("inline lint suppressions in Rust", () => {
  it("finds allow and expect in any attribute, and nothing in prose", () => {
    const source = [
      "// #[allow(dead_code)] in a comment",
      "/* #[expect(unused)] */",
      "/// Never write #[allow(...)] here.",
      'const S: &str = "#[allow(x)]";',
      "#[derive(Debug, Clone)]",
      "#[allow(dead_code)]",
      "#[cfg_attr(not(target_os = \"macos\"), allow(dead_code))]",
      "#![expect(clippy::unwrap_used)]",
      "#[cfg(test)]",
      "#[allow(unused)]",
      "fn allow(x: u8) -> u8 { x }",
      "#[deny(warnings)]",
      "#[must_use = \"allow(it)\"]",
    ].join("\n");
    expect(inlineSuppressions(source)).toEqual([
      { level: "allow", line: 6 },
      { level: "allow", line: 7 },
      { level: "expect", line: 8 },
      { level: "allow", line: 10 },
    ]);
  });

  it("lints with one exact Rust: the gate's lint set moves only when the pin does", () => {
    // A channel like "stable" would hand CI whatever macos-latest ships,
    // and a new release's lints would turn the gate red with no change of
    // ours.
    const toolchain = readFileSync(join(REPO, "rust-toolchain.toml"), "utf8");
    expect(toolchain).toMatch(/^channel = "\d+\.\d+\.\d+"$/m);
    expect(toolchain).toMatch(/^components = \[.*"clippy".*\]$/m);
  });

  it("holds for every tracked Rust file", () => {
    const files = execFileSync("git", ["ls-files", "-z", "*.rs"], { cwd: REPO, encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const found = files.flatMap((file) =>
      inlineSuppressions(readFileSync(join(REPO, file), "utf8")).map(({ level, line }) => `${file}:${line} ${level}`),
    );
    expect(found).toEqual([]);
  });
});
