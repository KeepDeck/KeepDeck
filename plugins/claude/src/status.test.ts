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
    ).toEqual({ kind: "parked", at: 600 });
    // Entry STATUS is never read: claude lists only in-flight work. Pinned
    // so a future "helpful" filter on `status` has to break a test rather
    // than the contract.
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "Stop",
          background_tasks: [{ id: "q1", type: "subagent", status: "pending" }],
        }),
        660,
      ),
    ).toEqual({ kind: "parked", at: 660 });
    // The rest of the allowlist. `workflow` and `monitor` are published;
    // `MCP task` is not — it is one of the six kinds the shipped mapper
    // emits beyond the documented enum, and the only one of those six that
    // is genuinely work this pane is waiting on. Note the SPACE: it is a
    // display-ish string, not an identifier, so it is pinned literally.
    for (const type of ["workflow", "monitor", "MCP task"]) {
      expect(
        normalizeClaudeStatus(
          wrap({
            hook_event_name: "Stop",
            background_tasks: [{ id: "w1", type, status: "running" }],
          }),
          670,
        ),
      ).toEqual({ kind: "parked", at: 670 });
    }
  });

  it("holds the turn open for no OTHER kind the shipped mapper emits", () => {
    // Every kind claude 2.1.220 can put on the wire that is not on the
    // allowlist, each excluded for its own reason:
    //
    // - shell: the user parked it deliberately — a dev server, a watcher, a
    //   tail. It may never finish, and nothing wakes the session when it
    //   does (the agent polls it with BashOutput inside a turn). Treating it
    //   as parking meant one `npm run dev` made EVERY later turn park.
    // - teammate: an IDLE teammate is indistinguishable from a busy one
    //   here. It keeps status "running", its `isIdle` flag never reaches the
    //   payload, and the entry outlives its idleness — claude evicts only
    //   TERMINAL tasks. Parking on it would strand the pane on "Working" for
    //   the whole life of the team.
    // - cloud session: a detached `--bg` run that `claude agents` owns; it
    //   does not wake this session.
    // - dream / auto-mode scan: ambient housekeeping, not the turn.
    // - an unknown kind: of the six kinds beyond the published enum, five
    //   were not work, so silence is the better prior. A record with NO type
    //   at all is the same case.
    for (const task of [
      { id: "by2qgl1uz", type: "shell", status: "running", command: "npm run dev" },
      { id: "t1", type: "teammate", status: "running", description: "Reviewer" },
      { id: "c1", type: "cloud session", status: "running" },
      { id: "d1", type: "dream", status: "running" },
      { id: "a2", type: "auto-mode scan", status: "running" },
      { id: "u1", type: "telepathy", status: "running" },
      { id: "n1", status: "running" },
    ]) {
      expect(
        normalizeClaudeStatus(
          wrap({ hook_event_name: "Stop", background_tasks: [task] }),
          650,
        ),
      ).toEqual({ kind: "turn-end", at: 650 });
    }
    // A subagent running ALONGSIDE one still parks — the excluded entry is
    // ignored, not the whole list.
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "Stop",
          background_tasks: [
            { id: "s1", type: "shell", status: "running", command: "npm run dev" },
            { id: "a1", type: "subagent", status: "running" },
          ],
        }),
        655,
      ),
    ).toEqual({ kind: "parked", at: 655 });
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

  it("brackets one helper's turn from the agent-loop hooks", () => {
    // Probe-verified on 2.1.220: the pair carries the SAME agent_id, and
    // that id is also the entry id in the Stop payload's task list. Both a
    // background subagent and a teammate run through this one agent loop,
    // which is why the bracket can answer what the task list cannot — a
    // teammate stays listed as "running" for as long as the team lives.
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "SubagentStart",
          agent_id: "af40aa53702b05b1b",
          agent_type: "general-purpose",
        }),
        400,
      ),
    ).toEqual({ kind: "helper-start", at: 400, id: "af40aa53702b05b1b" });
    expect(
      normalizeClaudeStatus(
        wrap({
          hook_event_name: "SubagentStop",
          agent_id: "af40aa53702b05b1b",
          agent_type: "general-purpose",
        }),
        460,
      ),
    ).toEqual({ kind: "helper-end", at: 460, id: "af40aa53702b05b1b" });
  });

  it("drops an unpairable start but never a close", () => {
    // A start with no usable id would open a bracket nothing can close, and
    // an open bracket holds the turn open forever — the exact failure this
    // whole mechanism exists to avoid. Ending a turn early is repaired by
    // the next wake; a stuck "Working" is repaired by nothing.
    for (const agent_id of [undefined, "", 7, null]) {
      expect(
        normalizeClaudeStatus(
          wrap({ hook_event_name: "SubagentStart", agent_id }),
          400,
        ),
      ).toBeNull();
    }
    // The close still lands. An oversized payload is reduced to its event
    // name alone, so the id is exactly what goes missing first — and a
    // nameless close is read by the host as "all of them".
    for (const agent_id of [undefined, "", 7, null]) {
      expect(
        normalizeClaudeStatus(
          wrap({ hook_event_name: "SubagentStop", agent_id }),
          460,
        ),
      ).toEqual({ kind: "helper-end", at: 460 });
    }
  });

  it("resolves a wait on any tool completion, a subagent's included", () => {
    // Filtering subagent edges on `agent_id` was tried and reverted: a wait
    // records nothing about WHO raised it, so dropping them also drops the
    // completion that actually answered it — and a synchronous Task blocks
    // the main thread from sending any, stranding an answered approval on
    // amber for the whole subagent run. Clearing early self-corrects; a
    // stuck amber does not.
    for (const event of [
      { hook_event_name: "PostToolUse", tool_name: "Edit" },
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        agent_id: "acb5bea0d1b3101fd",
        agent_type: "general-purpose",
      },
    ]) {
      expect(normalizeClaudeStatus(wrap(event), 500)).toEqual({
        kind: "resumed",
        at: 500,
      });
    }
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
