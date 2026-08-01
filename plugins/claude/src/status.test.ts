import { describe, expect, it } from "vitest";
import { normalizeClaudeStatus } from "./status";

/** Hook payloads as the reporter wraps them (event verbatim from stdin). */
const wrap = (event: Record<string, unknown>) => ({ agent: "claude", event });

describe("normalizeClaudeStatus", () => {
  it("maps the turn boundaries", () => {
    expect(
      normalizeClaudeStatus(wrap({ hook_event_name: "UserPromptSubmit" }), 100),
    ).toEqual({ kind: "turn-start", at: 100 });
    expect(
      normalizeClaudeStatus(wrap({ hook_event_name: "Stop" }), 200),
    ).toEqual({ kind: "turn-end", at: 200 });
  });

  it("maps StopFailure with claude's typed reason and prose", () => {
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "StopFailure",
          error: "rate_limit",
          error_details: "Weekly limit reached",
        }),
        300,
      ),
    ).toEqual({
      kind: "turn-failed",
      at: 300,
      error: "rate_limit",
      detail: "Weekly limit reached",
    });
    // No detail key when claude sent none.
    const failed = normalizeClaudeStatus(
      wrap({ hook_event_name: "StopFailure", error: "overloaded" }),
      300,
    );
    expect(failed).toEqual({ kind: "turn-failed", at: 300, error: "overloaded" });
    expect(failed && "detail" in failed).toBe(false);
    // A malformed error field degrades to "unknown", never to a crash.
    expect(
      normalizeClaudeStatus(wrap({ hook_event_name: "StopFailure" }), 300),
    ).toEqual({ kind: "turn-failed", at: 300, error: "unknown" });
  });

  it("maps only the two waiting notification types", () => {
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "Notification",
          notification_type: "permission_prompt",
        }),
        400,
      ),
    ).toEqual({ kind: "waiting", at: 400, reason: "permission" });
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "Notification",
          notification_type: "agent_needs_input",
        }),
        400,
      ),
    ).toEqual({ kind: "waiting", at: 400, reason: "question" });
    // idle_prompt is not a turn state.
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "Notification",
          notification_type: "idle_prompt",
        }),
        400,
      ),
    ).toBeNull();
  });

  it("maps the tailer's interrupt marker at the marker's own time", () => {
    expect(
      normalizeClaudeStatus(
        {
          agent: "claude",
          kind: "session.interrupt",
          sourceAt: "2026-08-01T10:00:00Z",
        },
        500,
      ),
    ).toEqual({ kind: "interrupted", at: Date.parse("2026-08-01T10:00:00Z") });
    // The mtime fallback, then receipt time when the marker names nothing.
    expect(
      normalizeClaudeStatus(
        { agent: "claude", kind: "session.interrupt", sourceMtimeMs: 1234 },
        500,
      ),
    ).toEqual({ kind: "interrupted", at: 1234 });
    expect(
      normalizeClaudeStatus({ agent: "claude", kind: "session.interrupt" }, 500),
    ).toEqual({ kind: "interrupted", at: 500 });
  });

  it("drops untracked events and garbage", () => {
    expect(
      normalizeClaudeStatus(wrap({ hook_event_name: "SessionStart" }), 100),
    ).toBeNull();
    expect(normalizeClaudeStatus({ agent: "claude" }, 100)).toBeNull();
    expect(normalizeClaudeStatus("garbage", 100)).toBeNull();
    expect(normalizeClaudeStatus(null, 100)).toBeNull();
  });
});
