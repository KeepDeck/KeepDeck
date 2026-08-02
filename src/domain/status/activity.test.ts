import { describe, expect, it } from "vitest";
import { reduceActivity, type PaneActivity } from "./activity";

describe("reduceActivity", () => {
  it("starts a working phase from nothing", () => {
    expect(reduceActivity(null, { kind: "turn-start", at: 100 })).toEqual({
      state: "working",
      since: 100,
    });
  });

  it("parks on the user with the wait's reason", () => {
    const working: PaneActivity = { state: "working", since: 100 };
    expect(
      reduceActivity(working, { kind: "waiting", at: 200, reason: "permission" }),
    ).toEqual({ state: "waiting", since: 200, reason: "permission" });
    expect(
      reduceActivity(working, { kind: "waiting", at: 200, reason: "question" }),
    ).toEqual({ state: "waiting", since: 200, reason: "question" });
  });

  it("accepts a wait with no turn-start seen (pane adopted mid-session)", () => {
    expect(
      reduceActivity(null, { kind: "waiting", at: 50, reason: "permission" }),
    ).toEqual({ state: "waiting", since: 50, reason: "permission" });
  });

  it("a resolution with no wait seen still reads as working (pane adopted mid-session)", () => {
    expect(reduceActivity(null, { kind: "resumed", at: 50 })).toEqual({
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
    expect(reduceActivity(waiting, { kind: "resumed", at: 300 })).toEqual({
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
      reduceActivity(waiting, { kind: "waiting", at: 900, reason: "permission" }),
    ).toBe(waiting);
    // A different reason is a NEW question: fresh phase, fresh identity.
    expect(
      reduceActivity(waiting, { kind: "waiting", at: 900, reason: "question" }),
    ).toEqual({ state: "waiting", since: 900, reason: "question" });
  });

  it("a wait never parks an already-ended turn", () => {
    // claude's idle nudge fires up to seconds late; delivered after the
    // Stop that ended the turn it would report a wait nothing can resolve.
    const done: PaneActivity = { state: "done", at: 400, interrupted: false };
    expect(
      reduceActivity(done, { kind: "waiting", at: 500, reason: "permission" }),
    ).toBe(done);
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "rate_limit",
    };
    expect(
      reduceActivity(failed, { kind: "waiting", at: 500, reason: "question" }),
    ).toBe(failed);
  });

  it("a resolution never resurrects an ended turn, and no-ops mid-turn", () => {
    // kimi's PermissionResult (or a reordered envelope) can trail the edge
    // that already closed the turn — "working" would advertise a run that
    // isn't happening.
    const done: PaneActivity = { state: "done", at: 400, interrupted: true };
    expect(reduceActivity(done, { kind: "resumed", at: 500 })).toBe(done);
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "overloaded",
    };
    expect(reduceActivity(failed, { kind: "resumed", at: 500 })).toBe(failed);
    // Mid-turn (claude's per-tool PostToolUse) it proves nothing new: keep
    // the phase and its identity.
    const working: PaneActivity = { state: "working", since: 100 };
    expect(reduceActivity(working, { kind: "resumed", at: 500 })).toBe(working);
  });

  it("ends a turn as completed", () => {
    const working: PaneActivity = { state: "working", since: 100 };
    expect(reduceActivity(working, { kind: "turn-end", at: 400 })).toEqual({
      state: "done",
      at: 400,
      interrupted: false,
    });
  });

  it("ends an in-flight turn as interrupted", () => {
    const working: PaneActivity = { state: "working", since: 100 };
    expect(reduceActivity(working, { kind: "interrupted", at: 400 })).toEqual({
      state: "done",
      at: 400,
      interrupted: true,
    });
    const waiting: PaneActivity = {
      state: "waiting",
      since: 100,
      reason: "question",
    };
    expect(reduceActivity(waiting, { kind: "interrupted", at: 400 })).toEqual({
      state: "done",
      at: 400,
      interrupted: true,
    });
  });

  it("never relabels an already-ended turn as interrupted", () => {
    // The transcript tailer is a second, slower channel: its marker can
    // trail the hook edge that already settled the turn.
    const done: PaneActivity = { state: "done", at: 400, interrupted: false };
    expect(reduceActivity(done, { kind: "interrupted", at: 500 })).toBe(done);
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "rate_limit",
    };
    expect(reduceActivity(failed, { kind: "interrupted", at: 500 })).toBe(
      failed,
    );
  });

  it("a stale interrupt never ends the NEXT turn", () => {
    // The tail lane polls (seconds); the hook lane is near-instant. A user
    // who Escs at T and re-prompts at T+800ms has a running turn when the
    // T-stamped marker finally lands — it belongs to the PREVIOUS turn.
    const next: PaneActivity = { state: "working", since: 800 };
    expect(reduceActivity(next, { kind: "interrupted", at: 500 })).toBe(next);
    const askedAgain: PaneActivity = {
      state: "waiting",
      since: 800,
      reason: "permission",
    };
    expect(reduceActivity(askedAgain, { kind: "interrupted", at: 500 })).toBe(
      askedAgain,
    );
    // A marker NEWER than the phase start is this turn's own abort.
    expect(reduceActivity(next, { kind: "interrupted", at: 900 })).toEqual({
      state: "done",
      at: 900,
      interrupted: true,
    });
  });

  it("an interrupt with no prior state still ends the turn", () => {
    expect(reduceActivity(null, { kind: "interrupted", at: 400 })).toEqual({
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
    expect(reduceActivity(next, { kind: "turn-end", at: 500 })).toBe(next);
    expect(
      reduceActivity(next, { kind: "turn-failed", at: 500, error: "x" }),
    ).toBe(next);
    // And neither relabels a turn that already ended.
    const done: PaneActivity = { state: "done", at: 400, interrupted: true };
    expect(reduceActivity(done, { kind: "turn-end", at: 500 })).toBe(done);
    const failed: PaneActivity = {
      state: "failed",
      at: 400,
      error: "rate_limit",
    };
    expect(reduceActivity(failed, { kind: "turn-end", at: 500 })).toBe(failed);
    expect(
      reduceActivity(done, { kind: "turn-failed", at: 500, error: "x" }),
    ).toBe(done);
    // Fresh edges still land.
    expect(reduceActivity(next, { kind: "turn-end", at: 900 })).toEqual({
      state: "done",
      at: 900,
      interrupted: false,
    });
  });

  it("records a failed turn with its typed reason and prose", () => {
    const working: PaneActivity = { state: "working", since: 100 };
    expect(
      reduceActivity(working, {
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
    const failed = reduceActivity(working, {
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
    expect(reduceActivity(failed, { kind: "turn-start", at: 500 })).toEqual({
      state: "working",
      since: 500,
    });
  });
});
