import { describe, expect, it } from "vitest";
import { cliArgs, SESSION_FLAGS_STATE_KEY, shellQuote, trustedHash } from "./trust";

describe("codex trust fingerprint (TS port of the host's Rust module)", () => {
  /** The worked example verified against codex-rs 0.142.5 (its own
   * hooks_list test suite reimplements the same chain) — if this hash ever
   * drifts, codex changed its fingerprint and the port must be re-checked.
   * The SAME pinned hex the Rust test used, so the port is provably
   * byte-identical. */
  it("reproduces the verified codex fingerprint", async () => {
    expect(
      await trustedHash(
        "/Applications/KeepDeck.app/Contents/Resources/kd-codex-hook",
      ),
    ).toBe(
      "sha256:548f36baa64bfc51ad92bdb9e70bc95128c1710566ff6d35da5e8af8d7b51d26",
    );
  });

  it("cli args define and trust in one invocation", async () => {
    const args = await cliArgs("/bin/sh '/x/kd-codex-hook.sh'");
    expect(args).toHaveLength(4);
    expect(args[0]).toBe("-c");
    expect(args[1]).toBe(
      'hooks.SessionStart=[{hooks=[{type="command",command="/bin/sh \'/x/kd-codex-hook.sh\'"}]}]',
    );
    expect(args[2]).toBe("-c");
    // The state key rides INSIDE the value as a quoted key — the -c
    // dotted-path splitter would mangle it on the left-hand side.
    expect(
      args[3].startsWith(
        `hooks.state={"${SESSION_FLAGS_STATE_KEY}" = {trusted_hash = "sha256:`,
      ),
    ).toBe(true);
  });

  it("quoting survives awkward paths", async () => {
    expect(shellQuote("/Apps/Keep Deck's Stuff/hook")).toBe(
      `'/Apps/Keep Deck'\\''s Stuff/hook'`,
    );
    const args = await cliArgs(`/bin/sh '/tmp/a "b"/hook'`);
    expect(args[1]).toContain(`command="/bin/sh '/tmp/a \\"b\\"/hook'"`);
  });
});
