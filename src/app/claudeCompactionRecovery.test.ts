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
 * could not reach the deck), with only the paths and ids shortened — except
 * the oversize 400, which is the one a user's pane reported on 2.1.226.
 */
const report = (event: Record<string, unknown>) => ({ agent: "claude", event });

/** The oversize 400 exactly as a live pane reported it, on 2.1.226. */
const OVERSIZE_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1001633 tokens > 1000000 maximum"}}';

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

describe("a session that outgrew its context window", () => {
  it("keeps working through the overflow and the rebuild behind it", () => {
    const prompted = receive(
      null,
      { ...SESSION, hook_event_name: "UserPromptSubmit", prompt_id: "p1" },
      100,
    );
    expect(prompted?.activity).toEqual({ state: "working", since: 100 });

    // The 400 exactly as a live pane reported it. claude answers an
    // overflow by compacting and retrying the SAME request, so nothing
    // about the turn ended here: the pane must stay working, which also
    // keeps the failure out of the notification center.
    const overflowed = receive(
      prompted,
      {
        ...SESSION,
        hook_event_name: "StopFailure",
        error: "invalid_request",
        error_details: OVERSIZE_400,
      },
      200,
    );
    expect(overflowed).toBe(prompted);

    // The rebuild it triggers changes nothing either — the turn it belongs
    // to is still the one running.
    const compacted = receive(
      overflowed,
      { ...SESSION, hook_event_name: "SessionStart", source: "compact" },
      300,
    );
    expect(compacted).toBe(prompted);

    // The work resumes where it left off, and the turn ends as a turn.
    expect(
      receive(compacted, { ...SESSION, hook_event_name: "PostToolUse" }, 400)
        ?.activity,
    ).toEqual({ state: "working", since: 100 });
    expect(
      activityBadge(
        receive(compacted, { ...SESSION, hook_event_name: "Stop" }, 500)!
          .activity,
      ),
    ).toMatchObject({ tone: "done", label: "Done" });
  });

  it("frees the agent bracket a dead turn would have stranded", () => {
    // The terminal shape, the one the swallow accepts: claude cannot compact,
    // so nothing more arrives for this turn — and the background agent it
    // opened never reports either. `turn-failed` used to release that
    // bracket; reporting nothing at all would leave it open forever, and one
    // open bracket holds back EVERY later ending, which is unbounded rather
    // than "until the next prompt".
    const prompted = receive(
      null,
      { ...SESSION, hook_event_name: "UserPromptSubmit", prompt_id: "p1" },
      100,
    );
    const spawned = receive(
      prompted,
      { ...SESSION, hook_event_name: "SubagentStart", agent_id: "a1" },
      110,
    );
    expect(spawned?.openAgentTurns).toEqual(new Set(["a1"]));

    const overflowed = receive(
      spawned,
      {
        ...SESSION,
        hook_event_name: "StopFailure",
        error: "invalid_request",
        error_details: OVERSIZE_400,
      },
      200,
    );
    // Released, and still not an ending: the turn may well be running.
    expect(overflowed?.openAgentTurns.size).toBe(0);
    expect(overflowed?.activity).toEqual({ state: "working", since: 100 });

    // So the next turn can finish as itself.
    const next = receive(
      overflowed,
      { ...SESSION, hook_event_name: "UserPromptSubmit", prompt_id: "p2" },
      300,
    );
    expect(
      activityBadge(
        receive(next, { ...SESSION, hook_event_name: "Stop" }, 400)!.activity,
      ),
    ).toMatchObject({ tone: "done", label: "Done" });
  });

  it("still clears a pane whose failure arrived unreadable", () => {
    // Past the reporter's size cap a payload reaches us as its event name
    // alone, so an overflow can still card a pane — the normalizer refuses
    // to read an overflow into a failure it cannot see. That is what keeps
    // the compaction edge earning its place: it is the backstop for the
    // failures this lane could not identify.
    const failed = receive(
      null,
      { ...SESSION, hook_event_name: "StopFailure" },
      100,
    );
    expect(activityBadge(failed!.activity)).toMatchObject({
      tone: "failed",
      label: "Turn failed",
    });

    // The user runs `/compact`. It is a local command, so this is the ONLY
    // report it produces — no UserPromptSubmit before it, no Stop after.
    // Before this edge existed, the pane stayed red until the next prompt.
    const compacted = receive(
      failed,
      { ...SESSION, hook_event_name: "SessionStart", source: "compact" },
      200,
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
        300,
      )?.activity,
    ).toEqual({ state: "working", since: 300 });
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
      { ...SESSION, hook_event_name: "StopFailure", error: "server_error" },
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
