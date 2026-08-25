import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createStartupSilenceWatch,
  SLOW_START_MS,
  type StartupSilenceWatch,
} from "./startupSilence";
import type { PaneSessionState } from "../ptyManager";
import type { StartupNote } from ".";

/** The pieces the watch is allowed to touch, all of them driven by hand: the
 * clock, the ticker, what the registry says, and what the view is told. */
function harness() {
  const notes = new Map<string, StartupNote>();
  const state = new Map<string, PaneSessionState>();
  const launched = new Set<string>();
  let now = 1_000;
  let tick: (() => void) | null = null;
  const publish = vi.fn();
  const stopTicker = vi.fn(() => {
    tick = null;
  });

  const watch: StartupSilenceWatch = createStartupSilenceWatch({
    sessions: {
      isLaunched: (paneId) => launched.has(paneId),
      state: (paneId) => state.get(paneId) ?? { kind: "none" },
    },
    view: {
      markStartup: (paneId, note) => {
        notes.set(paneId, note);
      },
      startupNote: (paneId) => notes.get(paneId) ?? null,
      clearStartup: (paneId) => notes.delete(paneId),
    },
    publish,
    now: () => now,
    startTicker: (fn) => {
      tick = fn;
      return stopTicker;
    },
  });

  return {
    watch,
    notes,
    publish,
    stopTicker,
    launched,
    /** A pane the registry says is starting — the state a wait lives in. */
    starting(paneId: string) {
      state.set(paneId, { kind: "starting" });
    },
    setState(paneId: string, next: PaneSessionState) {
      state.set(paneId, next);
    },
    advance(ms: number) {
      now += ms;
    },
    /** One turn of the watch's own ticker. */
    turn() {
      tick?.();
    },
    ticking: () => tick !== null,
  };
}

let h: ReturnType<typeof harness>;

beforeEach(() => {
  h = harness();
});

describe("startup silence watch", () => {
  it("notes the wait from the moment it is armed, before judging it slow", () => {
    h.starting("pane-1");
    h.watch.arm("pane-1");

    expect(h.notes.get("pane-1")).toEqual({ since: 1_000, slow: false });
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it("calls the wait slow once the threshold passes, keeping its start", () => {
    h.starting("pane-1");
    h.watch.arm("pane-1");

    h.advance(SLOW_START_MS - 1);
    h.turn();
    expect(h.notes.get("pane-1")?.slow).toBe(false);

    h.advance(1);
    h.turn();
    expect(h.notes.get("pane-1")).toEqual({ since: 1_000, slow: true });
  });

  it("says so only once, however long the wait goes on", () => {
    h.starting("pane-1");
    h.watch.arm("pane-1");
    h.advance(SLOW_START_MS);

    h.turn();
    const publishes = h.publish.mock.calls.length;
    h.advance(60_000);
    h.turn();
    h.turn();

    expect(h.publish.mock.calls.length).toBe(publishes);
  });

  it("forgets the wait the moment the pane paints", () => {
    h.starting("pane-1");
    h.watch.arm("pane-1");
    h.advance(SLOW_START_MS);
    h.turn();
    expect(h.notes.has("pane-1")).toBe(true);

    h.launched.add("pane-1");
    h.turn();

    expect(h.notes.has("pane-1")).toBe(false);
  });

  it.each<[string, PaneSessionState]>([
    ["exit", { kind: "exited", code: 0 }],
    ["a failed spawn", { kind: "failed", message: "no such command" }],
    ["a close", { kind: "none" }],
  ])("forgets the wait on %s", (_what, next) => {
    h.starting("pane-1");
    h.watch.arm("pane-1");
    h.advance(SLOW_START_MS);
    h.turn();

    h.setState("pane-1", next);
    h.turn();

    expect(h.notes.has("pane-1")).toBe(false);
  });

  it("stops its ticker once no pane is waiting", () => {
    h.starting("pane-1");
    h.watch.arm("pane-1");
    expect(h.ticking()).toBe(true);

    h.launched.add("pane-1");
    h.turn();

    expect(h.stopTicker).toHaveBeenCalled();
    expect(h.ticking()).toBe(false);
  });

  it("keeps the original start when a reconcile pass re-arms the same pane", () => {
    h.starting("pane-1");
    h.watch.arm("pane-1");

    h.advance(5_000);
    h.watch.arm("pane-1");
    h.advance(SLOW_START_MS - 5_000);
    h.turn();

    // Re-arming restarted nothing: the threshold is measured from the first
    // ask, so a pane cannot dodge the hint by being revisited.
    expect(h.notes.get("pane-1")).toEqual({ since: 1_000, slow: true });
  });

  it("takes back what it said when a pane is disarmed", () => {
    h.starting("pane-1");
    h.watch.arm("pane-1");
    h.advance(SLOW_START_MS);
    h.turn();

    h.watch.disarm("pane-1");

    expect(h.notes.has("pane-1")).toBe(false);
    expect(h.stopTicker).toHaveBeenCalled();
  });
});
