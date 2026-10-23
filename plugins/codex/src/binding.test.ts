import { describe, expect, it } from "vitest";
import { codexBinding } from "./binding";

/** What codex's own TUI writes into a thread the user started (codex 0.163,
 * measured), as the session reporter passes it along. */
const tui = { originator: "codex-tui", source: "cli", thread_source: "user" };

describe("codex's /new", () => {
  it("is a fresh start from the pane's own TUI thread", () => {
    expect(codexBinding.restartsConversation({ source: "startup", facts: tui })).toBe(true);
  });

  it("is not a nested `codex exec`, nor a thread the user did not start", () => {
    for (const facts of [
      { originator: "codex_exec", source: "exec", thread_source: "user" },
      { ...tui, thread_source: "subagent" },
      { ...tui, source: "exec" },
    ]) {
      expect(codexBinding.restartsConversation({ source: "startup", facts })).toBe(false);
    }
  });

  it("is nothing it cannot read: no facts, or a word other than startup", () => {
    // A reporter too old to add the facts, a rollout not written yet — the
    // deck's refusal stands, as before.
    expect(codexBinding.restartsConversation({ source: "startup", facts: {} })).toBe(false);
    expect(codexBinding.restartsConversation({ facts: tui })).toBe(false);
    expect(codexBinding.restartsConversation({ source: "resume", facts: tui })).toBe(false);
  });
});
