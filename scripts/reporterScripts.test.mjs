import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_DIR,
  REPORTERS,
  rendered,
  stale,
} from "./sync-reporters.mjs";

/**
 * Each reporter is authored once under resources/reporters/ and shipped as a
 * real file inside every plugin that runs it. These pin the copies to that
 * source rather than to each other: identical-but-both-wrong passes a
 * copy-to-copy comparison, and a fix landing in one plugin and not the others
 * is a per-agent bug no unit test would catch.
 */
describe("reporter shell scripts", () => {
  it("ships every copy exactly as the canonical file renders", () => {
    expect(
      stale(),
      "run `node scripts/sync-reporters.mjs` to refresh these",
    ).toEqual([]);
  });

  it("keeps the shebang on line 1 and the generated banner under it", () => {
    for (const { name } of REPORTERS) {
      const lines = rendered(name).split("\n");
      // A shell script whose first line is a comment has no interpreter line;
      // the banner must never take that slot.
      expect(lines[0], name).toBe("#!/bin/sh");
      expect(lines[1], name).toContain("GENERATED from resources/reporters/");
    }
  });

  it("leaves the canonical files without a banner", () => {
    // A banner in the source would ship doubled, and would tell a reader
    // editing the right file that they are in the wrong one.
    for (const { name } of REPORTERS) {
      const source = readFileSync(join(CANONICAL_DIR, name), "utf8");
      expect(source, name).not.toContain("GENERATED from");
    }
  });

  it("guards envelope size in bytes, not characters", () => {
    // The bridge cap is bytes; ${#var} counts characters under the UTF-8
    // locale every spawn gets. The guard must never regress to it.
    const script = readFileSync(join(CANONICAL_DIR, "kd-status-hook.sh"), "utf8");
    expect(script).toContain("wc -c");
    expect(script).not.toMatch(/\$\{#payload\}"? -gt/);
  });

  it("keeps the reduction threshold under the bridge's own envelope cap", () => {
    // The shell threshold and the cap it exists to stay below live in
    // different languages in different crates, with nothing but this test
    // linking them. They have already drifted once — the shell sat at
    // exactly half the bridge's limit, so every payload in the gap was
    // reduced although it would have been delivered whole. Tighten the cap
    // in Rust without this, and the drift goes the other way: envelopes
    // between the new cap and the stale threshold are forwarded intact and
    // dropped unread, stranding the pane the reduction exists to save.
    const script = readFileSync(join(CANONICAL_DIR, "kd-status-hook.sh"), "utf8");
    // Anchored to the guard's own variable: a bare `-gt` would happily match
    // any later comparison someone adds above it and silently start
    // asserting the wrong number.
    const threshold = script.match(/"\$bytes"\s+-gt\s+(\d+)/);
    expect(threshold, "no byte threshold found in the reporter").not.toBeNull();

    const bridge = readFileSync("src-tauri/src/bridge.rs", "utf8");
    const cap = bridge.match(/MAX_ENVELOPE_BYTES[^=]*=\s*([0-9*\s]+);/);
    expect(cap, "no MAX_ENVELOPE_BYTES found in the bridge").not.toBeNull();
    const capBytes = cap[1]
      .split("*")
      .reduce((product, part) => product * Number(part.trim()), 1);

    // BOTH directions. Too high and an envelope the bridge rejects is
    // forwarded whole, stranding the pane; too low and every payload in the
    // gap is needlessly reduced — the drift that already happened once, when
    // the shell sat at exactly half. The lower bound leaves room only for the
    // wrapper (~170 bytes with uuid-ish pane and token values).
    expect(Number(threshold[1])).toBeLessThan(capBytes - 512);
    expect(Number(threshold[1])).toBeGreaterThan(capBytes - 2048);
  });
});
