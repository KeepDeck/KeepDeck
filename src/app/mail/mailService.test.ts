import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../domain/commands";
import type { Pane, Workspace } from "../../domain/deck";
import type { Mail } from "../../domain/mail";
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

function setup(initial: boolean | null) {
  let wish = initial;
  // pane-1 is on a team, so the standing-presence has something to re-state.
  let panes: Pane[] = [
    { id: "pane-1", team: { name: "api", role: "lead" } },
    { id: "pane-2" },
  ] as Pane[];
  const activity = new Map<string, PaneActivity>([
    ["pane-1", READY],
    ["pane-2", READY],
  ]);
  const settingsListeners = new Set<() => void>();
  const paneListeners = new Set<() => void>();
  const activityListeners = new Set<() => void>();
  const delivered: Mail[] = [];
  const replies: { paneId: string; id: string; body: string }[] = [];
  const sessionListeners = new Set<(paneId: string) => void>();
  const learned: string[] = [];
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
      agentTeams: () => wish,
      subscribe: (listener) => {
        settingsListeners.add(listener);
        return () => settingsListeners.delete(listener);
      },
    },
    {
      registry,
      deck: {
        workspaces,
        subscribe: (listener) => {
          paneListeners.add(listener);
          return () => paneListeners.delete(listener);
        },
        setPaneTeam: () => {},
        agentTypeOf: () => "claude",
      },
      agents: {
        labels: () => [{ id: "claude", label: "Claude" }],
        // No renderMail and no wake: this agent is a plain terminal CLI, so
        // the manager's default path is the one under test here.
        statusOf: () => undefined,
        versionOf: () => null,
        learnVersion: (agentId: string) => learned.push(agentId),
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
      terminal: {
        deliver: (mail) => {
          delivered.push(mail);
          return true;
        },
        wake: () => true,
      },
      bridge: {
        reply: (paneId, id, body) => replies.push({ paneId, id, body }),
        nudge: () => {},
        onReplyUncollected: () => Promise.resolve(() => {}),
      },
    },
  );

  return {
    service,
    registry,
    delivered,
    replies,
    learned,
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
    set(next: boolean | null) {
      wish = next;
      for (const listener of [...settingsListeners]) listener();
    },
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
  it("registers nothing while the feature is off", () => {
    const h = setup(false);
    expect(h.registry.has("mail.send")).toBe(false);
    expect(h.registry.has("mail.inbox")).toBe(false);
  });

  it("treats settings that have not loaded as off", () => {
    // Starting on a guess and tearing down a moment later would write into
    // panes the user may have meant to leave alone.
    const h = setup(null);
    expect(h.registry.has("mail.send")).toBe(false);
    h.set(true);
    expect(h.registry.has("mail.send")).toBe(true);
  });

  it("brings the commands up and down with the toggle, without a restart", () => {
    const h = setup(false);
    h.set(true);
    expect(h.registry.has("mail.send")).toBe(true);
    h.set(false);
    // Unregistering is the point: a registered command IS an MCP tool, so
    // one left registered to refuse would advertise a capability the deck
    // has switched off.
    expect(h.registry.has("mail.send")).toBe(false);
    expect(h.registry.has("mail.inbox")).toBe(false);
  });

  it("stops DELIVERY too, not just sending", async () => {
    const h = setup(true);
    h.reports("pane-2", APPROVING);
    await h.send("held");
    expect(h.delivered).toHaveLength(0);

    h.set(false);
    // The pane becomes able to take it — and nothing arrives. A gate over
    // only the sending half would leave a pane receiving messages it has no
    // command left to answer.
    h.reports("pane-2", READY);
    expect(h.delivered).toHaveLength(0);
  });

  it("does not hand a closed pane's mail to whoever inherits its id", async () => {
    const h = setup(true);
    await h.send("for the old pane-2");
    // The message landed, so it sits in pane-2's inbox.
    const before = await h.registry.execute("mail.inbox", {}, {
      kind: "external",
      client: "mcp",
      pane: { id: "pane-2", workspaceId: "ws-1", label: "Agent 2" },
    });
    expect(before.ok && (before.value as unknown[]).length).toBe(1);

    // pane-2 closes. `pane-N` is a REUSABLE slot, so the next pane can be
    // handed the same id — and must not inherit a conversation.
    h.closePanes([{ id: "pane-1" }] as Pane[]);
    const after = await h.registry.execute("mail.inbox", {}, {
      kind: "external",
      client: "mcp",
      pane: { id: "pane-2", workspaceId: "ws-1", label: "Agent 2" },
    });
    expect(after.ok && after.value).toEqual([]);
  });

  it("exposes the manager only while the feature is on", () => {
    const h = setup(false);
    expect(h.service.current()).toBeNull();
    h.set(true);
    expect(h.service.current()).not.toBeNull();
    h.set(false);
    expect(h.service.current()).toBeNull();
  });

  it("leaves nothing registered after dispose", () => {
    const h = setup(true);
    expect(h.registry.has("mail.send")).toBe(true);
    h.service.dispose();
    expect(h.registry.has("mail.send")).toBe(false);
    expect(h.service.current()).toBeNull();
  });

  it("stops delivering after dispose, not just unregistering", () => {
    // `dispose` runs when the app runtime is torn down — a test harness, a
    // hot reload. Everything it drops is a live subscription into a deck that
    // no longer exists, and the delivery half is the one that WRITES: a queue
    // still draining after dispose types into panes belonging to a session
    // nobody is watching. Unregistering the commands only stops new sends.
    const h = setup(true);
    h.reports("pane-2", APPROVING);
    void h.send("held behind a prompt");

    h.service.dispose();
    h.reports("pane-2", READY);
    expect(h.delivered).toHaveLength(0);
    // And nothing is left listening for the deck to change under it.
    expect(h.sessionListeners()).toBe(0);
  });

  it("asks a CLI its version only once the feature is on, and only for live panes", () => {
    // A version is read by ONE thing — a renderer picking the hook-output
    // schema its release accepts — and asking costs half a second of running
    // the CLI. Asked at boot for every installed plugin it froze the window
    // for about two seconds, for every user, mostly to learn a fact nothing
    // would read. So the question belongs here, with its only consumer.
    const h = setup(false);
    expect(h.learned).toEqual([]);

    h.set(true);
    // Once per agent TYPE, not once per pane: both panes run claude.
    expect(h.learned).toEqual(["claude"]);
  });

  it("asks again when a pane appears, since it may run something new", () => {
    const h = setup(true);
    h.learned.length = 0;
    h.closePanes([{ id: "pane-1" }, { id: "pane-2" }, { id: "pane-3" }] as Pane[]);
    expect(h.learned).toEqual(["claude"]);
  });

  it("takes its standing-presence with it when the feature goes off", () => {
    // The presence re-states a pane's team on a fresh session. It was built
    // BESIDE the service in the composition root once, which meant the
    // toggle destroyed the manager while the presence kept running and
    // no-oped through a dead reference. Nothing in this directory could
    // enforce otherwise, because the collaborator was not its child.
    const h = setup(true);
    h.beginsSession("pane-1");
    expect(h.waitingFor("pane-1")).toEqual(["team"]);

    // Off: the presence is unsubscribed outright, not merely inert. A live
    // listener whose every announcement lands on a null manager is a feature
    // that is off in effect but not in fact — and the difference shows the
    // day somebody makes `announce` do more than nothing.
    h.set(false);
    expect(h.sessionListeners()).toBe(0);
    h.beginsSession("pane-1");
    h.set(true);
    expect(h.waitingFor("pane-1")).toEqual([]);

    h.service.dispose();
    // And after dispose it is unsubscribed outright, not merely inert.
    expect(h.sessionListeners()).toBe(0);
  });

  it("answers a pane's ask through the labelled channel it owns", () => {
    // The status lane hands questions to `answerAsk`; the service owns the
    // renderer lookup and the reply memory behind it. With the feature off
    // it must still answer — a hook with no file waits out its whole timeout.
    const h = setup(false);
    h.service.answerAsk("pane-2", {
      agent: "claude",
      reply: "askABC",
      event: { hook_event_name: "Stop" },
    });
    expect(h.replies).toEqual([{ paneId: "pane-2", id: "askABC", body: "" }]);
  });
});
