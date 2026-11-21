// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { useHost } from "../testing/host/host";
import { startDeck, type AgentAsk, type Deck } from "../testing/host/deck";
import type { StubAgentControl } from "../testing/host/stubPlugin";

/**
 * What a pane's agent says through the deck's bridge, end to end on the app
 * itself: the stub agent's hooks post as a CLI's do, the bridge judges where
 * they come from, and the page decides what each one means for the pane —
 * the conversation it is bound to, its usage, its status.
 */
describe("a pane's reports through the bridge, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}) => (deck = await startDeck(host(), told));
  const bound = (sessionId: string, source?: string) => ({
    type: "session.bound",
    payload: { sessionId, ...(source !== undefined && { source }) },
  });
  const usage = (usedPct: number) => ({ type: "usage.report", payload: { usedPct } });
  /** The pane's usage as the page holds it. */
  const usageOf = (d: Deck, paneId: string) => d.runtime.usageManager.getSnapshot().panes.get(paneId);
  /** A stub agent added to the deck's first workspace, its process running
   * — bound to nothing yet, when its agent reports nothing at start. */
  const live = async (d: Deck, ask: Partial<AgentAsk> = {}) => {
    await d.workspaceUp();
    const paneId = await d.addAgent({ role: "lead", ...ask });
    await host().until(`${paneId} runs`, () => d.slot(paneId) === "live", 15_000);
    return paneId;
  };
  /** A restart into the pane's conversation: the one the page holds it in
   * is the one it resumes. */
  const resumedInto = async (d: Deck, wsId: string, paneId: string) => {
    expect((await d.runtime.orchestrator.restart(wsId, paneId, "resume")).kind).toBe("accepted");
    await host().until("a new process", () => d.launches(paneId).length === 2 && d.slot(paneId) === "live", 15_000);
    const args = d.launches(paneId)[1]?.args ?? [];
    return args[args.indexOf("--resume") + 1];
  };

  describe("a binding", () => {
    it("binds the pane to the conversation its agent swapped to, its usage started over", async () => {
      const d = await open();
      const { ws, paneId, session } = await d.agentUp();
      expect(await d.report(paneId, usage(40))).toBe(204);
      expect(usageOf(d, paneId)?.context?.usedPct).toBe(40);
      // The person cleared the conversation: the CLI's word for one that
      // continues the pane's, in a new session.
      expect(await d.report(paneId, bound("s-cleared", "clear"))).toBe(204);
      expect(d.pane(paneId).session?.id).toBe("s-cleared");
      expect(usageOf(d, paneId)).toBeUndefined();
      expect(await resumedInto(d, ws.id, paneId)).toBe("s-cleared");
      expect(session).not.toBe("s-cleared");
    });

    it("re-reports the same conversation with the stamp it was first bound at, its usage kept", async () => {
      const d = await open();
      const { paneId, session } = await d.agentUp();
      const first = d.pane(paneId).session?.boundAt;
      await d.report(paneId, usage(40));
      await new Promise((resolve) => setTimeout(resolve, 20));
      // A resume, a /clear, a compaction say the session again: nothing
      // about the binding changed — so nothing is written of it again.
      const mark = host().tape.length;
      expect(await d.report(paneId, bound(session, "resume"))).toBe(204);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(d.pane(paneId).session).toEqual({ id: session, boundAt: first });
      expect(usageOf(d, paneId)?.context?.usedPct).toBe(40);
      expect(host().tape.slice(mark).filter(({ way, line }) => way === "page →" && line.includes('"cmd":"journal_append"'))).toEqual([]);
    });

    it("keeps the usage reported before the pane's first binding", async () => {
      const d = await open({ unbound: true });
      const paneId = await live(d);
      // Usage that names no conversation: a binding that started the pane
      // over would drop it.
      expect(await d.report(paneId, usage(40))).toBe(204);
      expect(await d.report(paneId, bound("s-1"))).toBe(204);
      expect(d.pane(paneId).session?.id).toBe("s-1");
      expect(usageOf(d, paneId)?.context?.usedPct).toBe(40);
    });

    it("refuses a second fresh conversation in one process: the pane's resume stays on its own", async () => {
      const d = await open();
      const { ws, paneId, session } = await d.agentUp();
      // A session of the same agent starting up under the pane's secret,
      // while the pane's own is bound: not a conversation the person had.
      expect(await d.report(paneId, bound("s-teammate"))).toBe(204);
      expect(d.pane(paneId).session?.id).toBe(session);
      expect(await resumedInto(d, ws.id, paneId)).toBe(session);
    });

    it("follows the conversation into the process its agent re-hosts it in, which speaks for the pane from then on", async () => {
      const d = await open();
      const { paneId } = await d.agentUp();
      // At a full context window the agent forks the conversation into a
      // process of its own: the binding, and every later report, come from
      // there.
      expect(await d.report(paneId, bound("s-forked", "fork"), "child")).toBe(204);
      expect(d.pane(paneId).session?.id).toBe("s-forked");
      expect(await d.report(paneId, usage(30), "child")).toBe(204);
      expect(usageOf(d, paneId)?.context?.usedPct).toBe(30);
      // The process it left speaks for the pane no longer.
      expect(await d.report(paneId, usage(90))).toBe(204);
      expect(usageOf(d, paneId)?.context?.usedPct).toBe(30);
    });

    it("refuses another agent's conversation, even as the pane's very first report", async () => {
      const d = await open({ unbound: true });
      const paneId = await live(d);
      // Another CLI run from a tool call inside the pane: its reporter
      // holds the pane's secret, and nothing is bound yet to tell it apart.
      expect(await d.report(paneId, { type: "session.bound", payload: { sessionId: "k-1", agent: "kimi" } }, "child")).toBe(204);
      expect(d.pane(paneId).session).toBeUndefined();
      // It claimed nothing: the pane's own conversation still binds.
      expect(await d.report(paneId, bound("s-1"))).toBe(204);
      expect(d.pane(paneId).session?.id).toBe("s-1");
    });

    it("binds no conversation for an agent on another machine: its thin client's report names no local session", async () => {
      const d = await open();
      const paneId = await live(d, { endpoint: "ws://vps:4500" });
      // The thin client runs here and reports at start, as the agent's
      // hooks do — a restore must not resume it locally.
      await host().until("its binding was heard", () => d.output(paneId).includes("stub: posted session.bound 204"));
      expect(d.pane(paneId).location).toEqual({ kind: "remote", endpoint: "ws://vps:4500" });
      expect(d.pane(paneId).session).toBeUndefined();
    });
  });

  describe("an unbinding", () => {
    const unbound = { type: "session.unbound" };

    it("forgets the pane's conversation when its own agent leaves it, and its usage with it", async () => {
      const d = await open();
      const { ws, paneId } = await d.agentUp();
      await d.report(paneId, usage(40));
      // The person pressed /new and has sent nothing yet: the pane comes
      // back to the empty screen they left, not the conversation before.
      expect(await d.report(paneId, unbound)).toBe(204);
      expect(d.pane(paneId).session).toBeUndefined();
      expect(usageOf(d, paneId)).toBeUndefined();
      expect((await d.runtime.orchestrator.restart(ws.id, paneId, "resume")).kind).toBe("accepted");
      await host().until("a new process", () => d.launches(paneId).length === 2 && d.slot(paneId) === "live", 15_000);
      expect(d.launches(paneId)[1]?.args).not.toContain("--resume");
    });

    it("hears it only from the pane's own agent: a wrong secret, another process, another agent change nothing", async () => {
      const d = await open();
      const { paneId, session } = await d.agentUp();
      await d.report(paneId, usage(40));
      expect(await d.report(paneId, { ...unbound, token: "stolen" })).toBe(204);
      // A process of the pane's terminal its reports are not pinned to.
      expect(await d.report(paneId, unbound, "child")).toBe(204);
      expect(await d.report(paneId, { ...unbound, payload: { agent: "kimi" } })).toBe(204);
      expect(d.pane(paneId).session?.id).toBe(session);
      expect(usageOf(d, paneId)?.context?.usedPct).toBe(40);
    });

    it("has nothing to forget for a pane bound to nothing, or one on another machine: their usage stays", async () => {
      const d = await open({ unbound: true });
      const local = await live(d);
      const remote = await live(d, { role: "impl-1", endpoint: "ws://vps:4500" });
      for (const paneId of [local, remote]) {
        await d.report(paneId, usage(40));
        expect(await d.report(paneId, unbound)).toBe(204);
        expect(usageOf(d, paneId)?.context?.usedPct).toBe(40);
      }
    });
  });
});
