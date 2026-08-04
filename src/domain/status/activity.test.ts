import { describe, expect, it } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import {
  answerResolves,
  reduceStatus,
  type PaneActivity,
  type PaneStatus,
} from "./activity";

/**
 * The activity half of the fold. The inner reducer is private on purpose —
 * what ships is `reduceStatus`, and a test that reached past it would be
 * pinning a function no caller can use. These cases drive the real entry
 * point with no brackets open and read the activity back out, so they still
 * describe exactly one edge at a time.
 */
const act = (
  current: PaneActivity | null,
  // Mirrors the module's private `ActivityEdge`: the bracket kinds are the
  // ones that can make `reduceStatus` return null, which this helper cannot
  // represent — so they are refused at compile time rather than throwing.
  event: Exclude<
    AgentStatusEvent,
    | { kind: "agent-turn-start" }
    | { kind: "agent-turn-end" }
    | { kind: "agent-turns-cleared" }
  >,
): PaneActivity =>
  reduceStatus(
    current && { activity: current, openAgentTurns: new Set(), heldEnd: null },
    event,
  )!.activity;

describe("activity edges", () => {
  it("starts a working phase from nothing", () => {
    expect(act(null, { kind: "turn-start", at: 100 })).toEqual({
      state: "working",
      since: 100,
    });
  });

  it("parks on the user with the wait's reason", () => {
    const working: PaneActivity = { state: "working", since: 100 };
    expect(
      act(working, { kind: "waiting", at: 200, reason: "permission" }),
    ).toEqual({ state: "waiting", since: 200, reason: "permission" });
    expect(
      act(working, { kind: "waiting", at: 200, reason: "question" }),
    ).toEqual({ state: "waiting", since: 200, reason: "question" });
  });

  it("accepts a wait with no turn-start seen (pane adopted mid-session)", () => {
    expect(
      act(null, { kind: "waiting", at: 50, reason: "permission" }),
    ).toEqual({ state: "waiting", since: 50, reason: "permission" });
  });

  it("a resolution with no wait seen still reads as working (pane adopted mid-session)", () => {
    expect(act(null, { kind: "resumed", at: 50 })).toEqual({
      state: "working",
      since: 50,
    });
  });

  it("returns to working when the wait resolves, aging from the resolution", () => {
    const waiting: PaneActivity = {
      state: "waiting",
      since: 200,
      reason: "permission",
    };
    expect(act(waiting, { kind: "resumed", at: 300 })).toEqual({
      state: "working",
      since: 300,
    });
  });

  it("a re-asserted wait keeps its phase — same question, same age", () => {
    // claude's idle nudge repeats while the prompt sits unanswered; each
    // repeat must not reset the tooltip's "waiting for 12m" to "now", and
    // returning the SAME object is what keeps the tracker from emitting.
    const waiting: PaneActivity = {
      state: "waiting",
      since: 200,
      reason: "permission",
    };
    expect(
      act(waiting, { kind: "waiting", at: 900, reason: "permission" }),
    ).toBe(waiting);
    // A different reason is a NEW question: fresh phase, fresh identity.
    expect(
      act(waiting, { kind: "waiting", at: 900, reason: "question" }),
    ).toEqual({ state: "waiting", since: 900, reason: "question" });
  });

  it("a wait older than the running phase belongs to the turn before it", () => {
    const next: PaneActivity = { state: "working", since: 800 };
    expect(
      act(next, { kind: "waiting", at: 500, reason: "permission" }),
    ).toBe(next);
  });

  it("a wait never parks an already-ended turn", () => {
    // claude's idle nudge fires up to seconds late; delivered after the
    // Stop that ended the turn it would report a wait nothing can resolve.
    const done: PaneActivity = { state: "done", at: 400, interrupted: false };
    expect(
      act(done, { kind: "waiting", at: 500, reason: "permission" }),
    ).toBe(done);
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "rate_limit",
    };
    expect(
      act(failed, { kind: "waiting", at: 500, reason: "question" }),
    ).toBe(failed);
  });

  it("a resolution never resurrects an ended turn, and no-ops mid-turn", () => {
    // kimi's PermissionResult (or a reordered envelope) can trail the edge
    // that already closed the turn — "working" would advertise a run that
    // isn't happening.
    const done: PaneActivity = { state: "done", at: 400, interrupted: true };
    expect(act(done, { kind: "resumed", at: 500 })).toBe(done);
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "overloaded",
    };
    expect(act(failed, { kind: "resumed", at: 500 })).toBe(failed);
    // Mid-turn (claude's per-tool PostToolUse) it proves nothing new: keep
    // the phase and its identity.
    const working: PaneActivity = { state: "working", since: 100 };
    expect(act(working, { kind: "resumed", at: 500 })).toBe(working);
  });

  it("parking leaves every live phase exactly as it found it", () => {
    // A turn the CLI closed while work it started keeps running. The phase
    // did not change, so neither may the state OR its identity — a parked
    // edge that re-rendered every surface would be pure churn.
    const working: PaneActivity = { state: "working", since: 100 };
    expect(act(working, { kind: "parked", at: 500 })).toBe(working);
    // The wait STANDS. Suppressing it was tried and is worse: a permission
    // prompt means the CLI has a dialog UP that the user CAN answer, and
    // silence there strands the very work the parking protects.
    const waiting: PaneActivity = {
      state: "waiting",
      since: 200,
      reason: "permission",
    };
    expect(act(waiting, { kind: "parked", at: 500 })).toBe(waiting);
  });

  it("parking neither resurrects an ended turn nor leaves a fresh pane blank", () => {
    const done: PaneActivity = { state: "done", at: 400, interrupted: false };
    expect(act(done, { kind: "parked", at: 500 })).toBe(done);
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "rate_limit",
    };
    expect(act(failed, { kind: "parked", at: 500 })).toBe(failed);
    // Nothing known yet — attaching mid-session, or the first edge after a
    // clear. In-flight work is honestly "working".
    expect(act(null, { kind: "parked", at: 500 })).toEqual({
      state: "working",
      since: 500,
    });
  });

  it("ends a turn as completed", () => {
    const working: PaneActivity = { state: "working", since: 100 };
    expect(act(working, { kind: "turn-end", at: 400 })).toEqual({
      state: "done",
      at: 400,
      interrupted: false,
    });
  });

  it("ends an in-flight turn as interrupted", () => {
    const working: PaneActivity = { state: "working", since: 100 };
    expect(act(working, { kind: "interrupted", at: 400 })).toEqual({
      state: "done",
      at: 400,
      interrupted: true,
    });
    const waiting: PaneActivity = {
      state: "waiting",
      since: 100,
      reason: "question",
    };
    expect(act(waiting, { kind: "interrupted", at: 400 })).toEqual({
      state: "done",
      at: 400,
      interrupted: true,
    });
  });

  it("never relabels an already-ended turn as interrupted", () => {
    // The transcript tailer is a second, slower channel: its marker can
    // trail the hook edge that already settled the turn.
    const done: PaneActivity = { state: "done", at: 400, interrupted: false };
    expect(act(done, { kind: "interrupted", at: 500 })).toBe(done);
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "rate_limit",
    };
    expect(act(failed, { kind: "interrupted", at: 500 })).toBe(
      failed,
    );
  });

  it("a stale interrupt never ends the NEXT turn", () => {
    // The tail lane polls (seconds); the hook lane is near-instant. A user
    // who Escs at T and re-prompts at T+800ms has a running turn when the
    // T-stamped marker finally lands — it belongs to the PREVIOUS turn.
    const next: PaneActivity = { state: "working", since: 800 };
    expect(act(next, { kind: "interrupted", at: 500 })).toBe(next);
    const askedAgain: PaneActivity = {
      state: "waiting",
      since: 800,
      reason: "permission",
    };
    expect(act(askedAgain, { kind: "interrupted", at: 500 })).toBe(
      askedAgain,
    );
    // A marker NEWER than the phase start is this turn's own abort.
    expect(act(next, { kind: "interrupted", at: 900 })).toEqual({
      state: "done",
      at: 900,
      interrupted: true,
    });
  });

  it("an interrupt with no prior state still ends the turn", () => {
    expect(act(null, { kind: "interrupted", at: 400 })).toEqual({
      state: "done",
      at: 400,
      interrupted: true,
    });
  });

  it("turn-end and turn-failed carry the same guards as the interrupt", () => {
    // Staleness is a property of the edge STREAM, not one edge kind: a
    // codex abort marker used to reach this reducer as turn-end and end
    // the NEXT turn — the exact corruption the interrupt guard prevents.
    const next: PaneActivity = { state: "working", since: 800 };
    expect(act(next, { kind: "turn-end", at: 500 })).toBe(next);
    expect(
      act(next, { kind: "turn-failed", at: 500, error: "x" }),
    ).toBe(next);
    // And neither relabels a turn that already ended.
    const done: PaneActivity = { state: "done", at: 400, interrupted: true };
    expect(act(done, { kind: "turn-end", at: 500 })).toBe(done);
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "rate_limit",
    };
    expect(act(failed, { kind: "turn-end", at: 500 })).toBe(failed);
    expect(
      act(done, { kind: "turn-failed", at: 500, error: "x" }),
    ).toBe(done);
    // Fresh edges still land.
    expect(act(next, { kind: "turn-end", at: 900 })).toEqual({
      state: "done",
      at: 900,
      interrupted: false,
    });
  });

  it("records a failed turn with its typed reason and prose", () => {
    const working: PaneActivity = { state: "working", since: 100 };
    expect(
      act(working, {
        kind: "turn-failed",
        at: 400,
        error: "rate_limit",
        detail: "Try again at 14:32",
      }),
    ).toEqual({
      state: "failed",
      at: 400,
      error: "rate_limit",
      detail: "Try again at 14:32",
    });
    // No detail key at all when the CLI sent none — not `detail: undefined`.
    const failed = act(working, {
      kind: "turn-failed",
      at: 400,
      error: "server_error",
    });
    expect(failed).toEqual({ state: "failed", at: 400, error: "server_error" });
    expect("detail" in failed).toBe(false);
  });

  it("a new turn-start supersedes any terminal state", () => {
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "overloaded",
    };
    expect(act(failed, { kind: "turn-start", at: 500 })).toEqual({
      state: "working",
      since: 500,
    });
  });
});

