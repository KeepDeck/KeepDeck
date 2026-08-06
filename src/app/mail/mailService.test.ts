import { describe, expect, it } from "vitest";
import { createCommandRegistry } from "../../domain/commands";
import type { Pane, Workspace } from "../../domain/deck";
import type { Mail } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { Deck } from "../useDeck";
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
  let panes: Pane[] = [{ id: "pane-1" }, { id: "pane-2" }] as Pane[];
  const activity = new Map<string, PaneActivity>([
    ["pane-1", READY],
    ["pane-2", READY],
  ]);
  const settingsListeners = new Set<() => void>();
  const paneListeners = new Set<() => void>();
  const activityListeners = new Set<() => void>();
  const delivered: Mail[] = [];
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
      agentMail: () => wish,
      subscribe: (listener) => {
        settingsListeners.add(listener);
        return () => settingsListeners.delete(listener);
      },
    },
    {
      registry,
      activityOf: (paneId) => activity.get(paneId),
      subscribeActivity: (listener) => {
        activityListeners.add(listener);
        return () => activityListeners.delete(listener);
      },
      deliver: (mail) => {
        delivered.push(mail);
        return true;
      },
      livePaneIds: () => new Set(panes.map((p) => p.id)),
      subscribePanes: (listener) => {
        paneListeners.add(listener);
        return () => paneListeners.delete(listener);
      },
      commands: {
        deck: () => ({ workspaces: workspaces() }) as unknown as Deck,
        agents: () => [{ id: "claude", label: "Claude" }],
      },
    },
  );

  return {
    service,
    registry,
    delivered,
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
});
