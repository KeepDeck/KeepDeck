import { describe, expect, it } from "vitest";
import { speechTranscript } from "@keepdeck/plugin-api/testing";
import { CLIPPING_RATIO, HOLD_PROBLEMS, holdProblems, problemOfError, START_PROBLEMS } from "./problems";

const coded = (code: string) => Object.assign(new Error("x"), { code });

describe("problemOfError", () => {
  it("maps the kinds a user can act on", () => {
    expect(problemOfError(coded("permission"))).toBe("permission");
    expect(problemOfError(coded("no-device"))).toBe("no-device");
    expect(problemOfError(coded("device"))).toBe("device");
    expect(problemOfError(coded("unsupported-format"))).toBe("device");
    expect(problemOfError(coded("model-missing"))).toBe("model-missing");
    expect(problemOfError(coded("engine"))).toBe("engine");
  });

  it("stays quiet on what the user cannot act on", () => {
    expect(problemOfError(coded("busy"))).toBeNull();
    expect(problemOfError(coded("no-capture"))).toBeNull();
    expect(problemOfError(coded("internal"))).toBeNull();
    expect(problemOfError(new Error("plain"))).toBeNull();
  });
});

describe("holdProblems", () => {
  it("a clean hold has none", () => {
    expect(holdProblems(speechTranscript({ text: "hello" }))).toEqual([]);
  });

  it("names a silent hold's device-side reason, but not 'nobody spoke'", () => {
    expect(holdProblems(speechTranscript({ silenceReason: "no-audio" }))).toEqual(["no-audio"]);
    expect(holdProblems(speechTranscript({ silenceReason: "dead-signal" }))).toEqual(["dead-signal"]);
    expect(holdProblems(speechTranscript({ silenceReason: "no-speech" }))).toEqual([]);
  });

  it("reports a cut-off and a distorted hold together", () => {
    expect(holdProblems(speechTranscript({ text: "hi", cutShort: true, clippedRatio: 0.01 }))).toEqual([
      "cut-short",
      "clipping",
    ]);
  });

  it("clipping starts at the threshold", () => {
    expect(holdProblems(speechTranscript({ text: "hi", clippedRatio: CLIPPING_RATIO }))).toEqual(["clipping"]);
    expect(holdProblems(speechTranscript({ text: "hi", clippedRatio: CLIPPING_RATIO / 2 }))).toEqual([]);
  });

  it("every problem belongs to exactly one step's scope", () => {
    const all = [...START_PROBLEMS, ...HOLD_PROBLEMS];
    expect(new Set(all).size).toBe(all.length);
  });
});
