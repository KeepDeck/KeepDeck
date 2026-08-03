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

  it("keeps the reduction threshold under the bridge's own envelope cap", () => {
    // The shell threshold and the cap it exists to stay below live in
    // different languages in different crates, with nothing but this test
    // linking them. They have already drifted once — the shell sat at
    // exactly half the bridge's limit, so every payload in the gap was
    // reduced although it would have been delivered whole. Tighten the cap
    // in Rust without this, and the drift goes the other way: envelopes
    // between the new cap and the stale threshold are forwarded intact and
    // dropped unread, stranding the pane the reduction exists to save.
    const script = readFileSync(STATUS_COPIES[0], "utf8");
    const threshold = script.match(/-gt (\d+)/);
    expect(threshold, "no byte threshold found in the reporter").not.toBeNull();

    const bridge = readFileSync("src-tauri/src/bridge.rs", "utf8");
    const cap = bridge.match(/MAX_ENVELOPE_BYTES[^=]*=\s*([0-9*\s]+);/);
    expect(cap, "no MAX_ENVELOPE_BYTES found in the bridge").not.toBeNull();
    const capBytes = cap[1]
      .split("*")
      .reduce((product, part) => product * Number(part.trim()), 1);

    // Strictly below, with room for the envelope the reporter wraps around
    // the payload (~170 bytes with uuid-ish pane and token values).
    expect(Number(threshold[1])).toBeLessThan(capBytes - 512);
  });
});
