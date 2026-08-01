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
