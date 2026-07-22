import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../domain/agents";
import { createCommandRegistry } from "../domain/commands";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { registerPaneInput } from "./paneInput";
import { deliverTask, registerCoreCommands } from "./coreCommands";
import type { Deck } from "./useDeck";

const HOST = { kind: "host" } as const;

// Repo inspection is per-test switchable; suggestions follow the real Rust
// naming (kd/<ws>/<i> ↔ kd-<ws>-<i>); probes report every path free.
const repoMode = vi.hoisted(() => ({
  isRepo: false,
  inspect: null as null | (() => Promise<{
    isRepo: boolean;
    head: string;
    branch: string;
  }>),
}));
vi.mock("../ipc/worktree", () => ({
  inspectRepo: () =>
    repoMode.inspect?.() ??
    Promise.resolve({ isRepo: repoMode.isRepo, head: "abc", branch: "main" }),
  suggestWorktree: async (workspace: string, index: number) => ({
    branch: `kd/${workspace}/${index}`,
    folder: `kd-${workspace}-${index}`,
  }),
  probeWorktree: async () => ({
    exists: false,
    isWorktree: false,
    empty: false,
    branch: null,
  }),
  createWorktree: async () => {
    throw new Error("not under test");
  },
  removeWorktree: async () => {},
}));

const settingsState = vi.hoisted(() => ({
  current: null as { defaultYolo?: boolean } | null,
}));
vi.mock("./settingsManager", () => ({
  getSettings: () => settingsState.current,
}));

const AGENTS: AgentInfo[] = [
  { id: "claude", label: "Claude", command: "claude", supportsYolo: true, installed: true, path: "/c", reportsUsage: true },
  { id: "codex", label: "Codex", command: "codex", supportsYolo: false, installed: true, path: "/x", reportsUsage: true },
];

const workspace = (over: Partial<Workspace>): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  ...over,
});

/** A deck stub: live workspaces array + recording actions. addAgentPane
 * mutates the array so follow-up reads see the new pane, like the reducer. */
function fakeDeck(workspaces: Workspace[]): Deck {
  return {
    workspaces,
    activeId: workspaces[0]?.id ?? "",
    viewOf: () => ({}),
    selectWorkspace: vi.fn(),
    selectPane: vi.fn(),
    addAgentPane: vi.fn((wsId: string, pane: Workspace["panes"][number]) => {
      workspaces.find((w) => w.id === wsId)?.panes.push(pane);
    }),
    resolvePaneProvisioning: vi.fn(),
    setPaneProvisioningError: vi.fn(),
    setPaneProvisioningPhase: vi.fn(),
  } as unknown as Deck;
}

function setup(workspaces: Workspace[]) {
  const registry = createCommandRegistry();
  const deck = fakeDeck(workspaces);
  const requestCloseAgent = vi.fn();
  const openSettings = vi.fn();
  const dispose = registerCoreCommands(registry, {
    deck: () => deck,
    agents: () => AGENTS,
    requestCloseAgent,
    openSettings,
  });
  return { registry, deck, requestCloseAgent, openSettings, dispose };
}

