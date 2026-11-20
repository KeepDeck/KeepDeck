import { describe, expect, it, vi } from "vitest";
import { createSavedDeckReporter, SAVED_RETRY_MS } from "./savedDeck";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function rig() {
  const reported: number[] = [];
  let failNext = 0;
  let timer: { fn: () => void; ms: number } | null = null;
  const reporter = createSavedDeckReporter({
    report: async (revision) => {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("no channel");
      }
      reported.push(revision);
    },
    warn: vi.fn(),
    schedule: (fn, ms) => {
      timer = { fn, ms };
      return () => {
        timer = null;
      };
    },
  });
  return {
    reporter,
    reported,
    failNext: (n: number) => (failNext = n),
    fire: () => {
      const due = timer;
      timer = null;
      due?.fn();
    },
    timer: () => timer,
  };
}

describe("the saved deck's report to the lifecycle", () => {
  it("reports every save", async () => {
    const r = rig();
    r.reporter.saved(3);
    r.reporter.saved(5);
    await settle();
    expect(r.reported).toEqual([3, 5]);
  });

  it("says again what is on disk to a machine that started over, with nothing new saved", async () => {
    const r = rig();
    r.reporter.again();
    await settle();
    // Nothing on disk yet, nothing to say.
    expect(r.reported).toEqual([]);
    r.reporter.saved(7);
    r.reporter.again();
    await settle();
    expect(r.reported).toEqual([7, 7]);
  });

  it("sends a failed report again, and drops the retry once a newer save says more", async () => {
    const r = rig();
    r.failNext(1);
    r.reporter.saved(4);
    await settle();
    expect(r.reported).toEqual([]);
    expect(r.timer()?.ms).toBe(SAVED_RETRY_MS);
    r.fire();
    await settle();
    expect(r.reported).toEqual([4]);

    r.failNext(1);
    r.reporter.saved(5);
    r.reporter.saved(6);
    await settle();
    expect(r.timer()).toBeNull();
    expect(r.reported).toEqual([4, 6]);
  });

  it("sends nothing once disposed", async () => {
    const r = rig();
    r.failNext(1);
    r.reporter.saved(2);
    await settle();
    r.reporter.dispose();
    expect(r.timer()).toBeNull();
    r.reporter.again();
    await settle();
    expect(r.reported).toEqual([]);
  });
});
