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
    // The approval-resolution stand-in: claude has no reply hook, but an
    // approved tool's completion proves the wait resolved.
    expect(
      normalizeClaudeStatus(wrap({ hook_event_name: "PostToolUse" }), 250),
    ).toEqual({ kind: "resumed", at: 250 });
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

  it("parks the turn while claude reports background work in flight", () => {
    // The probe-verified shape (2.1.220): the main thread replied, and a
    // background agent it launched is still running behind it.
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "Stop",
          last_assistant_message: "LAUNCHED",
          background_tasks: [
            {
              id: "acb5bea0d1b3101fd",
              type: "subagent",
              status: "running",
              description: "Sleep then report",
              agent_type: "general-purpose",
            },
          ],
        }),
        600,
      ),
    ).toEqual({ kind: "resumed", at: 600 });
    // A background SHELL task parks it the same way — the list is the fact,
    // its entry types are claude's business.
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "Stop",
          background_tasks: [
            { id: "by2qgl1uz", type: "shell", status: "running", command: "sleep 45" },
          ],
        }),
        650,
      ),
    ).toEqual({ kind: "resumed", at: 650 });
    // The wake's own Stop — nothing left in flight — ends the turn for real.
    expect(
      normalizeClaudeStatus(
        wrap({ hook_event_name: "Stop", background_tasks: [] }),
        700,
      ),
    ).toEqual({ kind: "turn-end", at: 700 });
  });

  it("ends the turn when the background list is absent or unreadable", () => {
    // Absent on an older build, and every shape that is not a list. Ending
    // the turn is the recoverable mistake — the next prompt opens a new one,
    // while a turn wrongly held open strands the pane on "Working".
    for (const background_tasks of [undefined, null, {}, "running", 3, true]) {
      expect(
        normalizeClaudeStatus(
          wrap({ hook_event_name: "Stop", background_tasks }),
          800,
        ),
      ).toEqual({ kind: "turn-end", at: 800 });
    }
    // A scheduled wakeup rides the same payload but is NOT in-flight work:
    // a cron an hour out is a genuinely idle session.
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "Stop",
          background_tasks: [],
          session_crons: [{ id: "c1", cron: "0 9 * * 1-5" }],
        }),
        800,
      ),
    ).toEqual({ kind: "turn-end", at: 800 });
  });

  it("fails a turn that died even with background work still running", () => {
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "StopFailure",
          error: "rate_limit",
          background_tasks: [{ id: "x", type: "subagent", status: "running" }],
        }),
        900,
      ),
    ).toEqual({ kind: "turn-failed", at: 900, error: "rate_limit" });
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
