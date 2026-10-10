import { describe, expect, it } from "vitest";
import { speechTranscript } from "@keepdeck/plugin-api/testing";
import { describeCutShort, describeSilence } from "./holdWords";

describe("describeSilence", () => {
  it("names the permission fix for a dead signal", () => {
    const line = describeSilence(speechTranscript({ silenceReason: "dead-signal", seconds: 2.4 }));
    expect(line.tone).toBe("error");
    expect(line.text).toContain("Privacy & Security");
    expect(line.text).toContain("2.4s");
  });

  it("names the device that sent nothing", () => {
    const line = describeSilence(speechTranscript({ silenceReason: "no-audio", device: "BY-PM700" }));
    expect(line).toEqual({
      tone: "error",
      text: "the microphone sent no audio (BY-PM700) — check that it is connected and not in use",
    });
  });

  it("is a quiet info line when nobody spoke", () => {
    expect(describeSilence(speechTranscript({ silenceReason: "no-speech", seconds: 0.4 }))).toEqual({
      tone: "info",
      text: "didn't catch that (0.4s)",
    });
  });
});

describe("describeCutShort", () => {
  it("says the mic stopped partway, and how much was heard", () => {
    const line = describeCutShort(speechTranscript({ text: "hello", cutShort: true, seconds: 2, device: "BY-PM700" }));
    expect(line).toEqual({
      tone: "error",
      text: "the microphone stopped partway (BY-PM700) — only the first 2.0s were heard",
    });
  });

  it("says nothing for a whole hold", () => {
    expect(describeCutShort(speechTranscript({ text: "hello" }))).toBeNull();
  });
});