beforeEach(() => {
  repoMode.isRepo = false;
  repoMode.inspect = null;
  settingsState.current = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("workspace commands", () => {
  it("lists workspaces with active flag and header titles", async () => {
    const { registry } = setup([
      workspace({ panes: [{ id: "p1", agentType: "claude" }] }),
      workspace({ id: "ws-2", name: "site", cwd: "/site" }),
    ]);
    const result = await registry.execute("workspace.list", {}, HOST);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value).toEqual([
        {
          id: "ws-1",
          name: "web",
          cwd: "/repo",
          active: true,
          panes: [
            {
              id: "p1",
              title: "Claude 1",
              agentType: "claude",
              branch: null,
              cwd: "/repo",
            },
          ],
        },
        { id: "ws-2", name: "site", cwd: "/site", active: false, panes: [] },
      ]);
  });

  it("switches by case-insensitive name and refuses unknowns", async () => {
    const { registry, deck } = setup([
      workspace({}),
      workspace({ id: "ws-2", name: "site" }),
    ]);
    const ok = await registry.execute("workspace.switch", { workspace: "SITE" }, HOST);
    expect(ok).toEqual({ ok: true, value: { workspaceId: "ws-2" } });
    expect(deck.selectWorkspace).toHaveBeenCalledWith("ws-2");

    const bad = await registry.execute("workspace.switch", { workspace: "nope" }, HOST);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toBe('no workspace "nope"');
  });
});

describe("agent.spawn", () => {
  it("spawns a bare pane in a non-repo workspace and selects it", async () => {
    const { registry, deck } = setup([workspace({})]);
    const result = await registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "codex", name: "helper" },
      HOST,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value as { paneId: string; worktree: unknown };
    expect(value.worktree).toBeNull();
    const ws = deck.workspaces[0];
    expect(ws.panes).toHaveLength(1);
    expect(ws.panes[0]).toMatchObject({ agentType: "codex", name: "helper" });
    expect(deck.selectWorkspace).toHaveBeenCalledWith("ws-1");
    expect(deck.selectPane).toHaveBeenCalledWith("ws-1", value.paneId);
  });

  it("provisions the first free worktree in a repo workspace with a base dir", async () => {
    repoMode.isRepo = true;
    const { registry, deck } = setup([
      workspace({ worktreeBaseDir: "/wt", panes: [{ id: "p0", agentType: "claude" }] }),
    ]);
    const result = await registry.execute("agent.spawn", { workspace: "web" }, HOST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pane = deck.workspaces[0].panes[1];
    expect(pane.provisioning).toMatchObject({
      repo: "/repo",
      branch: "kd/web/2",
      workspace: "web",
      index: 2,
    });
    expect(pane.provisioning?.path?.endsWith("kd-web-2")).toBe(true);
  });

  it("honors the global YOLO default, gated on the agent's support", async () => {
    settingsState.current = { defaultYolo: true };
    const { registry, deck } = setup([workspace({})]);

    await registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "claude" },
      HOST,
    );
    expect(deck.workspaces[0].panes[0].yolo).toBe(true);

    await registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "codex" },
      HOST,
    );
    // codex's fixture declares no support — the default must not leak, and
    // off never lands as an explicit false (sparse like every other surface).
    expect("yolo" in deck.workspaces[0].panes[1]).toBe(false);
  });

  it("refuses an unknown agent type", async () => {
    const { registry } = setup([workspace({})]);
    const result = await registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "gemini" },
      HOST,
    );
    expect(result).toEqual({
      ok: false,
      error: { code: "failed", message: 'unknown agent type "gemini"' },
    });
  });

  it("does not attach a delayed spawn to a replacement with the same id", async () => {
    let finishInspect!: (value: {
      isRepo: boolean;
      head: string;
      branch: string;
    }) => void;
    repoMode.inspect = () =>
      new Promise((resolve) => {
        finishInspect = resolve;
      });
    const workspaces = [workspace({})];
    const { registry, deck } = setup(workspaces);

    const pending = registry.execute(
      "agent.spawn",
      { workspace: "web", agentType: "codex" },
      HOST,
    );
    const replacement = workspace({ name: "replacement", cwd: "/replacement" });
    workspaces.splice(0, 1, replacement);
    finishInspect({ isRepo: false, head: "abc", branch: "main" });

    await expect(pending).resolves.toEqual({
      ok: false,
      error: {
        code: "failed",
        message: "workspace was closed while spawning the agent",
      },
    });
    expect(replacement.panes).toEqual([]);
    expect(deck.addAgentPane).not.toHaveBeenCalled();
    expect(deck.selectWorkspace).not.toHaveBeenCalled();
  });

  it("delivers the task into the pane once its writer is live", async () => {
    vi.useFakeTimers();
    const { registry, deck } = setup([workspace({})]);
    const result = await registry.execute(
      "agent.spawn",
      { workspace: "web", task: "fix the header" },
      HOST,
    );
    expect(result.ok).toBe(true);
    const paneId = deck.workspaces[0].panes[0].id;
    const pasted: string[] = [];
    const written: string[] = [];
    // One entry carries both channels — TerminalPane registers them together.
    const off = registerPaneInput(paneId, {
      write: (t) => written.push(t),
      paste: (t) => pasted.push(t),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    off();
    // The task text is PASTED (xterm framing), the submit Enter is a separate
    // RAW write — a CR inside the paste payload would be content, not Enter.
    expect(pasted).toEqual(["fix the header"]);
    expect(written).toEqual(["\r"]);
  });
});

