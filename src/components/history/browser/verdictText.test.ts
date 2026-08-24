import { describe, expect, it } from "vitest";
import type { Shortfall } from "@keepdeck/plugin-api";
import { readingVerdict, type ReadingState } from "./verdictText";

/**
 * Every sentence below is written out BY HAND, and that is the point.
 *
 * The module deliberately keeps its phrases private; a test importing them
 * would compare a constant to itself and stay green through any rewording —
 * catching a broken branch, never a broken word. Each of these lines is a
 * product decision with a rejected alternative behind it ("Partly shown" lies
 * upward when nothing is shown; "No transcript content" lies downward over ten
 * megabytes; "Read failed" belongs to a refusal before anything appeared), so
 * a mid-refactor "improvement" must redden here.
 */
const SAID = {
  partly: "Partly shown — read 8388608 of 10259690",
  turns: "40 of 52 turns",
  parts: "Conversation has 3 unreadable parts",
  ending: "Read up to here — the rest is beyond this reading",
  nothing: "Read cut short — nothing could be shown",
  stopped: "Stopped mid-read — the rest did not arrive",
  empty: "No transcript content",
};

const BYTES: Shortfall = { kind: "bytes", size: 10259690, readBytes: 8388608 };
const TURNS: Shortfall = { kind: "turns", total: 52, returned: 40 };
const PARTS: Shortfall = { kind: "parts", unreadableParts: 3 };

function state(over: Partial<ReadingState> = {}): ReadingState {
  return {
    entries: 50,
    exhausted: false,
    shortfall: undefined,
    viewerError: null,
    loading: false,
    ...over,
  };
}

describe("readingVerdict", () => {
  it("names a capped read in its own measure", () => {
    const { notices } = readingVerdict(state({ shortfall: [BYTES] }));
    expect(notices).toEqual([SAID.partly]);
  });

  it("lists two kinds as two lines rather than joining them", () => {
    // One read can fall short two ways at once, and joining the two invents a
    // third meaning belonging to neither. The reader adds them up knowing both
    // addends; a merged sentence hides one.
    const { notices } = readingVerdict(state({ shortfall: [TURNS, PARTS] }));
    expect(notices).toEqual([SAID.turns, SAID.parts]);
  });

  it("says a hole is in the conversation, not in what is shown", () => {
    // The shown text changes as the reader pages; the reading's shortfall does
    // not. A promise about the shown turns would swing under scrolling with no
    // fact having changed.
    const { notices } = readingVerdict(state({ shortfall: [PARTS] }));
    expect(notices[0]).toBe(SAID.parts);
    expect(notices[0]).not.toContain("shown");
  });

  it("closes the list only at an honest end", () => {
    const running = readingVerdict(state({ shortfall: [BYTES], exhausted: false }));
    expect(running.ending).toBeNull();

    const done = readingVerdict(state({ shortfall: [BYTES], exhausted: true }));
    expect(done.ending).toBe(SAID.ending);
  });

  it("refuses to close on a shortfall alone", () => {
    // The witness for the input that cannot be derived. A capped file carries
    // the SAME shortfall on every page — each page re-reads the whole file
    // under the same ceiling — so without `exhausted` the closing line would
    // print under the first fifty turns of every truncated session.
    const firstPage = readingVerdict(state({ shortfall: [BYTES], entries: 50 }));
    expect(firstPage.ending).toBeNull();
  });

  it("does not close on a shortfall that has no place to point at", () => {
    // A hole among the parts is somewhere in the conversation and the store
    // cannot say where; only a byte measure has an end to mark.
    const { ending } = readingVerdict(
      state({ shortfall: [PARTS], exhausted: true }),
    );
    expect(ending).toBeNull();
  });

  it("says the reading fell short rather than that there is nothing", () => {
    // Reachable however the bytes decoded: a capped prefix holding no complete
    // record parses to zero turns with its text intact.
    const { ending } = readingVerdict(state({ entries: 0, shortfall: [BYTES] }));
    expect(ending).toBe(SAID.nothing);
    expect(ending).not.toBe(SAID.empty);
  });

  it("lets emptiness speak only when the reading was whole", () => {
    const whole = readingVerdict(state({ entries: 0, shortfall: undefined }));
    expect(whole.ending).toBe(SAID.empty);
  });

  it("names a refusal that arrived after turns were already shown", () => {
    const { ending } = readingVerdict(
      state({ entries: 50, viewerError: "gone" }),
    );
    expect(ending).toBe(SAID.stopped);
  });

  it("leaves a refusal before anything was shown to the row's own verdict", () => {
    const { ending } = readingVerdict(state({ entries: 0, viewerError: "gone" }));
    expect(ending).toBeNull();
  });

  it("never closes and reports a refusal at once", () => {
    // "We got there and we did not" — the ending claims the reading reached
    // its end, the refusal that it broke before it.
    const { ending } = readingVerdict(
      state({ entries: 50, exhausted: true, shortfall: [BYTES], viewerError: "gone" }),
    );
    expect(ending).toBe(SAID.stopped);
    expect(ending).not.toBe(SAID.ending);
  });

  it("keeps quiet while a read is in flight", () => {
    const { ending } = readingVerdict(
      state({ entries: 0, loading: true, shortfall: [BYTES] }),
    );
    expect(ending).toBeNull();
  });
});
