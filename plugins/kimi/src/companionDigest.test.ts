import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { COMPANION_DESCRIPTOR } from "./companion";

/** The wire-critical resources, pinned by digest in the descriptor.
 *
 * This is the gate the 2026-08-26 drift slipped past: the reporter scripts
 * switched protocol, kimi.plugin.json kept its 1.6.0, and nothing reddened.
 * It reddens here — ANY edit to a listed file without regenerating the
 * descriptor (or, equivalently honestly, without a version bump that comes
 * with regenerated digests) fails this test before it ships.
 *
 * node:crypto rather than the runtime's crypto.subtle: this test is about
 * BYTES, and a second implementation of the hash could only agree with
 * sha256Hex by being the same hash — but a disagreement here would be a
 * bug in sha256Hex, tested where it lives, not a reason to trust the
 * descriptor any less. */
describe("companion descriptor digests", () => {
  const root = fileURLToPath(new URL("../resources", import.meta.url));

  it("matches the descriptor's sha256 for every wire-critical file", () => {
    expect(COMPANION_DESCRIPTOR.scripts.length).toBeGreaterThan(0);
    for (const { file, sha256 } of COMPANION_DESCRIPTOR.scripts) {
      const bytes = readFileSync(`${root}/keepdeck-session-reporter/${file}`);
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest, `digest drift in ${file} — regenerate the descriptor`).toBe(sha256);
    }
  });
});
