import { describe, expect, it } from "vitest";
import { createAgentBins } from "./agentBins";

const never = () => Promise.reject(new Error("must not be called"));

/**
 * The cache behind the activation gate, and the reason detection and version
 * probing are two questions rather than one call.
 *
 * Presence is a PATH lookup asked of everything at boot; a version RUNS the
 * CLI — about half a second — and is read by exactly one thing, while
 * rendering teammate mail. Folding them together made every boot pay for a
 * fact most users never read.
 */
describe("createAgentBins", () => {
  it("records presence, and asks nothing about versions", async () => {
    const bins = createAgentBins(
      async (asked) => asked.map((bin) => ({ bin, installed: bin !== "gone" })),
      never,
    );
    await bins.detect(["claude", "gone"]);

    expect(bins.installed("claude")).toBe(true);
    expect(bins.installed("gone")).toBe(false);
    // Unknown reads as installed: a detection that never ran must not gate.
    expect(bins.installed("never-asked")).toBe(true);
    // And no version came along for the ride — that call never happened.
    expect(bins.version("claude")).toBeNull();
  });

  it("asks for a version once, however many times it is told to", async () => {
    let asks = 0;
    const bins = createAgentBins(async () => [], async () => {
      asks += 1;
      return "0.147.0";
    });

    await bins.ensureVersion("codex");
    await bins.ensureVersion("codex");
    expect(asks).toBe(1);
    expect(bins.version("codex")).toBe("0.147.0");
  });

  it("makes one request when two panes start at once", async () => {
    // Single-flight, not merely cached: two panes coming up together would
    // otherwise both find the cache empty and both spawn the CLI.
    let asks = 0;
    let release: (answer: string) => void = () => {};
    const bins = createAgentBins(async () => [], () => {
      asks += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });

    const first = bins.ensureVersion("codex");
    const second = bins.ensureVersion("codex");
    expect(asks).toBe(1);
    release("0.147.0");
    await Promise.all([first, second]);
    expect(bins.version("codex")).toBe("0.147.0");
  });

  it("forgets a version when the bin is detected again", async () => {
    // Re-detection is the app asking what is on this machine NOW — a Rescan,
    // or an enable gesture — which is exactly when a CLI may have been
    // upgraded under it. Keeping the answer made the cache write-once for
    // the life of the process: upgrade codex 0.146 → 0.147, hit Rescan, and
    // mail goes on being rendered in a schema the binary no longer speaks.
    let answer = "0.146.0";
    const bins = createAgentBins(
      async (asked) => asked.map((bin) => ({ bin, installed: true })),
      async () => answer,
    );
    await bins.detect(["codex"]);
    await bins.ensureVersion("codex");
    expect(bins.version("codex")).toBe("0.146.0");

    answer = "0.147.0";
    await bins.detect(["codex"]);
    // Forgotten, so it is unknown until somebody asks again — and unknown
    // is the safe direction: every reader takes null as "current schema".
    expect(bins.version("codex")).toBeNull();
    await bins.ensureVersion("codex");
    expect(bins.version("codex")).toBe("0.147.0");
  });

  it("throws away an answer that arrives from before a re-detection", async () => {
    // A probe takes about half a second; a re-detection takes milliseconds,
    // so a Rescan lands in the middle of one routinely. Its answer then
    // describes a machine the app has already stopped believing in — and
    // writing it back would restore exactly the staleness the re-detection
    // was for, permanently, because nothing would clear it again.
    let release: (answer: string) => void = () => {};
    const bins = createAgentBins(
      async (asked) => asked.map((bin) => ({ bin, installed: true })),
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const inFlight = bins.ensureVersion("codex");
    await bins.detect(["codex"]); // the user upgraded and hit Rescan
    release("0.146.0"); // the pre-Rescan probe finally answers
    await inFlight;

    expect(bins.version("codex")).toBeNull();
  });

  it("does not let a later caller join a flight the re-detection discarded", async () => {
    // Waiting on that flight would come away believing the answer had been
    // refreshed, when it is the one being thrown out.
    const answers: ((version: string) => void)[] = [];
    const bins = createAgentBins(
      async (asked) => asked.map((bin) => ({ bin, installed: true })),
      () => new Promise<string>((resolve) => answers.push(resolve)),
    );

    // Still in flight when the re-detection lands.
    const discarded = bins.ensureVersion("codex");
    await bins.detect(["codex"]);
    const fresh = bins.ensureVersion("codex");
    expect(answers).toHaveLength(2);

    // Both settle; only the one started after the re-detection is believed.
    answers[0]("0.146.0");
    answers[1]("0.147.0");
    await Promise.all([discarded, fresh]);
    expect(bins.version("codex")).toBe("0.147.0");
  });

  it("remembers that it could not tell, rather than asking again forever", async () => {
    // A CLI that answers nothing legible costs the same half second as one
    // that does. Re-asking on every pane start would spend it repeatedly to
    // learn the same nothing — and null already means "assume the current
    // schema" to every reader.
    let asks = 0;
    const bins = createAgentBins(async () => [], async () => {
      asks += 1;
      return null;
    });

    await bins.ensureVersion("mystery");
    await bins.ensureVersion("mystery");
    expect(asks).toBe(1);
    expect(bins.version("mystery")).toBeNull();
  });
});
