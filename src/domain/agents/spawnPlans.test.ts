import { describe, expect, it } from "vitest";
import { decideRejectedResume, takesOverRejectedResume, type LiveRegistryAnswer } from "./spawnPlans";

const ANSWERS: (LiveRegistryAnswer | null)[] = ["live", "unknown", "absent", null];

describe("decideRejectedResume — a boot restore", () => {
  it("a live session keeps the binding — the pane offers a choice", () => {
    expect(decideRejectedResume("restore", "live", false)).toEqual({
      kind: "keep",
      registry: "live",
    });
    // Even after a retry happened earlier: LIVE is live, the strongest
    // answer wins whatever the history.
    expect(decideRejectedResume("restore", "live", true)).toEqual({
      kind: "keep",
      registry: "live",
    });
  });

  it("an unknown registry reads as live — erasing on unknown is the harm itself", () => {
    expect(decideRejectedResume("restore", "unknown", false)).toEqual({
      kind: "keep",
      registry: "unknown",
    });
    expect(decideRejectedResume("restore", "unknown", true)).toEqual({
      kind: "keep",
      registry: "unknown",
    });
  });

  it("absent earns ONE quiet retry — an agent that finished between the refusal and the query vanishes from the registry while the conversation stays resumable", () => {
    expect(decideRejectedResume("restore", "absent", false)).toEqual({ kind: "retry-once" });
  });

  it("no registry to ask earns the same retry: one transient refusal never costs a conversation", () => {
    expect(decideRejectedResume("restore", null, false)).toEqual({ kind: "retry-once" });
  });

  it("is the legacy fresh fallback only once the retry was refused too", () => {
    expect(decideRejectedResume("restore", "absent", true)).toEqual({ kind: "legacy-fresh" });
    expect(decideRejectedResume("restore", null, true)).toEqual({ kind: "legacy-fresh" });
  });
});

describe("decideRejectedResume — a resume the person asked for", () => {
  it("is retried once on its own conversation, whatever the registry says", () => {
    for (const answer of ANSWERS) {
      expect(decideRejectedResume("manual", answer, false)).toEqual({ kind: "retry-once" });
    }
  });

  it("is left down once its retry was refused too — never a fresh conversation", () => {
    for (const answer of ANSWERS) {
      expect(decideRejectedResume("manual", answer, true)).toEqual({ kind: "leave" });
    }
  });
});

describe("takesOverRejectedResume — what no registry answer changes", () => {
  it("takes a boot restore over every time, and a person's resume for its one retry only", () => {
    expect(takesOverRejectedResume("restore", false)).toBe(true);
    expect(takesOverRejectedResume("restore", true)).toBe(true);
    expect(takesOverRejectedResume("manual", false)).toBe(true);
    expect(takesOverRejectedResume("manual", true)).toBe(false);
  });

  it("agrees with the decision: what it does not take over is exactly what the decision leaves", () => {
    for (const origin of ["restore", "manual"] as const) {
      for (const retried of [false, true]) {
        for (const answer of ANSWERS) {
          const left = decideRejectedResume(origin, answer, retried).kind === "leave";
          expect(left).toBe(!takesOverRejectedResume(origin, retried));
        }
      }
    }
  });
});
