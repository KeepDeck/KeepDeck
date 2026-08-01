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
    expect(
      normalizeCodexStatus(wrap({ hook_event_name: "PermissionRequest" }), 300),
    ).toEqual({ kind: "waiting", at: 300, reason: "permission" });
  });

  it("maps the rollout tailer's interrupt marker", () => {
    expect(
      normalizeCodexStatus({ agent: "codex", kind: "session.interrupt" }, 400),
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
