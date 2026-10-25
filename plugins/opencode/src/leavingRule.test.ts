import { afterEach, describe, expect, it, vi } from "vitest";
// Untyped resource JS — shipped to, and loaded by, the user's opencode.
// @ts-expect-error untyped resource module
import { LET_GO_MS, createLeaving } from "../resources/keepdeck-plugin/leaving.js";

/**
 * What leaving a conversation does to the pane (leaving.js), on its own: the
 * generation's `interrupt` decides whether the session left is stopped, and
 * whether the pane waits for its ending before letting go. leaving.test.ts
 * runs the same over the real 1.x reporter, courier and follower.
 */
const setup = (interrupt?: (id: string) => Promise<unknown>) => {
  const published: string[] = [];
  const letGo = vi.fn();
  const pane = {
    root: "ses_a" as string | undefined,
    detach() {
      if (this.root === undefined) return false;
      this.root = undefined;
      return true;
    },
  };
  let queue = Promise.resolve();
  const enqueue = (job: () => Promise<void>) => {
    queue = queue.then(job).catch(() => {});
    return queue;
  };
  const leaving = createLeaving({
    pane,
    publish: (type: string) => published.push(type),
    enqueue,
    interrupt,
    onLetGo: letGo,
  });
  return { leaving, pane, published, letGo };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("leaving a conversation", () => {
  it("with nothing to interrupt (opencode 2.x tabs), lets go at once and stops nothing", async () => {
    vi.useFakeTimers();
    const { leaving, pane, published, letGo } = setup();
    await leaving.leave("ses_a");
    expect(published).toEqual(["session.unbound"]);
    expect(pane.root).toBeUndefined();
    expect(letGo).toHaveBeenCalledOnce();
    // Let go without the clock moving at all, and nothing left armed.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("for another conversation, only interrupts — the move rebinds the pane", async () => {
    const interrupt = vi.fn(async () => true);
    const { leaving, pane, published } = setup(interrupt);
    await leaving.leave("ses_a", { replaced: true });
    expect(interrupt).toHaveBeenCalledWith("ses_a");
    expect(published).toEqual([]);
    expect(pane.root).toBe("ses_a");

    const soft = setup();
    await soft.leaving.leave("ses_a", { replaced: true });
    expect(soft.published).toEqual([]);
    expect(soft.pane.root).toBe("ses_a");
  });

  it("interrupted, lets go when the ending reaches the deck — not before", async () => {
    const { leaving, published } = setup(async () => true);
    let done = false;
    const left = leaving.leave("ses_a").then(() => {
      done = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    expect(published).toEqual([]);
    leaving.ended("ses_b"); // somebody else's ending changes nothing
    expect(published).toEqual([]);
    leaving.ended("ses_a");
    await left;
    expect(published).toEqual(["session.unbound"]);
  });

  it("interrupted with no ending — or an interrupt that throws — lets go after the fallback", async () => {
    vi.useFakeTimers();
    const { leaving, published } = setup(async () => {
      throw new Error("gone");
    });
    const left = leaving.leave("ses_a");
    await vi.advanceTimersByTimeAsync(LET_GO_MS - 1);
    expect(published).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await left;
    expect(published).toEqual(["session.unbound"]);
  });

  it("does not unbind a pane that moved on meanwhile", async () => {
    const { leaving, pane, published, letGo } = setup(async () => true);
    const left = leaving.leave("ses_a");
    pane.root = "ses_c";
    leaving.ended("ses_a");
    await left;
    expect(published).toEqual([]);
    expect(letGo).not.toHaveBeenCalled();
    expect(pane.root).toBe("ses_c");
  });
});
