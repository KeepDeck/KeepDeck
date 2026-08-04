import { describe, expect, it } from "vitest";
import { answerResolves, reduceStatus } from "./activity";

describe("answerResolves", () => {
  it("refuses a pane that has reported nothing — unlike the `resumed` edge", () => {
    // The asymmetry IS the whole reason this predicate exists. An agent's
    // own `resumed` starts a phase from no activity, because a completed
    // tool proves something is running; a keystroke proves only that
    // somebody is at the keyboard, and a pane nobody has reported on is a
    // shell, not a turn.
    expect(answerResolves(null)).toBe(false);
    expect(reduceStatus(null, { kind: "resumed", at: 100 })).toMatchObject({
      activity: { state: "working", since: 100 },
    });
  });

  it("leaves WHICH activities a resume moves to the fold", () => {
    // Every reported activity passes: the predicate answers "may this be
    // folded at all", not "what does it do". Deciding the second question
    // here too would put the fold's rule in a second place to keep in step
    // — the fold's own cases are covered in activity.test.ts.
    for (const activity of [
      { state: "waiting", since: 1, reason: "permission" },
      { state: "working", since: 1 },
      { state: "done", at: 1, interrupted: false },
      { state: "failed", at: 1, error: "rate_limit" },
    ] as const) {
      expect(answerResolves(activity), activity.state).toBe(true);
    }
  });
});
