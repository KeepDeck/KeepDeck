import { describe, expect, it } from "vitest";
import { normalizeClaudeStatus } from "../../plugins/claude/src/status";
import { reduceStatus, type PaneStatus } from "../domain/status/activity";
import { activityBadge } from "../domain/status/format";

/**
 * The oversize-request recovery, end to end: claude's own hook payloads →
 * the plugin's normalizer → the host's fold → what the pane renders.
 *
 * The two halves are unit-tested apart, and TypeScript pins the edge kind
 * between them. What only this can catch is the PAYLOADS: the units feed
 * hand-written minimal events, while a real hook carries `session_id`,
 * `transcript_path`, `cwd`, `model` and `prompt_id` alongside the two
 * fields the normalizer reads. Every payload below is verbatim from a live
 * claude 2.1.222 (an isolated probe run with `KEEPDECK_BRIDGE` unset, so it
 * could not reach the deck), with only the paths and ids shortened.
 */
const report = (event: Record<string, unknown>) => ({ agent: "claude", event });

const SESSION = {
  session_id: "6b1641cc-7907-4835-aaf5-b5362886a6d3",
  transcript_path: "/Users/x/.claude/projects/-repo/6b1641cc.jsonl",
  cwd: "/repo",
};

/** Feed one hook payload through both halves, exactly as the channel does. */
const receive = (
  state: PaneStatus | null,
  event: Record<string, unknown>,
  at: number,
): PaneStatus | null => {
  const edge = normalizeClaudeStatus(report(event), at);
  return edge === null ? state : reduceStatus(state, edge);
};

describe("a pane that failed on an oversize request", () => {
  it("goes red on the failure and idle once the user compacts", () => {
    const prompted = receive(
      null,
      { ...SESSION, hook_event_name: "UserPromptSubmit", prompt_id: "p1" },
      100,
    );
    expect(prompted?.activity).toEqual({ state: "working", since: 100 });

    // claude gave up: it fires StopFailure INSTEAD of Stop, carrying its
    // typed reason and the raw 400. A compaction that RESCUES the turn
    // fires no StopFailure at all, so reaching this state means the turn
    // really did end.
    const failed = receive(
      prompted,
      {
        ...SESSION,
        hook_event_name: "StopFailure",
        error: "invalid_request",
        error_details:
          '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1000908 tokens > 1000000 maximum"}}',
      },
      200,
    );
    expect(activityBadge(failed!.activity)).toMatchObject({
      tone: "failed",
      label: "Invalid request",
    });

    // The user runs `/compact`. It is a local command, so this is the ONLY
    // report it produces — no UserPromptSubmit before it, no Stop after.
    // Before this edge existed, the pane stayed red until the next prompt.
    const compacted = receive(
      failed,
      { ...SESSION, hook_event_name: "SessionStart", source: "compact" },
      300,
    );
    expect(activityBadge(compacted!.activity)).toMatchObject({
      tone: "done",
      label: "Interrupted",
    });

    // And the next prompt runs normally.
    expect(
      receive(
        compacted,
        { ...SESSION, hook_event_name: "UserPromptSubmit", prompt_id: "p2" },
        400,
      )?.activity,
    ).toEqual({ state: "working", since: 400 });
  });

  it("is untouched by the automatic compaction inside a live turn", () => {
    // The auto path reports the same SessionStart, but from INSIDE a turn:
    // UserPromptSubmit → PreCompact(auto) → SessionStart(compact) → Stop.
    // The turn is already running and its own Stop ends it, so the rebuild
    // must change nothing — not the state, and not the phase's age.
    const working = receive(
      null,
      { ...SESSION, hook_event_name: "UserPromptSubmit" },
      100,
    );
    const during = receive(
      working,
      { ...SESSION, hook_event_name: "SessionStart", source: "compact" },
      200,
    );
    expect(during).toBe(working);

    expect(
      receive(during, { ...SESSION, hook_event_name: "Stop" }, 300)?.activity,
    ).toEqual({ state: "done", at: 300, interrupted: false });
  });

  it("ignores the session events that merely announce a prompt", () => {
    // A boot and a resume both fire SessionStart. Reading either as a
    // compaction would retire a failure nobody addressed.
    //
    // Driven from `failed` ON PURPOSE. Against a running pane this case
    // proves nothing: the fold leaves a live turn alone for EVERY
    // `context-compacted`, so it would pass just as green with the
    // normalizer's `source` check deleted. `failed` is the one state the
    // edge moves, which makes the assertion discriminating.
    const failed = receive(
      null,
      {
        ...SESSION,
        hook_event_name: "StopFailure",
        error: "invalid_request",
        error_details: "prompt is too long",
      },
      100,
    );
    for (const source of ["startup", "resume", "clear", "fork"]) {
      expect(
        receive(
          failed,
          { ...SESSION, hook_event_name: "SessionStart", source },
          200,
        ),
        source,
      ).toBe(failed);
    }
  });
});
