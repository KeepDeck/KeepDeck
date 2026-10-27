import { describe, expect, it } from "vitest";
import { activityBadge } from "./activityBadge";

describe("activityBadge", () => {
  it("labels each state and ages from its own instant", () => {
    expect(activityBadge({ state: "working", since: 100 }, undefined)).toEqual({
      tone: "working",
      label: "Working",
      sentence: "working",
      at: 100,
    });
    expect(
      activityBadge({ state: "waiting", since: 200, reason: "permission" }, undefined),
    ).toEqual({
      tone: "waiting",
      label: "Needs approval",
      sentence: "needs approval",
      at: 200,
    });
    expect(
      activityBadge({ state: "waiting", since: 200, reason: "question" }, undefined),
    ).toEqual({
      tone: "waiting",
      label: "Needs your input",
      sentence: "needs your input",
      at: 200,
    });
    expect(
      activityBadge({ state: "done", at: 300, interrupted: false }, undefined),
    ).toEqual({
      tone: "done",
      label: "Done",
      sentence: "finished",
      at: 300,
    });
    expect(
      activityBadge({ state: "done", at: 300, interrupted: true }, undefined),
    ).toEqual({
      tone: "done",
      label: "Interrupted",
      sentence: "interrupted",
      at: 300,
    });
  });

  it("names the shared failure reasons for any agent and carries the prose as detail", () => {
    expect(
      activityBadge(
        {
          state: "failed",
          at: 400,
          error: "rate_limit",
          detail: "Weekly limit reached",
        },
        undefined,
      ),
    ).toEqual({
      tone: "failed",
      label: "Rate limited",
      sentence: "rate limited",
      detail: "Weekly limit reached",
      at: 400,
    });
    expect(
      activityBadge({ state: "failed", at: 400, error: "authentication_failed" }, undefined),
    ).toMatchObject({ label: "Authentication failed", tone: "failed" });
  });

  it("words an agent's own code only with that agent's labels", () => {
    const failed = { state: "failed", at: 400, error: "model_not_found" } as const;
    expect(activityBadge(failed, { model_not_found: "Model not found" })).toMatchObject({
      label: "Model not found",
      sentence: "model not found",
    });
    // Another agent sending the same code gets no borrowed diagnosis.
    expect(activityBadge(failed, undefined)).toMatchObject({ label: "Failed: model_not_found" });
    expect(activityBadge(failed, { other: "Other" })).toMatchObject({ label: "Failed: model_not_found" });
  });

  it("never lets an agent reword a shared reason", () => {
    expect(
      activityBadge({ state: "failed", at: 400, error: "rate_limit" }, { rate_limit: "Slow down" }),
    ).toMatchObject({ label: "Rate limited" });
  });

  it("keeps an unknown failure type's own casing in both label and sentence", () => {
    const badge = activityBadge({ state: "failed", at: 400, error: "QuotaCliff" }, undefined);
    expect(badge.label).toBe("Failed: QuotaCliff");
    // The sentence must never lowercase a CLI's identifier.
    expect(badge.sentence).toBe("failed: QuotaCliff");
  });
});