describe("agent.focus / agent.close / pane.write", () => {
  const twoPanes = () =>
    workspace({
      panes: [
        { id: "p1", agentType: "claude" },
        { id: "p2", agentType: "codex", name: "reviewer" },
      ],
    });

  it("focuses a pane by name in the active workspace", async () => {
    const { registry, deck } = setup([twoPanes()]);
    const result = await registry.execute("agent.focus", { agent: "reviewer" }, HOST);
    expect(result).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", paneId: "p2" },
    });
    expect(deck.selectPane).toHaveBeenCalledWith("ws-1", "p2");
  });

  it("close opens the confirm dialog with the header's label", async () => {
    const { registry, requestCloseAgent } = setup([twoPanes()]);
    const result = await registry.execute("agent.close", { agent: "claude 1" }, HOST);
    expect(result.ok).toBe(true);
    expect(requestCloseAgent).toHaveBeenCalledWith("ws-1", "p1", "Claude 1");
  });

  it("close is declared destructive", () => {
    const { registry } = setup([twoPanes()]);
    const info = registry.list().find((c) => c.id === "agent.close");
    expect(info?.destructive).toBe(true);
  });

  it("pastes text into the addressed pane; submit sends Enter as a separate raw write", async () => {
    const { registry } = setup([twoPanes()]);
    const pasted: string[] = [];
    const written: string[] = [];
    const off = registerPaneInput("p2", {
      write: (t) => written.push(t),
      paste: (t) => pasted.push(t),
    });
    const result = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "hello", submit: true },
      HOST,
    );
    off();
    expect(result.ok).toBe(true);
    expect(pasted).toEqual(["hello"]);
    // Enter rides outside the paste — see deliverTask for why a "\r" inside the
    // pasted payload would be content, not a submit.
    expect(written).toEqual(["\r"]);
  });

  it("write without a live session fails; without a selection it refuses", async () => {
    const { registry } = setup([twoPanes()]);
    const dead = await registry.execute(
      "pane.write",
      { agent: "reviewer", text: "hello" },
      HOST,
    );
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.error.message).toBe("the pane has no live session");

    const unaddressed = await registry.execute("pane.write", { text: "hi" }, HOST);
    expect(unaddressed.ok).toBe(false);
    if (!unaddressed.ok)
      expect(unaddressed.error.message).toBe('no agent selected in workspace "web"');
  });
});

describe("settings.open", () => {
  it("opens a plugin's own section, and the first section for anyone else", async () => {
    const { registry, openSettings } = setup([workspace({})]);
    await registry.execute("settings.open", {}, {
      kind: "plugin",
      pluginId: "keepdeck.voice",
    });
    expect(openSettings).toHaveBeenCalledWith("plugin:keepdeck.voice");

    await registry.execute("settings.open", {}, HOST);
    expect(openSettings).toHaveBeenLastCalledWith(null);
  });
});

describe("deliverTask", () => {
  it("gives up when the pane's writer never appears", async () => {
    const delivered = await deliverTask("ghost-pane", "task", async () => {});
    expect(delivered).toBe(false);
  });
});
