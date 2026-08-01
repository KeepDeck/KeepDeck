import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The status reporter is ONE script shipped as three per-plugin copies —
 * each plugin's bundle must stay self-contained, but the copies must never
 * drift: a fix landing in one (the byte-size guard, the silence contract)
 * and not the others is a per-agent bug that no unit test would catch.
 * Same idea as the settings/dock CSS content pins.
 */
const STATUS_COPIES = [
  "plugins/claude/resources/kd-status-hook.sh",
  "plugins/codex/resources/kd-status-hook.sh",
  "plugins/kimi/resources/keepdeck-session-reporter/kd-status-hook.sh",
];

/** The session hook is shared claude↔codex only — kimi's differs by design
 * (no transcript_path in its payload; it derives the wire path itself). */
const SESSION_COPIES = [
  "plugins/claude/resources/kd-session-hook.sh",
  "plugins/codex/resources/kd-session-hook.sh",
];

describe("reporter shell scripts", () => {
  it("keeps every kd-status-hook.sh copy byte-identical", () => {
    const [first, ...rest] = STATUS_COPIES.map((p) => readFileSync(p, "utf8"));
    for (const [i, copy] of rest.entries()) {
      expect(copy, `${STATUS_COPIES[i + 1]} drifted from ${STATUS_COPIES[0]}`).toBe(
        first,
      );
    }
  });

  it("keeps the claude and codex kd-session-hook.sh copies byte-identical", () => {
    const [claude, codex] = SESSION_COPIES.map((p) => readFileSync(p, "utf8"));
    expect(codex).toBe(claude);
  });

  it("guards envelope size in bytes, not characters", () => {
    // The bridge cap is bytes; ${#var} counts characters under the UTF-8
    // locale every spawn gets. The guard must never regress to it.
    const script = readFileSync(STATUS_COPIES[0], "utf8");
    expect(script).toContain("wc -c");
    expect(script).not.toMatch(/\$\{#payload\}"? -gt/);
  });
});