describe("reduceStatus", () => {
  /** Fold a whole edge stream, the way the tracker does — from nothing. */
  const fold = (...events: AgentStatusEvent[]): PaneStatus =>
    events.reduce<PaneStatus | null>(reduceStatus, null)!;

  it("a turn that closes while an agent turn is open has not ended", () => {
    // The case the whole mechanism exists for. claude reports a teammate as
    // `running` for as long as the team is alive, idle or not, so the task
    // list in the closing payload cannot tell the two apart — the bracket
    // around the agent's own turn can.
    const held = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "mate-1" },
      { kind: "turn-end", at: 120 },
    );
    // The age is the TURN's, not the parking's: the work never stopped, so
    // "how long since you could have walked away" never reset.
    expect(held.activity).toEqual({ state: "working", since: 100 });
    expect(held.heldEnd).toBe(120);
  });

  it("the ending lands when the LAST agent turn closes", () => {
    // Without this the close of the final bracket settles nothing: the main
    // thread already sent its Stop, so no further edge is coming, and the
    // pane reports "working" forever. Stamped at the CLOSE, not at the
    // original Stop — the turn is over when the last thing running stopped.
    const state = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "mate-1" },
      { kind: "turn-end", at: 120 },
      { kind: "agent-turn-end", at: 500, id: "mate-1" },
    );
    expect(state.activity).toEqual({ state: "done", at: 500, interrupted: false });
    expect(state.heldEnd).toBeNull();
    expect(state.openAgentTurns.size).toBe(0);
  });

  it("an agent turn closing settles nothing while the main turn is open", () => {
    // No ending was held back, so the close is pure bookkeeping — inventing
    // a "done" here would end a turn the CLI is still running.
    const state = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "agent-turn-end", at: 150, id: "a" },
    );
    expect(state.activity).toEqual({ state: "working", since: 100 });
    expect(state.heldEnd).toBeNull();
  });

  it("counts the open turns, so one closing does not end it for the rest", () => {
    const state = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "agent-turn-start", at: 111, id: "b" },
      { kind: "agent-turn-end", at: 150, id: "a" },
      { kind: "turn-end", at: 160 },
    );
    expect(state.activity).toEqual({ state: "working", since: 100 });
    expect([...state.openAgentTurns]).toEqual(["b"]);
  });

  it("a wait raised or resolved mid-park does not drop the held ending", () => {
    // The agents still running are exactly what may be asking, and their
    // tool completions arrive as `resumed` throughout. If either edge reset
    // the held ending, the final close would settle nothing.
    const state = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "turn-end", at: 120 },
      { kind: "waiting", at: 130, reason: "permission" },
      { kind: "resumed", at: 140 },
      { kind: "agent-turn-end", at: 200, id: "a" },
    );
    expect(state.activity).toEqual({ state: "done", at: 200, interrupted: false });
  });

  it("`agent-turns-cleared` discards every bracket", () => {
    // An oversized close reaches the host as its event name alone, so WHICH
    // one it closed is unknowable. Ending early is repaired by the next
    // wake; brackets that never close strand the pane on "Working" with
    // nothing left to release it.
    const state = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "agent-turn-start", at: 111, id: "b" },
      { kind: "agent-turns-cleared", at: 150 },
      { kind: "turn-end", at: 160 },
    );
    expect(state.activity).toEqual({ state: "done", at: 160, interrupted: false });
    expect(state.openAgentTurns.size).toBe(0);
  });

  it("a clear that empties the set settles the ending it was holding", () => {
    const state = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "turn-end", at: 120 },
      { kind: "agent-turns-cleared", at: 400 },
    );
    expect(state.activity).toEqual({ state: "done", at: 400, interrupted: false });
  });

  it("a new turn does NOT retire the agent turns running behind it", () => {
    // A background agent outlives the turn that spawned it — that is the
    // entire premise. Clearing on turn-start would make the pane announce
    // "done" the moment the user typed anything.
    const state = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "turn-end", at: 120 },
      { kind: "turn-start", at: 130 },
      { kind: "turn-end", at: 140 },
    );
    expect(state.activity).toEqual({ state: "working", since: 130 });
    expect([...state.openAgentTurns]).toEqual(["a"]);
  });

  it("an interrupt or a failure ends the turn AND releases the brackets", () => {
    // Both need the user NOW, and surviving agents do not make a turn
    // un-interrupted or un-failed. Releasing matters more than the ending:
    // a bracket kept past the death of the turn that opened it may never be
    // closed by anything, and one such orphan rewrites every later
    // `turn-end` into a park — the pane would never say "done" again.
    for (const ending of [
      { kind: "interrupted", at: 120 } as const,
      { kind: "turn-failed", at: 120, error: "rate_limit" } as const,
    ]) {
      const state = fold(
        { kind: "turn-start", at: 100 },
        { kind: "agent-turn-start", at: 110, id: "a" },
        ending,
      );
      expect(state.openAgentTurns.size, ending.kind).toBe(0);
      expect(state.heldEnd, ending.kind).toBeNull();
      // ...and the pane can reach a real ending again afterwards.
      const later = [
        { kind: "turn-start", at: 200 } as const,
        { kind: "turn-end", at: 210 } as const,
      ].reduce<PaneStatus | null>(reduceStatus, state)!;
      expect(later.activity, ending.kind).toEqual({
        state: "done",
        at: 210,
        interrupted: false,
      });
    }
  });

  it("returns its input untouched when an edge moves nothing", () => {
    // Identity is load-bearing: the tracker skips the emit on it, so an
    // absorbed edge never re-renders or re-announces.
    const open = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
    );
    expect(
      reduceStatus(open, { kind: "agent-turn-start", at: 115, id: "a" }),
    ).toBe(open);
    expect(
      reduceStatus(open, { kind: "agent-turn-end", at: 115, id: "ghost" }),
    ).toBe(open);

    // A set emptied one close at a time is NOT the shared empty constant,
    // so a clear on top of it has to return the set it was given rather
    // than swap in the constant — otherwise every such clear allocates a
    // new state and wakes the subscribers for nothing.
    const drained = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "agent-turn-end", at: 150, id: "a" },
    );
    expect(drained.openAgentTurns.size).toBe(0);
    expect(reduceStatus(drained, { kind: "agent-turns-cleared", at: 160 })).toBe(
      drained,
    );
  });

  it("an ending absorbed as stale changes NOTHING, brackets included", () => {
    // The tailer stamps an interrupt with the marker's OWN time, so one can
    // land after a newer turn began — the activity fold already rejects
    // that. The brackets and the held ending have to be rejected WITH it:
    // releasing on an interrupt that never ended the turn leaves the pane
    // running with nothing left that could ever finish it, which is the
    // failure the whole bracket exists to prevent.
    const held = fold(
      { kind: "turn-start", at: 110 },
      { kind: "agent-turn-start", at: 112, id: "a" },
      { kind: "turn-end", at: 120 },
    );
    for (const stale of [
      { kind: "interrupted", at: 105 } as const,
      { kind: "turn-failed", at: 105, error: "rate_limit" } as const,
      { kind: "turn-end", at: 105 } as const,
    ]) {
      expect(reduceStatus(held, stale), stale.kind).toBe(held);
    }
    // ...and the real close still settles the ending that was held.
    expect(
      reduceStatus(held, { kind: "agent-turn-end", at: 300, id: "a" })?.activity,
    ).toEqual({ state: "done", at: 300, interrupted: false });
  });

  it("a stale turn-end does not arm an ending for a turn that is running", () => {
    // Whether to HOLD is decided from the same verdict as whether to end:
    // an ending belonging to a previous turn must not be parked and stored,
    // or the next bracket close replays it as a fresh "done" over a turn
    // that never closed.
    const state = fold(
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "turn-start", at: 800 },
      { kind: "turn-end", at: 500 },
    );
    expect(state.heldEnd).toBeNull();
    expect(
      reduceStatus(state, { kind: "agent-turn-end", at: 900, id: "a" })?.activity,
    ).toEqual({ state: "working", since: 800 });
  });

  it("a new turn drops the ending the old one was holding", () => {
    // Without a following `turn-end` to overwrite it: that is what would
    // mask a `heldEnd` the new turn failed to clear, and the stale value
    // would then end the NEW turn the moment a bracket closed.
    const state = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "turn-end", at: 120 },
      { kind: "turn-start", at: 130 },
      { kind: "agent-turn-end", at: 200, id: "a" },
    );
    expect(state.activity).toEqual({ state: "working", since: 130 });
    expect(state.heldEnd).toBeNull();
  });

  it("a released bracket's own close, arriving late, is inert", () => {
    // The agents outlive the interrupt that released them, so their real
    // closes DO arrive afterwards. They must not resurrect anything.
    const released = fold(
      { kind: "turn-start", at: 100 },
      { kind: "agent-turn-start", at: 110, id: "a" },
      { kind: "interrupted", at: 120 },
    );
    expect(
      reduceStatus(released, { kind: "agent-turn-end", at: 300, id: "a" }),
    ).toBe(released);
    expect(
      reduceStatus(released, { kind: "agent-turns-cleared", at: 300 }),
    ).toBe(released);
  });

  it("a pane that has reported nothing stays absent, not done", () => {
    // Attaching mid-session, or the first edge after a clear. A live agent
    // is honest evidence the session is working; a close is evidence of
    // nothing, and `null` is how the tracker spells "not tracked".
    expect(
      reduceStatus(null, { kind: "agent-turn-start", at: 300, id: "a" }),
    ).toEqual({
      activity: { state: "working", since: 300 },
      openAgentTurns: new Set(["a"]),
      heldEnd: null,
    });
    expect(
      reduceStatus(null, { kind: "agent-turn-end", at: 300, id: "a" }),
    ).toBeNull();
    expect(reduceStatus(null, { kind: "agent-turns-cleared", at: 300 })).toBeNull();
  });
});

describe("answerResolves", () => {
  it("accepts a standing wait and nothing else", () => {
    expect(answerResolves({ state: "waiting", since: 1, reason: "permission" }))
      .toBe(true);
    expect(answerResolves({ state: "waiting", since: 1, reason: "question" }))
      .toBe(true);
    expect(answerResolves({ state: "working", since: 1 })).toBe(false);
    expect(answerResolves({ state: "done", at: 1, interrupted: false })).toBe(
      false,
    );
    expect(answerResolves({ state: "failed", at: 1, error: "rate_limit" })).toBe(
      false,
    );
  });

  it("refuses a pane that has reported nothing — unlike the `resumed` edge", () => {
    // The asymmetry IS the reason this predicate exists: an agent's own
    // `resumed` starts a phase from no activity, because a completed tool
    // proves something is running. A keystroke proves only that someone is
    // at the keyboard.
    expect(answerResolves(null)).toBe(false);
    expect(reduceStatus(null, { kind: "resumed", at: 100 })).toMatchObject({
      activity: { state: "working", since: 100 },
    });
  });
});
