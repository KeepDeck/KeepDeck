// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHost } from "../testing/host/host";
import { startDeck, type AgentAsk, type Deck } from "../testing/host/deck";
import type { StubAgentControl } from "../testing/host/stubPlugin";
import { present } from "@keepdeck/plugin-api/testing";

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
      // Refused at the door: not the secret of the terminal it runs in.
      expect(await d.report(paneId, { ...unbound, token: "stolen" })).toBe(403);
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

  describe("a report", () => {
    const status = (event: string) => ({ type: "agent.status", payload: { event } });
    const activityOf = (d: Deck, paneId: string) => d.runtime.statusTracker.getSnapshot().panes.get(paneId)?.state;
    /** An agent up, and at its prompt as it said it was coming up. */
    const ready = async (d: Deck) => {
      const up = await d.agentUp();
      await host().until("it said it is ready", () => activityOf(d, up.paneId) === "ready");
      return up;
    };

    it("applies what the pane's own agent reports: its status, its usage", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      expect(await d.report(paneId, status("turn-start"))).toBe(204);
      expect(activityOf(d, paneId)).toBe("working");
      expect(await d.report(paneId, usage(40))).toBe(204);
      expect(usageOf(d, paneId)?.context?.usedPct).toBe(40);
    });

    it("refuses at the door a report under a secret that is not the pane's bridge secret — the pane's MCP secret too", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      expect(await d.report(paneId, { ...status("turn-start"), token: "stolen" })).toBe(403);
      expect(await d.report(paneId, { ...usage(40), token: "stolen" })).toBe(403);
      // The MCP secret stands in an argv some agents are given: it opens the
      // MCP door, never the bridge.
      const mcp = present(d.plan(paneId)?.mcpToken, "the pane's MCP secret");
      expect(await d.report(paneId, { ...usage(40), token: mcp })).toBe(403);
      expect(activityOf(d, paneId)).toBe("ready");
      expect(usageOf(d, paneId)).toBeUndefined();
    });

    it("takes a report from a hook its agent ran detached, a session out, naming the agent", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      expect(await d.report(paneId, status("turn-start"), "hook")).toBe(204);
      expect(activityOf(d, paneId)).toBe("working");
      expect(await d.report(paneId, usage(40), "hook")).toBe(204);
      expect(usageOf(d, paneId)?.context?.usedPct).toBe(40);
    });

    it("refuses at the door a sender standing where a hook does that names itself, as a daemon's worker does", async () => {
      // A worker of a daemon some pane's agent started inherits the pane's
      // secret and stands one session out like a hook; the process it names
      // is no process of the pane's terminal.
      const d = await open();
      const { paneId } = await ready(d);
      expect(await d.report(paneId, status("turn-start"), "worker")).toBe(403);
      expect(await d.report(paneId, usage(40), "worker")).toBe(403);
      expect(activityOf(d, paneId)).toBe("ready");
      expect(usageOf(d, paneId)).toBeUndefined();
    });

    it("refuses at the door a sender outside every pane's terminal, whatever secret it holds", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      expect(await d.report(paneId, status("turn-start"), "outside")).toBe(403);
      expect(await d.report(paneId, usage(40), "outside")).toBe(403);
      expect(activityOf(d, paneId)).toBe("ready");
      expect(usageOf(d, paneId)).toBeUndefined();
    });

    it("refuses at the door every report for a pane the deck no longer holds", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      await d.closeAgent(paneId);
      await host().until("its process is gone", () => d.slot(paneId) === "none");
      // A hook that outlived its agent, under the pane's old secret.
      expect(await d.report(paneId, usage(40), "outside")).toBe(403);
      expect(usageOf(d, paneId)).toBeUndefined();
    });

    it("drops what its agent says once the deck retired the pane's plan, while its process waits to be stopped", async () => {
      const d = await open();
      const { ws, paneId } = await ready(d);
      // The machine retires the plan, then stops the process once that is
      // answered: the answer held, the process lives on, its terminal and
      // secret still open the door — and the page has no launch left that
      // it speaks for.
      const answering = host().hold({ request: "lifecycle_applied" });
      const restarting = d.runtime.orchestrator.restart(ws.id, paneId, "resume");
      await answering.caught;
      expect(d.holdsPlan(paneId)).toBe(false);
      const before = activityOf(d, paneId);
      expect(await d.report(paneId, usage(40))).toBe(204);
      expect(await d.report(paneId, status("turn-start"))).toBe(204);
      expect(usageOf(d, paneId)).toBeUndefined();
      expect(activityOf(d, paneId)).toBe(before);
      answering.release();
      expect((await restarting).kind).toBe("accepted");
    });

    it("refuses at the door anything about a process that is gone: no terminal is left to place a sender in", async () => {
      const d = await open();
      const { paneId, session } = await ready(d);
      d.type(paneId, "exit 1");
      await host().until("its agent ended", () => d.slot(paneId) === "exited");
      const before = activityOf(d, paneId);
      // A hook outliving its agent: its status, its leaving the
      // conversation, its usage alike.
      expect(await d.report(paneId, status("turn-start"), "outside")).toBe(403);
      expect(activityOf(d, paneId)).toBe(before);
      expect(await d.report(paneId, { type: "session.unbound" }, "outside")).toBe(403);
      expect(d.pane(paneId).session?.id).toBe(session);
      expect(await d.report(paneId, usage(70), "outside")).toBe(403);
      expect(usageOf(d, paneId)).toBeUndefined();
    });

    it("takes a status from a process still starting: its hook can beat the spawn's answer", async () => {
      const d = await open();
      await d.workspaceUp();
      const spawned = host().hold({ reply: "pty_open" });
      const paneId = await d.addAgent({ role: "lead" });
      await spawned.caught;
      await host().until("it said it is ready", () => d.output(paneId).includes("stub: posted agent.status 204 start"));
      expect(d.slot(paneId)).toBe("starting");
      expect(activityOf(d, paneId)).toBe("ready");
      spawned.release();
    });

    it("is refused at the bridge when it names no agent", async () => {
      const d = await open();
      const { paneId } = await ready(d);
      expect(await d.report(paneId, { ...usage(40), payload: { usedPct: 40, agent: "" } })).toBe(400);
      expect(usageOf(d, paneId)).toBeUndefined();
    });
  });

  describe("the page going", () => {
    /** The events the page listened to since `mark` and has not let go of. */
    const stillHeard = (mark: number): string[] => {
      const held = new Map<number, string>();
      for (const { way, line } of host().tape.slice(mark)) {
        if (way !== "page →" || !line.startsWith('{"cmd":"plugin:event|')) continue;
        const said: unknown = JSON.parse(line);
        const cmd = typeof said === "object" && said !== null ? Reflect.get(said, "cmd") : null;
        const args = typeof said === "object" && said !== null ? Reflect.get(said, "args") : null;
        if (typeof args !== "object" || args === null) continue;
        if (cmd === "plugin:event|listen") held.set(Number(Reflect.get(args, "handler")), String(Reflect.get(args, "event")));
        if (cmd === "plugin:event|unlisten") held.delete(Number(Reflect.get(args, "eventId")));
      }
      return [...held.values()];
    };
    const aWhile = () => new Promise((resolve) => setTimeout(resolve, 300));

    it("lets go of every event it listened to", async () => {
      const mark = host().tape.length;
      const d = await open();
      await d.agentUp();
      d.dispose();
      deck = null;
      await aWhile();
      expect(stillHeard(mark)).toEqual([]);
    });

    it("lets go of them even when it goes before its listens were answered", async () => {
      const mark = host().tape.length;
      vi.resetModules();
      const { createAppRuntime } = await import("./runtime");
      const { createCommandRegistry } = await import("../domain/commands/registry");
      const runtime = createAppRuntime(undefined, createCommandRegistry(), () => Promise.resolve([]));
      runtime.start();
      runtime.dispose();
      await aWhile();
      expect(host().tape.slice(mark).some(({ line }) => line.startsWith('{"cmd":"plugin:event|listen"'))).toBe(true);
      expect(stillHeard(mark)).toEqual([]);
    });
  });
});
