import { describe, expect, it } from "vitest";
import type { PaneActivity } from "./activity";
import { activityTransition } from "./transition";

const working: PaneActivity = { state: "working", since: 1 };
const waiting: PaneActivity = { state: "waiting", since: 1, reason: "permission" };
const question: PaneActivity = { state: "waiting", since: 2, reason: "question" };
const done: PaneActivity = { state: "done", at: 2, interrupted: false };
const interrupted: PaneActivity = { state: "done", at: 2, interrupted: true };
const failed: PaneActivity = { state: "failed", at: 2, error: "rate_limit" };

describe("activityTransition", () => {
  it("a new wait announces; a changed question re-announces (replace)", () => {
    expect(activityTransition(undefined, waiting)).toBe("announce");
    expect(activityTransition(working, waiting)).toBe("announce");
    // Same-reason re-asserts never reach the table (the reducer keeps the
    // object); a waiting→waiting arrival IS a changed reason.
    expect(activityTransition(waiting, question)).toBe("announce");
  });

  it("an answered wait retracts — resumed turn or the user's own interrupt", () => {
    expect(activityTransition(waiting, working)).toBe("retract");
    expect(activityTransition(waiting, interrupted)).toBe("retract");
  });

  it("a pane leaving the store withdraws only a standing wait", () => {
    expect(activityTransition(waiting, undefined)).toBe("retract");
    // Done and failed entries are history; history may stand.
    expect(activityTransition(done, undefined)).toBe("none");
    expect(activityTransition(failed, undefined)).toBe("none");
    expect(activityTransition(working, undefined)).toBe("none");
    expect(activityTransition(undefined, undefined)).toBe("none");
  });

  it("a finish announces only for a turn that was actually running here", () => {
    expect(activityTransition(working, done)).toBe("announce");
    expect(activityTransition(waiting, done)).toBe("announce");
    expect(activityTransition(undefined, done)).toBe("none");
    expect(activityTransition(failed, done)).toBe("none");
  });

  it("an interrupt is the user's own hand — silent unless it cut a wait", () => {
    expect(activityTransition(working, interrupted)).toBe("none");
    expect(activityTransition(undefined, interrupted)).toBe("none");
  });

  it("a failure always announces", () => {
    expect(activityTransition(working, failed)).toBe("announce");
    expect(activityTransition(waiting, failed)).toBe("announce");
    expect(activityTransition(undefined, failed)).toBe("announce");
  });

  it("working from anything but a wait is quiet", () => {
    expect(activityTransition(undefined, working)).toBe("none");
    expect(activityTransition(done, working)).toBe("none");
  });
});
