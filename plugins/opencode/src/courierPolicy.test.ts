import { describe, expect, it, vi } from "vitest";
// Untyped resource JS — shipped to, and loaded by, the user's opencode.
// @ts-expect-error untyped resource module
import { createCourierPolicy, visibleOn } from "../resources/keepdeck-plugin/courier-policy.js";

/**
 * Where the courier's mail may go (courier-policy.js), on its own, over a
 * fake pane, screen and generation adapter. leaving.test.ts and
 * mailCourier.test.ts run the same rules over the real 1.x courier.
 */
type Screen = { kind: string; sessionID?: string };

const paneOf = (root?: string, left?: string, parents: Record<string, string> = {}) => ({
  root,
  left,
  get bound() {
    return this.root !== undefined;
  },
  rootOf(id: string) {
    let at = id;
    while (parents[at]) at = parents[at];
    return at;
  },
  classify: async () => "root",
});

const setup = (pane: ReturnType<typeof paneOf>, first: Screen) => {
  let screen = first;
  const log: string[] = [];
  const adapter = {
    selectionOf: vi.fn(async (id: string) => ({ agent: `agent-of-${id}` })),
    createSession: vi.fn(async (): Promise<string | null> => "ses_made"),
    show: vi.fn(async (id: string) => {
      log.push(`show ${id}`);
    }),
    deliver: vi.fn(async (_answer: unknown, id: string, selection: unknown) => {
      log.push(`deliver ${id} ${JSON.stringify(selection)}`);
    }),
  };
  const ask = vi.fn(async (target: string) => {
    log.push(`ask ${target}`);
    return { prompt: "hello" };
  });
  const deliverToPane = vi.fn(async () => {
    log.push("pane");
  });
  const policy = createCourierPolicy({ pane, screen: () => screen, ask, adapter, deliverToPane });
  return {
    policy,
    adapter,
    ask,
    deliverToPane,
    log,
    show: (next: Screen) => {
      screen = next;
    },
  };
};

describe("whether the pane's conversation is on screen", () => {
  it("is when the screen shows it or one of its subagents, or when nobody watches the screen", () => {
    const pane = paneOf("ses_a", undefined, { ses_sub: "ses_a" });
    expect(visibleOn({ kind: "session", sessionID: "ses_a" }, pane)).toBe(true);
    expect(visibleOn({ kind: "session", sessionID: "ses_sub" }, pane)).toBe(true);
    // No observer for this TUI: as before there was one.
    expect(visibleOn({ kind: "unknown" }, pane)).toBe(true);
  });

  it("is not for another session, the home screen, a stalled TUI, or an unbound pane", () => {
    const pane = paneOf("ses_a");
    expect(visibleOn({ kind: "session", sessionID: "ses_b" }, pane)).toBe(false);
    expect(visibleOn({ kind: "home" }, pane)).toBe(false);
    expect(visibleOn({ kind: "stale" }, pane)).toBe(false);
    expect(visibleOn({ kind: "other" }, pane)).toBe(false);
    expect(visibleOn({ kind: "session", sessionID: "ses_a" }, paneOf(undefined))).toBe(false);
  });
});

describe("collecting", () => {
  it("delivers into the pane when its conversation is on screen, and holds when another is", async () => {
    const on = setup(paneOf("ses_a"), { kind: "session", sessionID: "ses_a" });
    await on.policy.collect();
    expect(on.deliverToPane).toHaveBeenCalledOnce();

    on.show({ kind: "session", sessionID: "ses_b" });
    await on.policy.collect({ rung: true });
    expect(on.deliverToPane).toHaveBeenCalledOnce();
    expect(on.adapter.createSession).not.toHaveBeenCalled();
  });

  it("on opencode's own start screen, reaches an unbound pane as always — and makes nothing", async () => {
    const fresh = setup(paneOf(undefined), { kind: "home" });
    await fresh.policy.collect({ rung: true });
    expect(fresh.deliverToPane).toHaveBeenCalledOnce();
    expect(fresh.adapter.createSession).not.toHaveBeenCalled();

    // Bound, on the home screen it never left (the native fork's wait): held.
    const forking = setup(paneOf("ses_a"), { kind: "home" });
    await forking.policy.collect({ rung: true });
    expect(forking.deliverToPane).not.toHaveBeenCalled();
    expect(forking.adapter.createSession).not.toHaveBeenCalled();
  });

  it("after /new, makes a session for the mail only when the deck rang", async () => {
    const left = setup(paneOf(undefined, "ses_a"), { kind: "home" });
    await left.policy.collect();
    expect(left.adapter.createSession).not.toHaveBeenCalled();
    expect(left.ask).not.toHaveBeenCalled();
    // Nor into the pane: the conversation it would land in was left.
    expect(left.deliverToPane).not.toHaveBeenCalled();
  });
});

