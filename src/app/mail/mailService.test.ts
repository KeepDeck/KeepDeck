import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../domain/commands";
import type { Pane, Workspace } from "../../domain/deck";
import type { PaneActivity } from "../../domain/status";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { createMailService } from "./mailService";

const READY: PaneActivity = { state: "done", at: 1, interrupted: false };
const APPROVING: PaneActivity = { state: "waiting", since: 1, reason: "permission" };

const SENDER = {
  kind: "external" as const,
  client: "mcp",
  pane: { id: "pane-1", workspaceId: "ws-1", label: "Agent 1" },
};

function setup() {
  // pane-1 is on a team, so the standing-presence has something to re-state.
  let panes: Pane[] = [
    { id: "pane-1", team: { name: "api", role: "lead" } },
    { id: "pane-2" },
  ] as Pane[];
  const agentTypes: Record<string, string> = {
    "pane-1": "claude",
    "pane-2": "codex",
    "pane-3": "claude",
    "pane-9": "kimi",
  };
  const activity = new Map<string, PaneActivity>([
    ["pane-1", READY],
    ["pane-2", READY],
  ]);
  const paneListeners = new Set<() => void>();
  const activityListeners = new Set<() => void>();
  const woken: string[] = [];
  const replies: { paneId: string; id: string; body: string }[] = [];
  const sessionListeners = new Set<(paneId: string) => void>();
  const learned: string[] = [];
  const agentListeners = new Set<() => void>();
  const registry = createCommandRegistry();

  const workspaces = (): Workspace[] => [
    {
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "web",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes,
    } as Workspace,
  ];

  const service = createMailService(
    {
      registry,
      deck: {
        workspaces,
        subscribe: (listener) => {
          paneListeners.add(listener);
          return () => paneListeners.delete(listener);
        },
        setPaneTeam: () => {},
        agentTypeOf: (paneId: string) => agentTypes[paneId] ?? "claude",
      },
      agents: {
        labels: () => [{ id: "claude", label: "Claude" }],
        // No renderMail and no wake: this agent is a plain terminal CLI, so
        // the manager's default path is the one under test here.
        statusOf: () => undefined,
        versionOf: () => null,
        onAgentsChanged: (listener: () => void) => {
          agentListeners.add(listener);
          return () => agentListeners.delete(listener);
        },
        learnVersion: (agentId: string) => {
          learned.push(agentId);
        },
      },
      status: {
        activityOf: (paneId) => activity.get(paneId),
        subscribe: (listener) => {
          activityListeners.add(listener);
          return () => activityListeners.delete(listener);
        },
        onContextRebuilt: () => () => {},
      },
      subscribeChannels: () => () => {},
      onSessionBegan: (listener) => {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      onRoleCatalogChanged: () => () => {},
      terminal: {
        wake: (paneId: string) => {
          woken.push(paneId);
          return true;
        },
      },
      bridge: {
        reply: (paneId, id, body) => {
          replies.push({ paneId, id, body });
          return Promise.resolve(true);
        },
        nudge: () => {},
      },
    },
  );

  return {
    service,
    registry,
    woken,
    replies,
    learned,
    /** The plugin registry changed — a Rescan, an agent plugin arriving. */
    agentsChanged() {
      for (const listener of [...agentListeners]) listener();
    },
    /** A pane whose agent just opened a conversation with no memory of the
     * last — what the standing-presence listens for. */
    beginsSession(paneId: string) {
      for (const listener of [...sessionListeners]) listener(paneId);
    },
    /** What is waiting for a pane through the labelled channel — where a
     * briefing goes, since standing context never touches the terminal. */
    waitingFor: (paneId: string) =>
      (service.current()?.takeAtTurnEnd(paneId) ?? []).map((mail) => mail.kind),
    sessionListeners: () => sessionListeners.size,
    reports(paneId: string, next: PaneActivity) {
      activity.set(paneId, next);
      for (const listener of [...activityListeners]) listener();
    },
    closePanes(kept: Pane[]) {
      panes = kept;
      for (const listener of [...paneListeners]) listener();
    },
    send: (body: string) =>
      registry.execute("mail.send", { to: "pane-2", kind: "note", body }, SENDER),
  };
}

describe("createMailService", () => {
  it("registers the mail commands as soon as it exists", () => {
    // A registered command IS an MCP tool: the tools exist for exactly as
    // long as the manager behind them.
    const h = setup();
    expect(h.registry.has("mail.send")).toBe(true);
    expect(h.registry.has("mail.inbox")).toBe(true);
  });

  it("does not hand a closed pane's mail to whoever inherits its id", async () => {
    const h = setup();
    await h.send("for the old pane-2");
    // The message landed, so it sits in pane-2's inbox.
    const before = await h.registry.execute("mail.inbox", {}, {
      kind: "external",
      client: "mcp",
      pane: { id: "pane-2", workspaceId: "ws-1", label: "Agent 2" },
    });
    expect(before.ok && (before.value as { messages: unknown[] }).messages).toHaveLength(1);

    // pane-2 closes. `pane-N` is a REUSABLE slot, so the next pane can be
    // handed the same id — and must not inherit a conversation.
    h.closePanes([{ id: "pane-1" }] as Pane[]);
    const after = await h.registry.execute("mail.inbox", {}, {
      kind: "external",
      client: "mcp",
      pane: { id: "pane-2", workspaceId: "ws-1", label: "Agent 2" },
    });
    expect(after.ok && (after.value as { messages: unknown[] }).messages).toEqual([]);
  });

  it("exposes the manager from creation until dispose", () => {
    const h = setup();
    expect(h.service.current()).not.toBeNull();
    h.service.dispose();
    expect(h.service.current()).toBeNull();
  });

  it("leaves nothing registered after dispose", () => {
    const h = setup();
    expect(h.registry.has("mail.send")).toBe(true);
    h.service.dispose();
    expect(h.registry.has("mail.send")).toBe(false);
    expect(h.service.current()).toBeNull();
  });

  it("stops waking the pane after dispose, not just unregistering", () => {
    // `dispose` runs when the app runtime is torn down — a test harness, a
    // hot reload. Everything it drops is a live subscription into a deck that
    // no longer exists, and the wake half is the one that WRITES: a queue
    // still draining after dispose would nudge panes belonging to a session
    // nobody is watching. Unregistering the commands only stops new sends.
    const h = setup();
    h.reports("pane-2", APPROVING);
    void h.send("held behind a prompt");

    h.service.dispose();
    h.reports("pane-2", READY);
    expect(h.woken).toHaveLength(0);
    // And nothing is left listening for the deck to change under it.
    expect(h.sessionListeners()).toBe(0);
  });

  it("asks a CLI its version as soon as it exists, once per agent type", () => {
    // A version is read by ONE thing — a renderer picking the hook-output
    // schema its release accepts — and asking costs half a second of running
    // the CLI. Asked at boot for every installed plugin it froze the window
    // for about two seconds, for every user, mostly to learn a fact nothing
    // would read. So the question belongs here, with its only consumer.
    const h = setup();
    // One per agent TYPE — the two panes run different CLIs, and a third
    // repeating one of them adds nothing.
    expect(h.learned).toEqual(["claude", "codex"]);
  });

  it("keeps asking on every deck change, so a forgotten version is learned again", () => {
    // Deliberately NOT memoised here. The port answers from its own cache,
    // and that cache is the only thing that knows when the answer stopped
    // being true — a re-detection drops it, because the CLI underneath may
    // have been upgraded. A memo on this side was invalidated by a different
    // signal than the cache it shadowed, so after a Rescan it reported
    // "already asked" about a version that had just been thrown away and
    // nothing ever asked again.
    //
    // Repeating is what makes that self-healing, and it is free: the port
    // short-circuits on its own cache and spawns nothing (see agentBins).
    const h = setup();
    h.learned.length = 0;

    h.closePanes([{ id: "pane-1" }, { id: "pane-2" }] as Pane[]);
    expect(h.learned).toEqual(["claude", "codex"]);

    // And a pane running something new is asked about along with the rest.
    h.learned.length = 0;
    h.closePanes([{ id: "pane-1" }, { id: "pane-9" }] as Pane[]);
    expect(h.learned).toEqual(["claude", "kimi"]);
  });

  it("asks once the agent registry fills, since the boot-time walk found nothing", () => {
    // The registry is EMPTY while the deck hydrates, so the walk that runs
    // when the feature settles has nothing to ask about. Without this edge
    // the answer was only ever learned by the coincidence that waking a
    // restored pane happens to write to the deck.
    const h = setup();
    h.learned.length = 0;

    h.agentsChanged();
    expect(h.learned).toEqual(["claude", "codex"]);
  });

  it("keeps its standing-presence for its life, and takes it down at dispose", () => {
    // The presence re-states a pane's team on a fresh session. It was built
    // BESIDE the service in the composition root once, which meant a
    // teardown destroyed the manager while the presence kept running and
    // no-oped through a dead reference. Nothing in this directory could
    // enforce otherwise, because the collaborator was not its child.
    const h = setup();
    h.beginsSession("pane-1");
    expect(h.waitingFor("pane-1")).toEqual(["team"]);

    h.service.dispose();
    // Unsubscribed outright, not merely inert: a live listener whose every
    // announcement lands on a dead manager is a leak that shows the day
    // somebody makes `announce` do more than nothing.
    expect(h.sessionListeners()).toBe(0);
  });

  it("answers a pane's ask through the labelled channel it owns", () => {
    // The status lane hands questions to `answerAsk`; the service owns the
    // renderer lookup and the reply memory behind it. A hook with no file
    // waits out its whole timeout, so every ask is answered.
    const h = setup();
    h.service.answerAsk("pane-2", {
      agent: "claude",
      reply: "askABC",
      event: { hook_event_name: "Stop" },
    });
    expect(h.replies).toEqual([{ paneId: "pane-2", id: "askABC", body: "" }]);
  });

  it("holds the terminal while a pane's own ask is being answered", () => {
    // The status lane folds an envelope before answering it, and the fold
    // wakes this manager in the same breath — one call before the answer
    // takes the mail out of the queue. Left alone, the pass types at a pane
    // that is about to be served for free, and the line stays in a composer
    // saying nothing. Measured at 42 of 188 nudged messages.
    const h = setup();
    const answered = h.service.expectAsk("pane-2", {
      agent: "claude",
      reply: "askABC",
      event: { hook_event_name: "Stop" },
    });

    h.send("hi");
    expect(h.woken).toEqual([]);

    // A refusal is not a loss: the message never left the queue, so the pass
    // has to run again the moment the answer is done — a refused wake arms no
    // timer, and nothing else would come back for it.
    answered();
    expect(h.woken).toEqual(["pane-2"]);
  });

  it("arms nothing for an envelope that only reports", () => {
    // Most envelopes carry no question at all. Holding the terminal for those
    // would silence the pane for its whole life rather than for one answer.
    const h = setup();
    const answered = h.service.expectAsk("pane-2", {
      agent: "claude",
      event: { hook_event_name: "PostToolUse" },
    });

    h.send("hi");
    expect(h.woken).toEqual(["pane-2"]);
    answered();
  });
});
