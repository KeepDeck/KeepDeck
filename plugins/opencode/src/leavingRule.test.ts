import { afterEach, describe, expect, it, vi } from "vitest";
// Resource JS — shipped to, and loaded by, the user's opencode.
import { createLeaving } from "../resources/keepdeck-plugin/leaving.js";

/**
 * What leaving a conversation does to the pane (leaving.js), on its own: the
 * generation's `interrupt` decides whether the session left is stopped, and
 * whether the pane waits for its ending before letting go. leaving.test.ts
 * runs the same over the real 1.x reporter, courier and follower.
 */
/** How long an interrupted conversation's ending is waited for — the
 * product's promise, stated here on its own. */
const LET_GO = 3_000;

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
  return { leaving, pane, published, letGo, enqueue };
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
    await vi.advanceTimersByTimeAsync(LET_GO - 1);
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

  it("lets go as one of the reporter's jobs — never ahead of one already queued", async () => {
    const { leaving, published, enqueue } = setup();
    let release!: () => void;
    const order: string[] = [];
    void enqueue(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push("reporter job");
            resolve();
          };
        }),
    );
    const left = leaving.leave("ses_a").then(() => order.push(published.join()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(published).toEqual([]);
    release();
    await left;
    expect(order).toEqual(["reporter job", "session.unbound"]);
  });

  it("catches an ending that arrives before the interrupt call even returns", async () => {
    vi.useFakeTimers();
    let leaving: ReturnType<typeof setup>["leaving"] | undefined;
    const on = setup(async (id) => {
      if (!leaving) throw new Error("leaving was not initialized");
      leaving.ended(id);
      return true;
    });
    leaving = on.leaving;
    await on.leaving.leave("ses_a");
    // Let go on the ending itself, not on the fallback: the clock never moved.
    expect(on.published).toEqual(["session.unbound"]);
  });

  it("does not let a finished leaving's fallback cut a later one short", async () => {
    vi.useFakeTimers();
    const on = setup(async () => true);
    const first = on.leaving.leave("ses_a");
    on.leaving.ended("ses_a");
    await first;
    expect(on.published).toEqual(["session.unbound"]);

    // Back in the same conversation a second later, and left again.
    await vi.advanceTimersByTimeAsync(1_000);
    on.pane.root = "ses_a";
    const second = on.leaving.leave("ses_a");
    // When the first leaving's fallback would have fired: still waiting.
    await vi.advanceTimersByTimeAsync(LET_GO - 1_000);
    expect(on.published).toEqual(["session.unbound"]);
    await vi.advanceTimersByTimeAsync(1_000);
    await second;
    expect(on.published).toEqual(["session.unbound", "session.unbound"]);
  });

  it("lets go on the fallback as one of the reporter's jobs too — never ahead of one already queued", async () => {
    vi.useFakeTimers();
    const on = setup(async () => true);
    let release!: () => void;
    void on.enqueue(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const left = on.leaving.leave("ses_a");
    await vi.advanceTimersByTimeAsync(LET_GO + 100);
    expect(on.published).toEqual([]);
    release();
    await left;
    expect(on.published).toEqual(["session.unbound"]);
  });
});