describe("mail on the home screen after /new", () => {
  it("makes a session, shows it, and asks only once it is on screen and bound — in the left one's selection", async () => {
    const pane = paneOf(undefined, "ses_a");
    const on = setup(pane, { kind: "home" });
    on.adapter.show.mockImplementation(async (id: string) => {
      on.log.push(`show ${id}`);
      on.show({ kind: "session", sessionID: id });
      pane.root = id;
    });
    await on.policy.collect({ rung: true });
    expect(on.adapter.selectionOf).toHaveBeenCalledWith("ses_a");
    expect(on.log).toEqual(["show ses_made", "ask root", 'deliver ses_made {"agent":"agent-of-ses_a"}']);
    expect(on.policy.ours("ses_made")).toBe(true);
  });

  it("takes no mail when the TUI never shows the session made — and makes no more until the screen changes", async () => {
    vi.useFakeTimers();
    try {
      const on = setup(paneOf(undefined, "ses_a"), { kind: "home" });
      const first = on.policy.collect({ rung: true });
      await vi.advanceTimersByTimeAsync(3_100);
      await first;
      expect(on.ask).not.toHaveBeenCalled();
      await on.policy.collect({ rung: true });
      expect(on.adapter.createSession).toHaveBeenCalledOnce();

      // The screen changed, and came back: worth one more try.
      on.show({ kind: "other" });
      await on.policy.collect({ rung: true });
      on.show({ kind: "home" });
      const again = on.policy.collect({ rung: true });
      await vi.advanceTimersByTimeAsync(3_100);
      await again;
      expect(on.adapter.createSession).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops when the user starts a conversation of their own meanwhile — even one announced before the create returns", async () => {
    const on = setup(paneOf(undefined, "ses_a"), { kind: "home" });
    on.adapter.createSession.mockImplementation(async () => {
      on.policy.rootAppeared("ses_theirs");
      on.policy.rootAppeared("ses_made");
      return "ses_made";
    });
    await on.policy.collect({ rung: true });
    expect(on.adapter.show).not.toHaveBeenCalled();
    expect(on.ask).not.toHaveBeenCalled();
  });

  it("does not take its own session's announcement for the user's", async () => {
    const pane = paneOf(undefined, "ses_a");
    const on = setup(pane, { kind: "home" });
    on.adapter.createSession.mockImplementation(async () => {
      on.policy.rootAppeared("ses_made");
      return "ses_made";
    });
    on.adapter.show.mockImplementation(async (id: string) => {
      // Announced again once the create returned — still its own.
      on.policy.rootAppeared(id);
      on.show({ kind: "session", sessionID: id });
      pane.root = id;
    });
    await on.policy.collect({ rung: true });
    expect(on.ask).toHaveBeenCalledOnce();
  });

  it("makes nothing more when the create fails — and tries again on the next ring", async () => {
    const on = setup(paneOf(undefined, "ses_a"), { kind: "home" });
    on.adapter.createSession.mockResolvedValue(null);
    await on.policy.collect({ rung: true });
    expect(on.adapter.show).not.toHaveBeenCalled();
    expect(on.ask).not.toHaveBeenCalled();
    // A failed create is not a session the TUI refused to show.
    await on.policy.collect({ rung: true });
    expect(on.adapter.createSession).toHaveBeenCalledTimes(2);
  });

  it("after a create that threw, the next ring starts clean", async () => {
    const pane = paneOf(undefined, "ses_a");
    const on = setup(pane, { kind: "home" });
    on.adapter.createSession.mockRejectedValueOnce(new Error("refused"));
    await expect(on.policy.collect({ rung: true })).rejects.toThrow("refused");
    on.adapter.show.mockImplementation(async (id: string) => {
      on.show({ kind: "session", sessionID: id });
      pane.root = id;
    });
    await on.policy.collect({ rung: true });
    expect(on.ask).toHaveBeenCalledOnce();
  });

  describe("asks only for the session it made, once that one is on screen AND bound", () => {
    const waitOut = async (run: Promise<unknown>) => {
      await vi.advanceTimersByTimeAsync(3_100);
      await run;
    };

    it("not when the TUI shows another session", async () => {
      vi.useFakeTimers();
      try {
        const pane = paneOf(undefined, "ses_a");
        const on = setup(pane, { kind: "home" });
        on.adapter.show.mockImplementation(async (id: string) => {
          on.show({ kind: "session", sessionID: "ses_other" });
          pane.root = id;
        });
        await waitOut(on.policy.collect({ rung: true }));
        expect(on.ask).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("not when it is shown but the pane never bound it", async () => {
      vi.useFakeTimers();
      try {
        const on = setup(paneOf(undefined, "ses_a"), { kind: "home" });
        on.adapter.show.mockImplementation(async (id: string) => {
          on.show({ kind: "session", sessionID: id });
        });
        await waitOut(on.policy.collect({ rung: true }));
        expect(on.ask).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("not when the user started their own conversation while it was coming on screen", async () => {
      const pane = paneOf(undefined, "ses_a");
      const on = setup(pane, { kind: "home" });
      on.adapter.show.mockImplementation(async (id: string) => {
        on.policy.rootAppeared("ses_theirs");
        on.show({ kind: "session", sessionID: id });
        pane.root = id;
      });
      await on.policy.collect({ rung: true });
      expect(on.ask).not.toHaveBeenCalled();
    });
  });
});
