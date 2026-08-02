import { describe, expect, it } from "vitest";
import { normalizeCodexStatus } from "./status";

const wrap = (event: Record<string, unknown>) => ({ agent: "codex", event });

describe("normalizeCodexStatus", () => {
  it("maps the turn boundaries and the permission wait", () => {
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "UserPromptSubmit" }), 100),
    ).toEqual({ kind: "turn-start", at: 100 });
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "Stop" }), 200),
    ).toEqual({ kind: "turn-end", at: 200 });
    // The approval-resolution stand-in: an approved tool's completion is
    // the first post-approval hook codex offers.
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "PostToolUse" }), 250),
    ).toEqual({ kind: "resumed", at: 250 });
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "PermissionRequest" }), 300),
    ).toEqual({ kind: "waiting", at: 300, reason: "permission" });
  });

  it("maps every abort marker to interrupted, at its own time", () => {
    expect(
      normalizeCodexStatus(
        {
          agent: "codex",
          kind: "session.interrupt",
          reason: "interrupted",
          sourceAt: "2026-08-01T10:00:00Z",
        },
        400,
      ),
    ).toEqual({ kind: "interrupted", at: Date.parse("2026-08-01T10:00:00Z") });
    // A non-Esc abort did not COMPLETE either — "Done" would announce a
    // finish nobody got; the quiet "Interrupted" is the smaller lie.
    expect(
      normalizeCodexStatus(
        { agent: "codex", kind: "session.interrupt", reason: "budget_exceeded" },
        400,
      ),
    ).toEqual({ kind: "interrupted", at: 400 });
    // No usable source time falls back to receipt.
    expect(
      normalizeCodexStatus(
        { agent: "codex", kind: "session.interrupt", reason: "interrupted" },
        400,
      ),
    ).toEqual({ kind: "interrupted", at: 400 });
  });

  it("drops untracked events and garbage", () => {
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "SessionStart" }), 100),
    ).toBeNull();
    expect(normalizeCodexStatus({ agent: "codex" }, 100)).toBeNull();
    expect(normalizeCodexStatus(42, 100)).toBeNull();
  });
});
