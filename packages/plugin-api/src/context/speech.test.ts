import { describe, expect, it } from "vitest";
import { SPEECH_ERROR_KINDS, speechErrorKind } from "./speech.ts";

describe("speechErrorKind", () => {
  it("reads every listed kind off an error's code", () => {
    for (const kind of SPEECH_ERROR_KINDS) {
      expect(speechErrorKind(Object.assign(new Error("x"), { code: kind }))).toBe(kind);
    }
  });

  it("returns null for an unknown code, no code, or a non-object", () => {
    expect(speechErrorKind(Object.assign(new Error("x"), { code: "not-a-kind" }))).toBeNull();
    expect(speechErrorKind(new Error("x"))).toBeNull();
    expect(speechErrorKind("permission")).toBeNull();
    expect(speechErrorKind(null)).toBeNull();
  });
});
