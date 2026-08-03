import { describe, expect, it } from "vitest";
import {
  cliArgs,
  sessionFlagsStateKey,
  shellQuote,
  trustedHash,
} from "./trust";

const sessionStart = (command: string) => ({ event: "SessionStart", command });

describe("codex trust fingerprint (TS port of the host's Rust module)", () => {
  /** The worked example verified against codex-rs 0.142.5 (its own
   * hooks_list test suite reimplements the same chain) — if this hash ever
   * drifts, codex changed its fingerprint and the port must be re-checked.
   * The SAME pinned hex the Rust test used, so the port is provably
   * byte-identical. Its input is a bare path, which is what makes it
   * externally verifiable — and also why it can't stand alone; see below. */
  it("reproduces the verified codex fingerprint", async () => {
    expect(
      await trustedHash(
        sessionStart(
          "/Applications/KeepDeck.app/Contents/Resources/kd-codex-hook",
        ),
      ),
    ).toBe(
      "sha256:548f36baa64bfc51ad92bdb9e70bc95128c1710566ff6d35da5e8af8d7b51d26",
    );
  });

  /** The anchor above pins a shape the plugin NEVER emits: `index.ts` always
   * feeds `/bin/sh '<script>'`, whose quotes and spaces exercise escaping a
   * bare path doesn't reach. This hex is ours, not codex's — a change
   * detector over the real input, not a second external proof — so it
   * complements the anchor rather than replacing it. Recompute it only
   * alongside a deliberate, re-verified change to the identity encoding. */
  it("pins the fingerprint of the command shape the plugin actually emits", async () => {
    const emitted = sessionStart(
      "/bin/sh '/Applications/KeepDeck.app/Contents/Resources/kd-codex-hook.sh'",
    );
    expect(await trustedHash(emitted)).toBe(
      "sha256:65134d927bca71f55b9ef4d268d5e0f783cc09cc55ba4cdb6927293f639e48f8",
    );
  });

  /** Trust must never self-break: the state arg has to vouch for the exact
   * command the config arg defines — checked on the escaping-heavy shape the
   * plugin really emits. (The TOML escaping itself is pinned by "quoting
   * survives awkward paths" below.) */
  it("trusts exactly the command it defines", async () => {
    const emitted = sessionStart(
      `/bin/sh '/Apps/Keep Deck'\\''s Stuff/hook.sh'`,
    );
    const args = await cliArgs([emitted]);

    expect(args[3]).toContain(`trusted_hash = "${await trustedHash(emitted)}"`);
  });

  it("cli args define and trust in one invocation", async () => {
    const args = await cliArgs([sessionStart("/bin/sh '/x/kd-codex-hook.sh'")]);
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
        `hooks.state={"${sessionFlagsStateKey("SessionStart")}" = {trusted_hash = "sha256:`,
      ),
    ).toBe(true);
  });

  /** Multi-event arming — the status reporter's shape. Every event gets its
   * own config arg, but trust rides in ONE combined state table: codex
   * takes the LAST `-c hooks.state=` wholesale, so a second table would
   * silently untrust the first (live-verified on 0.146.0). */
  it("arms several events with one combined trust table", async () => {
    const rules = [
      sessionStart("/bin/sh '/x/kd-session-hook.sh'"),
      {
        event: "UserPromptSubmit",
        command: "/bin/sh '/x/kd-status-hook.sh' codex",
      },
      { event: "Stop", command: "/bin/sh '/x/kd-status-hook.sh' codex" },
    ];
    const args = await cliArgs(rules);
    // 3 config args + 1 state arg, each preceded by -c.
    expect(args).toHaveLength(8);
    expect(args.filter((a) => a === "-c")).toHaveLength(4);
    expect(args[3]).toContain("hooks.UserPromptSubmit=");
    expect(args[5]).toContain("hooks.Stop=");
    const state = args[7];
    expect(args.filter((a) => a.startsWith("hooks.state="))).toHaveLength(1);
    // The state keys spell the event in snake_case — a codex quirk.
    expect(state).toContain(`"${sessionFlagsStateKey("UserPromptSubmit")}"`);
    expect(state).toContain("user_prompt_submit:0:0");
    for (const rule of rules) {
      expect(state).toContain(`trusted_hash = "${await trustedHash(rule)}"`);
    }
  });

  it("quoting survives awkward paths", async () => {
    expect(shellQuote("/Apps/Keep Deck's Stuff/hook")).toBe(
      `'/Apps/Keep Deck'\\''s Stuff/hook'`,
    );
    const args = await cliArgs([sessionStart(`/bin/sh '/tmp/a "b"/hook'`)]);
    expect(args[1]).toContain(`command="/bin/sh '/tmp/a \\"b\\"/hook'"`);
  });
});
