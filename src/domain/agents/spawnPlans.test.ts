import { describe, expect, it } from "vitest";
import { decideRejectedResume } from "./spawnPlans";

describe("decideRejectedResume", () => {
  it("a live session keeps the binding — the pane offers a choice", () => {
    expect(decideRejectedResume("live", false)).toEqual({
      kind: "keep",
      registry: "live",
    });
    // Even after a retry happened earlier: LIVE is live, the strongest
    // answer wins whatever the history.
    expect(decideRejectedResume("live", true)).toEqual({
      kind: "keep",
      registry: "live",
    });
  });

  it("an unknown registry reads as live — erasing on unknown is the harm itself", () => {
    expect(decideRejectedResume("unknown", false)).toEqual({
      kind: "keep",
      registry: "unknown",
    });
    expect(decideRejectedResume("unknown", true)).toEqual({
      kind: "keep",
      registry: "unknown",
    });
  });

  it("absent earns ONE quiet retry — an agent that finished between the refusal and the query vanishes from the registry while the conversation stays resumable", () => {
    expect(decideRejectedResume("absent", false)).toEqual({ kind: "retry-once" });
  });

  it("absent twice, or no registry to ask, is the legacy fresh fallback", () => {
    // The registry's absence is not a CLAIM of absence: only an answer
    // may authorize the retry that precedes the wipe.
    expect(decideRejectedResume(null, false)).toEqual({ kind: "legacy-fresh" });
    expect(decideRejectedResume("absent", true)).toEqual({ kind: "legacy-fresh" });
  });
});
