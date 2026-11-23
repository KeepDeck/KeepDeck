import { describe, expect, it } from "vitest";
import { decideRejectedResume, rejectedResumeNext } from "./spawnPlans";

describe("rejectedResumeNext — what a resume that died before its session earns", () => {
  it("a boot restore is the registry's to decide, whatever its exit and history", () => {
    for (const retried of [false, true]) {
      for (const failed of [false, true]) {
        expect(rejectedResumeNext("restore", retried, failed)).toEqual({ kind: "ask-registry" });
      }
    }
  });

  it("a resume the person asked for that failed gets one quiet retry — the registry is not asked", () => {
    expect(rejectedResumeNext("manual", false, true)).toEqual({ kind: "act", action: { kind: "retry-once" } });
  });

  it("a resume the person asked for is left down once its retry failed too — never a fresh conversation", () => {
    expect(rejectedResumeNext("manual", true, true)).toEqual({ kind: "leave" });
  });

  it("a resume the person asked for that ended cleanly was ended on purpose, and is left alone", () => {
    expect(rejectedResumeNext("manual", false, false)).toEqual({ kind: "leave" });
    expect(rejectedResumeNext("manual", true, false)).toEqual({ kind: "leave" });
  });
});

describe("decideRejectedResume — a boot restore, by the registry's answer", () => {
  it("a live session keeps the binding — the pane offers a choice", () => {
    expect(decideRejectedResume("live", false)).toEqual({ kind: "keep", registry: "live" });
    // Even after a retry happened earlier: LIVE is live, the strongest
    // answer wins whatever the history.
    expect(decideRejectedResume("live", true)).toEqual({ kind: "keep", registry: "live" });
  });

  it("an unknown registry reads as live — erasing on unknown is the harm itself", () => {
    expect(decideRejectedResume("unknown", false)).toEqual({ kind: "keep", registry: "unknown" });
    expect(decideRejectedResume("unknown", true)).toEqual({ kind: "keep", registry: "unknown" });
  });

  it("absent earns ONE quiet retry — an agent that finished between the refusal and the query vanishes from the registry while the conversation stays resumable", () => {
    expect(decideRejectedResume("absent", false)).toEqual({ kind: "retry-once" });
  });

  it("no registry to ask earns the same retry: one transient refusal never costs a conversation", () => {
    expect(decideRejectedResume(null, false)).toEqual({ kind: "retry-once" });
  });

  it("is the legacy fresh fallback only once the retry was refused too", () => {
    expect(decideRejectedResume("absent", true)).toEqual({ kind: "legacy-fresh" });
    expect(decideRejectedResume(null, true)).toEqual({ kind: "legacy-fresh" });
  });
});
