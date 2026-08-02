import { describe, expect, it } from "vitest";
import { activityBadge } from "./format";

describe("activityBadge", () => {
  it("labels each state and ages from its own instant", () => {
    expect(activityBadge({ state: "working", since: 100 })).toEqual({
      tone: "working",
      label: "Working",
      sentence: "working",
      at: 100,
    });
    expect(
      activityBadge({ state: "waiting", since: 200, reason: "permission" }),
    ).toEqual({
      tone: "waiting",
      label: "Needs approval",
      sentence: "needs approval",
      at: 200,
    });
    expect(
      activityBadge({ state: "waiting", since: 200, reason: "question" }),
    ).toEqual({
      tone: "waiting",
      label: "Needs your input",
      sentence: "needs your input",
      at: 200,
    });
    expect(
      activityBadge({ state: "done", at: 300, interrupted: false }),
    ).toEqual({
      tone: "done",
      label: "Done",
      sentence: "finished",
      at: 300,
    });
    expect(
      activityBadge({ state: "done", at: 300, interrupted: true }),
    ).toEqual({
      tone: "done",
      label: "Interrupted",
      sentence: "interrupted",
      at: 300,
    });
  });

  it("names the typed failure reasons and carries the prose as detail", () => {
    expect(
      activityBadge({
        state: "failed",
        at: 400,
        error: "rate_limit",
        detail: "Weekly limit reached",
      }),
    ).toEqual({
      tone: "failed",
      label: "Rate limited",
      sentence: "rate limited",
      detail: "Weekly limit reached",
      at: 400,
    });
    expect(
      activityBadge({ state: "failed", at: 400, error: "authentication_failed" }),
    ).toMatchObject({ label: "Authentication failed", tone: "failed" });
  });

  it("keeps an unknown failure type's own casing in both label and sentence", () => {
    const badge = activityBadge({ state: "failed", at: 400, error: "QuotaCliff" });
    expect(badge.label).toBe("Failed: QuotaCliff");
    // The sentence must never lowercase a CLI's identifier.
    expect(badge.sentence).toBe("failed: QuotaCliff");
  });
});
