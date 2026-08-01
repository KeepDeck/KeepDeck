import { describe, expect, it } from "vitest";
import { activityBadge } from "./format";

describe("activityBadge", () => {
  it("labels each state and ages from its own instant", () => {
    expect(activityBadge({ state: "working", since: 100 })).toEqual({
      tone: "working",
      label: "Working",
      at: 100,
    });
    expect(
      activityBadge({ state: "waiting", since: 200, reason: "permission" }),
    ).toEqual({ tone: "waiting", label: "Needs approval", at: 200 });
    expect(
      activityBadge({ state: "waiting", since: 200, reason: "question" }),
    ).toEqual({ tone: "waiting", label: "Needs your input", at: 200 });
    expect(
      activityBadge({ state: "done", at: 300, interrupted: false }),
    ).toEqual({ tone: "done", label: "Done", at: 300 });
    expect(
      activityBadge({ state: "done", at: 300, interrupted: true }),
    ).toEqual({ tone: "done", label: "Interrupted", at: 300 });
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
      detail: "Weekly limit reached",
      at: 400,
    });
    expect(
      activityBadge({ state: "failed", at: 400, error: "authentication_failed" }),
    ).toEqual({ tone: "failed", label: "Authentication failed", at: 400 });
  });

  it("shows an unknown failure type raw rather than hiding it", () => {
    expect(
      activityBadge({ state: "failed", at: 400, error: "QuotaCliff" }),
    ).toEqual({ tone: "failed", label: "Failed: QuotaCliff", at: 400 });
  });
});
