import { beforeEach, describe, expect, it } from "vitest";
// Untyped resource JS — it is shipped to, and loaded by, the user's opencode
// process, never bundled into the plugin.
// @ts-expect-error untyped resource module
import { paneSession, resetPaneSession } from "../resources/pane-session.js";

/** A client that answers `session.get` from a parent table. */
const clientWith = (parents: Record<string, string | undefined>) => ({
  session: {
    get: async ({ path }: { path: { id: string } }) => ({
      data: { id: path.id, parentID: parents[path.id] },
    }),
  },
});

describe("the pane's session", () => {
  beforeEach(() => resetPaneSession());

  /**
   * The whole reason this exists. Both plugins used to call a FACTORY and get
   * an answer each, and the two derived the same fact from the same events by
   * different paths — one preserved a conversation's ancestry on binding, the
   * other cleared it. Two answers means mail delivered into a conversation
   * whose turns the deck is not watching.
   */
  it("is one object however many plugins ask for it", () => {
    const first = paneSession(undefined);
    const second = paneSession(clientWith({}));
    expect(second).toBe(first);

    first.newGeneration("ses_root");
    expect(second.root).toBe("ses_root");
  });

  /**
   * Whichever plugin initialises first may have no client — the reporter does
   * not treat a missing one as a reason to stay quiet — and a later, fuller
   * one has to be able to take over. A closure over the first would leave
   * this permanently unable to ask anything, answering "unknown" forever with
   * nothing to say why.
   */
  it("adopts a client that arrives after the first, emptier caller", async () => {
    const pane = paneSession(undefined);
    expect(await pane.classify("ses_child")).toBe("unknown");

    paneSession(clientWith({ ses_child: "ses_root" }));
    expect(await pane.classify("ses_child")).toBe("child");
    expect(pane.rootOf("ses_child")).toBe("ses_root");
  });

  describe("saying the same thing twice", () => {
    /**
     * opencode delivers every event to BOTH plugins, so anything either tells
     * this object it may be told twice. Assigning rather than counting, and
     * refusing a generation already current, is what makes the second telling
     * harmless — cheaper than teaching this to recognise an event it has seen.
     */
    it("refuses a generation that is already the current one", () => {
      const pane = paneSession(undefined);
      pane.newGeneration("ses_root");
      pane.note("ses_child", "ses_root");

      expect(pane.newGeneration("ses_root")).toBe(false);
      // The ancestry survived: a second telling did not wipe what the first
      // one learned.
      expect(pane.rootOf("ses_child")).toBe("ses_root");
    });

    // The turn flag that used to live here is gone with its only reader.
    // It existed so the courier could refuse the deck's doorbell while a
    // turn ran; the doorbell is answered mid-turn now, which is the whole of
    // this pane's mid-turn channel, and a flag nobody asks about is a fact
    // to keep in step for nothing.
  });

  describe("binding", () => {
    it("keeps the ancestry it was bound through", () => {
      const pane = paneSession(undefined);
      pane.note("ses_grandchild", "ses_child");
      pane.note("ses_child", "ses_root");

      pane.bindFromChain("ses_root", pane.chain("ses_grandchild"));
      expect(pane.root).toBe("ses_root");
      // Every hop, not just the leaf's own: dropping the middle links left
      // each intermediate subagent resolving to itself, failing the root
      // check its events are measured against.
      expect(pane.rootOf("ses_grandchild")).toBe("ses_root");
      expect(pane.rootOf("ses_child")).toBe("ses_root");
    });

    /**
     * Two events can both find the pane unbound and both go away to ask. The
     * slower one — an unrelated subagent, whose chain takes an extra hop —
     * would land last and rebind the pane to somebody else's conversation for
     * the life of the process. That happened.
     */
    it("lets the first answer win", () => {
      const pane = paneSession(undefined);
      expect(pane.bindFromChain("ses_first", [])).toBe(true);
      expect(pane.bindFromChain("ses_second", [])).toBe(false);
      expect(pane.root).toBe("ses_first");
    });

    it("starts a new conversation clean, keeping nothing from the last", () => {
      const pane = paneSession(undefined);
      pane.bindFromChain("ses_root", []);
      pane.note("ses_child", "ses_root");

      pane.newGeneration("ses_second");
      expect(pane.root).toBe("ses_second");
      // The old conversation's children answer about a session that ended.
      expect(pane.rootOf("ses_child")).toBe("ses_child");
    });
  });

  describe("whose event is this", () => {
    it("claims the root and refuses a subagent's", () => {
      const pane = paneSession(undefined);
      pane.newGeneration("ses_root");
      pane.note("ses_child", "ses_root");

      expect(pane.concernsPane("ses_root")).toBe(true);
      expect(pane.concernsPane("ses_child")).toBe(false);
      expect(pane.concernsPane("ses_stranger")).toBe(false);
    });

    /**
     * Before a root is known the pane takes the first non-child session it
     * sees: a status edge that beats `session.created` should bind the pane
     * rather than strand it. Which is why "bound" is asked apart from "the
     * root is empty" — one object serving two plugins has to be able to say
     * which of the two it means.
     */
    it("accepts an unfamiliar session while it has no conversation yet", () => {
      const pane = paneSession(undefined);
      expect(pane.bound).toBe(false);
      expect(pane.concernsPane("ses_whoever")).toBe(true);

      pane.newGeneration("ses_root");
      expect(pane.bound).toBe(true);
      expect(pane.concernsPane("ses_whoever")).toBe(false);
    });
  });

  describe("asking the server", () => {
    it("asks once per session, however many events race on it", async () => {
      let asked = 0;
      const pane = paneSession({
        session: {
          get: async ({ path }: { path: { id: string } }) => {
            asked += 1;
            return { data: { id: path.id } };
          },
        },
      });
      await Promise.all([pane.classify("ses_a"), pane.classify("ses_a")]);
      expect(asked).toBe(1);
      // Remembered, so a later caller does not pay for it again.
      await pane.classify("ses_a");
      expect(asked).toBe(1);
    });

    /**
     * The generated client RESOLVES with `{error}` rather than throwing, so a
     * `catch` alone sees nothing. An unanswerable id is recorded NOWHERE,
     * which is what makes the next call ask again instead of inheriting a
     * guess.
     */
    it("asks again about a session it could not get an answer for", async () => {
      let asked = 0;
      const pane = paneSession({
        session: {
          get: async () => {
            asked += 1;
            return { error: { name: "UnknownError" } };
          },
        },
      });
      expect(await pane.classify("ses_a")).toBe("unknown");
      expect(await pane.classify("ses_a")).toBe("unknown");
      expect(asked).toBe(2);
    });

    it("walks a whole chain rather than stopping at the first hop", async () => {
      const pane = paneSession(
        clientWith({ ses_grandchild: "ses_child", ses_child: "ses_root" }),
      );
      expect(await pane.classify("ses_grandchild")).toBe("child");
      // Stopping early would root the pane in a leaf — the case a pane
      // resumed mid-task hits, where the whole chain arrives unseen.
      expect(pane.rootOf("ses_grandchild")).toBe("ses_root");
    });
  });
});
