import { describe, expect, it } from "vitest";
import { speechTranscript } from "@keepdeck/plugin-api/testing";
import { FRESH_MS, meterPercent, micStatus, OFFSET_WARN, QUIET_PEAK, type MicFacts } from "./micStatus";

const reading = (rms: number, extra: Partial<{ peak: number; clipped: boolean; dcOffset: number }> = {}) => ({
  rms,
  peak: 0.1,
  clipped: false,
  dcOffset: 0,
  ...extra,
});
const listening = (over: Partial<MicFacts> = {}): MicFacts => ({
  listening: true,
  device: "BY-PM700",
  reading: reading(0.1),
  readingAt: 1_000,
  lastHold: null,
  ...over,
});
const kinds = (f: MicFacts, now = 1_000) => micStatus(f, now).warnings.map((w) => w.kind);

describe("meterPercent", () => {
  it("maps −60..0 dBFS to 0..100", () => {
    expect(meterPercent(1)).toBe(100);
    expect(meterPercent(0.1)).toBe(67); // −20 dBFS
    expect(meterPercent(0.001)).toBe(0); // −60 dBFS
    expect(meterPercent(0)).toBe(0);
  });

  it("a quiet room is an empty bar, normal speech is well inside it — not pinned", () => {
    expect(meterPercent(0.0007)).toBe(0); // the measured room
    const speech = meterPercent(0.03);
    expect(speech).toBeGreaterThan(30);
    expect(speech).toBeLessThan(90);
  });
});

describe("micStatus meter", () => {
  it("is live and full-strength while readings are fresh", () => {
    const s = micStatus(listening(), 1_000 + FRESH_MS);
    expect(s.live).toBe(true);
    expect(s.meter).toBe(67);
  });

  it("falls to empty once readings stop — it never sticks", () => {
    const stale = micStatus(listening(), 1_000 + FRESH_MS + 350);
    expect(stale.live).toBe(false);
    expect(stale.meter).toBeGreaterThan(0);
    expect(stale.meter).toBeLessThan(67);
    expect(micStatus(listening(), 1_000 + 5_000).meter).toBe(0);
  });

  it("is empty and hidden when not listening", () => {
    const idle = micStatus(listening({ listening: false }), 1_000);
    expect(idle.meter).toBe(0);
    expect(idle.showMeter).toBe(false);
    expect(micStatus(listening(), 1_000).showMeter).toBe(true);
  });
});

describe("micStatus warnings", () => {
  it("asks to replug a microphone adding a constant offset", () => {
    expect(kinds(listening({ reading: reading(0.01, { dcOffset: 0.3 }) }))).toEqual(["offset"]);
    expect(kinds(listening({ reading: reading(0.01, { dcOffset: OFFSET_WARN / 2 }) }))).toEqual([]);
    expect(micStatus(listening({ reading: reading(0.01, { dcOffset: 0.3 }) }), 1_000).warnings[0].text).toContain(
      "+0.30",
    );
  });

  it("warns about distortion live, or from the last hold", () => {
    expect(kinds(listening({ reading: reading(0.5, { clipped: true }) }))).toEqual(["clipping"]);
    expect(
      kinds(listening({ listening: false, reading: null, lastHold: speechTranscript({ text: "hi", clippedRatio: 0.02 }) })),
    ).toEqual(["clipping"]);
  });

  it("says a spoken hold was too quiet, but not a silent one", () => {
    expect(kinds(listening({ reading: null, lastHold: speechTranscript({ text: "hi", peak: QUIET_PEAK / 2 }) }))).toEqual([
      "quiet",
    ]);
    expect(kinds(listening({ reading: null, lastHold: speechTranscript({ silenceReason: "no-speech", peak: 0.001 }) }))).toEqual(
      [],
    );
  });

  it("says the microphone is silent when it delivered nothing or zeros", () => {
    expect(kinds(listening({ reading: null, lastHold: speechTranscript({ silenceReason: "dead-signal" }) }))).toEqual([
      "silent",
    ]);
    expect(kinds(listening({ reading: null, lastHold: speechTranscript({ silenceReason: "no-audio" }) }))).toEqual([
      "silent",
    ]);
  });

  it("a healthy microphone has none", () => {
    expect(kinds(listening({ lastHold: speechTranscript({ text: "hi" }) }))).toEqual([]);
  });
});
