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
  it("a new wait announces; a changed question announces as its own entry", () => {
    expect(activityTransition(undefined, waiting)).toBe("announce");
    expect(activityTransition(working, waiting)).toBe("announce");
    // Same-reason re-asserts never reach the table (the reducer keeps the
    // object); a waiting→waiting arrival IS a changed reason.
    expect(activityTransition(waiting, question)).toBe("announce");
  });

  it("an answered wait announces nothing — the dated entry stands as history", () => {
    expect(activityTransition(waiting, working)).toBe("none");
    expect(activityTransition(waiting, interrupted)).toBe("none");
  });

  it("a finish announces only for a turn that was actually running here", () => {
    expect(activityTransition(working, done)).toBe("announce");
    expect(activityTransition(waiting, done)).toBe("announce");
    expect(activityTransition(undefined, done)).toBe("none");
    expect(activityTransition(failed, done)).toBe("none");
  });

  it("an interrupt is the user's own hand — always silent", () => {
    expect(activityTransition(working, interrupted)).toBe("none");
    expect(activityTransition(undefined, interrupted)).toBe("none");
    expect(activityTransition(waiting, interrupted)).toBe("none");
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
