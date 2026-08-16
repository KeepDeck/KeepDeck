// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatusEvent } from "@keepdeck/plugin-api";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createAgentStatusTracker } from "../app/agentStatusTracker";
import { createUsageManager } from "../app/usageManager";
import { AppRuntimeProvider } from "../app/runtimeContext";
import type { AppRuntime } from "../app/runtime";

/** The runtime slice the panes under DeckStage read (activity + ctx%). The
 * tracker is a mutable binding so the frames describe can report live
 * activity; that describe takes a fresh instance in its beforeEach AND
 * restores a clean one in afterEach, so the frame-agnostic describes never
 * observe reported edges whatever order they run in. */
let statusTracker = createAgentStatusTracker();
const withRuntime = (el: ReactElement) =>
  createElement(
    AppRuntimeProvider,
    {
      runtime: {
        statusTracker,
        usageManager: createUsageManager(),
      } as unknown as AppRuntime,
    },
    el,
  );

vi.mock("./terminal/TerminalPane", () => ({
  TerminalPane: vi.fn(() => null),
}));

// A pane READS its process state from the session registry; stand in for it so
// a test can kill one pane's process without spawning anything.
const sessions = vi.hoisted(() => {
  const NONE = { kind: "none" };
  const states = new Map<string, { kind: string; code?: number | null }>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  return {
    read: (paneId: string) => states.get(paneId) ?? NONE,
    exit(paneId: string, code: number | null) {
      states.set(paneId, { kind: "exited", code });
      notify();
    },
    reset() {
      states.clear();
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});
vi.mock("../app/ptyManager", () => ({
  paneSessionState: (paneId: string) => sessions.read(paneId),
  subscribeSessions: sessions.subscribe,
}));

import { TerminalPane } from "./terminal/TerminalPane";
import { DeckStage } from "./DeckStage";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const workspaces = [
  {
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "Workspace",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes: [
      {
        id: "pane-1",
        agentType: "codex",
        session: { id: "session-1", boundAt: "2026-07-11T00:00:00Z" },
      },
      { id: "pane-2", agentType: "codex" },
    ],
  },
];

const twoWorkspaces = [
  ...workspaces,
  {
    id: "ws-2",
    instance: createWorkspaceInstance(),
    name: "Second workspace",
    cwd: "/repo-2",
    worktreeBaseDir: null,
    panes: [
      { id: "pane-3", agentType: "codex" },
      { id: "pane-4", agentType: "codex" },
    ],
  },
];

const callbacks = {
  onDeleteJournalRecord: vi.fn(),
  onResumeSession: vi.fn(),
  onForkSession: vi.fn(),
  onSelectPane: vi.fn(),
  onToggleFocus: vi.fn(),
  onToggleMinimize: vi.fn(),
  onRestoreSuspendedPane: vi.fn(),
  onCloseAgent: vi.fn(),
  onRenamePane: vi.fn(),
  onPaneTitle: vi.fn(),
  onStartFresh: vi.fn(),
  onResumeAgent: vi.fn(),
  onRetryProvision: vi.fn(),
  onRetryPlanBuild: vi.fn(),
  onAgentExited: vi.fn(),
  onAgentSpawnFailed: vi.fn(),
  onRestartAgent: vi.fn(() => Promise.resolve("restarted" as const)),
};

const browser = {
  hits: [],
  total: 0,
  hasMore: false,
  loadingMore: false,
  query: "",
  error: null,
  scanning: false,
  search: vi.fn(),
  loadMore: vi.fn(),
  ensureFresh: vi.fn(),
  transcript: vi.fn(() => Promise.resolve([])),
};

const props = (overrides: Record<string, unknown> = {}) => ({
  journal: {},
  browser,
  workspaces,
  activeId: "ws-1",
  viewByWs: {},
  selectedPaneId: null,
  keyboardFocusEnabled: true,
  deckLayout: "grid" as const,
  minimizeStyle: "tray" as const,
  agents: [
    {
      id: "codex",
      label: "Codex",
      command: "codex",
      features: [],
      installed: true,
      path: null,
    },
  ],
  agentsReady: true,
  unavailableAgentReasons: new Map(),
  gitHeads: new Map(),
  idleBlocked: {},
  wakeFailed: {},
  specByPane: {
    "pane-1": { command: "codex", args: [], env: [] },
    "pane-2": { command: "codex", args: [], env: [] },
  },
  failedPanes: new Set<string>(),
  restartEpochs: {} as Record<string, number>,
  ...callbacks,
  ...overrides,
});

function terminalProps(paneId: string) {
  const call = [...vi.mocked(TerminalPane).mock.calls]
    .reverse()
    .find(([terminal]) => terminal.paneId === paneId);
  if (!call) throw new Error(`Terminal ${paneId} was not rendered`);
  return call[0];
}

// A death recorded by one test is not a fact about the next one.
afterEach(() => sessions.reset());

describe("DeckStage — exited agents across layouts", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    vi.mocked(TerminalPane).mockClear();
    for (const callback of Object.values(callbacks)) callback.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const render = (overrides: Record<string, unknown> = {}) =>
    act(() => root.render(withRuntime(createElement(DeckStage, props(overrides)))));

  it("forwards global keyboard-focus eligibility to terminal panes", () => {
    render({ keyboardFocusEnabled: false, selectedPaneId: "pane-1" });

    expect(terminalProps("pane-1").keyboardFocusEnabled).toBe(false);
    expect(terminalProps("pane-2").keyboardFocusEnabled).toBe(false);
  });

  it("keeps an exit while minimized, resumes it when revealed, then remounts by epoch", async () => {
    render({ viewByWs: { "ws-1": { minimized: ["pane-1"] } } });
    const hidden = document.querySelector<HTMLElement>("[data-pane-id='pane-1']")!;
    expect(hidden.classList.contains("pane--hidden")).toBe(true);

    act(() => {
      sessions.exit("pane-1", 0);
      terminalProps("pane-1").onExit?.(0, false);
    });
    render({ viewByWs: { "ws-1": {} } });
    const revealed = document.querySelector<HTMLElement>("[data-pane-id='pane-1']")!;
    expect(revealed.classList.contains("pane--hidden")).toBe(false);
    expect(revealed.textContent).toContain("Agent exited");

    const restartButton = revealed.querySelector<HTMLButtonElement>(
      ".pane__exit-action--primary",
    )!;
    await act(async () => restartButton.click());
    expect(callbacks.onRestartAgent).toHaveBeenCalledWith(
      "ws-1",
      "pane-1",
      "resume",
    );

    // The restart ends the old session before remounting the pane by epoch.
    // With the process gone the registry has no exit left to report, so the
    // card cannot come back over the terminal the restart just started.
    act(() => sessions.reset());
    render({
      viewByWs: { "ws-1": {} },
      restartEpochs: { "pane-1": 1 },
    });
    expect(
      document.querySelector("[data-pane-id='pane-1'] .pane__exit"),
    ).toBeNull();
  });

  it("keeps an exit while folded and exposes the fresh action when expanded", async () => {
    render({ deckLayout: "list", viewByWs: { "ws-1": { select: "pane-2" } } });
    const folded = document.querySelector<HTMLElement>("[data-pane-id='pane-1']")!;
    expect(folded.classList.contains("pane--folded")).toBe(true);
    act(() => {
      sessions.exit("pane-1", 1);
      terminalProps("pane-1").onExit?.(1, false);
    });

    render({ deckLayout: "list", viewByWs: { "ws-1": { select: "pane-1" } } });
    const expanded = document.querySelector<HTMLElement>("[data-pane-id='pane-1']")!;
    expect(expanded.classList.contains("pane--folded")).toBe(false);
    const actions = expanded.querySelectorAll<HTMLButtonElement>(
      ".pane__exit-action",
    );
    expect(actions).toHaveLength(2);

    await act(async () => actions[1].click());
    expect(callbacks.onRestartAgent).toHaveBeenCalledWith(
      "ws-1",
      "pane-1",
      "fresh",
    );
  });

  it("removes a tray popover when a programmatic workspace switch hides its source", () => {
    const viewByWs = { "ws-1": { minimized: ["pane-1"] } };
    render({ workspaces: twoWorkspaces, viewByWs });
    const trigger = document.querySelector<HTMLButtonElement>(
      ".deck__workspace:not(.deck__workspace--hidden) .minimized-overflow__trigger",
    )!;
    act(() => trigger.click());
    expect(document.querySelector("[role='dialog']")).not.toBeNull();

    render({ workspaces: twoWorkspaces, viewByWs, activeId: "ws-2" });
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("removes a tray tooltip when a programmatic workspace switch hides its source", () => {
    const viewByWs = { "ws-1": { minimized: ["pane-1"] } };
    render({
      workspaces: twoWorkspaces,
      viewByWs,
      minimizeStyle: "strip",
    });
    const item = document.querySelector<HTMLButtonElement>(
      ".deck__workspace:not(.deck__workspace--hidden) .minimized--bar",
    )!;
    act(() => item.focus());
    expect(document.querySelector("[role='tooltip']")).not.toBeNull();

    render({
      workspaces: twoWorkspaces,
      viewByWs,
      minimizeStyle: "strip",
      activeId: "ws-2",
    });
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });
});

describe("DeckStage — agent identity on the pane header", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    vi.mocked(TerminalPane).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const render = (overrides: Record<string, unknown> = {}) =>
    act(() => root.render(withRuntime(createElement(DeckStage, props(overrides)))));

  it("draws the catalog's brand mark with the agent label as tooltip", () => {
    const mark = { viewBox: "0 0 24 24", paths: [{ d: "M0 0h24v24H0z" }] };
    render({
      agents: [
        {
          id: "codex",
          label: "Codex",
          icon: mark,
          command: "codex",
          features: [],
          installed: true,
          path: null,
        },
      ],
    });
    const slot = document.querySelector<HTMLElement>(
      "[data-pane-id='pane-1'] .pane__agent",
    )!;
    expect(slot.title).toBe("Codex");
    expect(slot.querySelector("path")!.getAttribute("d")).toBe(
      mark.paths[0].d,
    );
  });

  it("an agent whose plugin ships no mark gets the neutral fallback", () => {
    render();
    const slot = document.querySelector<HTMLElement>(
      "[data-pane-id='pane-1'] .pane__agent",
    )!;
    expect(slot.querySelector("svg polyline")).not.toBeNull();
  });

  it("a YOLO pane wears the standing warning chip; a plain one doesn't", () => {
    render({
      workspaces: [
        {
          ...workspaces[0],
          panes: [
            { id: "pane-1", agentType: "codex", yolo: true },
            { id: "pane-2", agentType: "codex" },
          ],
        },
      ],
    });
    const chip = document.querySelector<HTMLElement>(
      "[data-pane-id='pane-1'] .pane__yolo",
    )!;
    // Icon-only chip: the bolt svg is the visible mark, and the accessible
    // name comes from aria-label (title is only the sighted tooltip).
    expect(chip.querySelector("svg")).not.toBeNull();
    expect(chip.getAttribute("aria-label")).toBe("YOLO mode");
    expect(chip.title).toContain("without permission prompts");
    expect(
      document.querySelector("[data-pane-id='pane-2'] .pane__yolo"),
    ).toBeNull();
  });

  const teamLabel = (paneId: string) =>
    document.querySelector<HTMLElement>(
      `[data-pane-id='${paneId}'] .pane__team .chip__label`,
    )!.textContent;

  it("names each pane's team once the deck runs more than one", () => {
    // Reported live: two teams up, two panes both badged `lead`, and the
    // deck offering nothing to tell which lead led which. The role is only
    // an identity inside ONE team, so the deck — the only level that can
    // see the other team — is what settles this.
    render({
      workspaces: [
        {
          ...workspaces[0],
          panes: [
            { id: "pane-1", agentType: "codex", team: { name: "api", role: "lead" } },
            { id: "pane-2", agentType: "codex", team: { name: "web", role: "lead" } },
          ],
        },
      ],
    });
    expect(teamLabel("pane-1")).toBe("lead · api");
    expect(teamLabel("pane-2")).toBe("lead · web");
  });

  it("leaves the role bare while one team runs, however many wear it", () => {
    // The other half of the same rule. One team means its name is the same
    // word under every badge — width spent on a word that distinguishes
    // nothing, in a header that sheds whole chips when it runs out.
    render({
      workspaces: [
        {
          ...workspaces[0],
          panes: [
            { id: "pane-1", agentType: "codex", team: { name: "api", role: "lead" } },
            { id: "pane-2", agentType: "codex", team: { name: "api", role: "impl-1" } },
          ],
        },
      ],
    });
    expect(teamLabel("pane-1")).toBe("lead");
    expect(teamLabel("pane-2")).toBe("impl-1");
    // The name is still one hover away, on every badge.
    expect(
      document.querySelector<HTMLElement>("[data-pane-id='pane-1'] .pane__team")!
        .title,
    ).toContain("api");
  });
});

describe("DeckStage — a maximized pane minimizes the rest", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    vi.mocked(TerminalPane).mockClear();
    for (const callback of Object.values(callbacks)) callback.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const render = (overrides: Record<string, unknown> = {}) =>
    act(() => root.render(withRuntime(createElement(DeckStage, props(overrides)))));

  // happy-dom reports zero widths, so every tray chip lands in the +N
  // popover — the click target for a restore is the popover item.
  const overflowItems = () =>
    document.querySelectorAll<HTMLButtonElement>(
      "[role='dialog'] .minimized--chip",
    );
  const openOverflow = () =>
    act(() =>
      document
        .querySelector<HTMLButtonElement>(".minimized-overflow__trigger")!
        .click(),
    );

  it("lists the panes a maximize hides in the tray, and empties when un-maximized", () => {
    render({ viewByWs: { "ws-1": { focus: "pane-1" } } });
    expect(
      document
        .querySelector<HTMLElement>("[data-pane-id='pane-2']")!
        .classList.contains("pane--hidden"),
    ).toBe(true);
    expect(document.querySelector(".deck__tray-label")!.textContent).toBe(
      "Minimized · 1",
    );

    render({ viewByWs: { "ws-1": {} } });
    expect(document.querySelector(".deck__tray")).toBeNull();
  });

  it("switches the spotlight when a maximize-hidden entry is restored (tray)", () => {
    render({ viewByWs: { "ws-1": { focus: "pane-1" } } });
    openOverflow();
    expect(overflowItems()).toHaveLength(1);
    expect(overflowItems()[0].textContent).toContain("Codex 2");

    act(() => overflowItems()[0].click());
    expect(callbacks.onSelectPane).toHaveBeenCalledWith("ws-1", "pane-2");
    expect(callbacks.onToggleFocus).toHaveBeenCalledWith("ws-1", "pane-2");
    expect(callbacks.onToggleMinimize).not.toHaveBeenCalled();
  });

  it("switches the spotlight when a maximize-hidden entry is restored (strip)", () => {
    render({
      minimizeStyle: "strip",
      viewByWs: { "ws-1": { focus: "pane-1" } },
    });
    const bars = document.querySelectorAll<HTMLButtonElement>(
      ".deck__folds .minimized--bar",
    );
    expect(bars).toHaveLength(1);
    expect(bars[0].textContent).toContain("Codex 2");

    act(() => bars[0].click());
    expect(callbacks.onSelectPane).toHaveBeenCalledWith("ws-1", "pane-2");
    expect(callbacks.onToggleFocus).toHaveBeenCalledWith("ws-1", "pane-2");
    expect(callbacks.onToggleMinimize).not.toHaveBeenCalled();
  });

  it("mixes explicit minimizes and maximize-hidden panes in pane order, each with its own restore", () => {
    render({
      workspaces: [
        {
          ...workspaces[0],
          panes: [
            { id: "pane-1", agentType: "codex" },
            { id: "pane-2", agentType: "codex" },
            { id: "pane-3", agentType: "codex" },
          ],
        },
      ],
      specByPane: {
        "pane-1": { command: "codex", args: [], env: [] },
        "pane-2": { command: "codex", args: [], env: [] },
        "pane-3": { command: "codex", args: [], env: [] },
      },
      viewByWs: { "ws-1": { focus: "pane-1", minimized: ["pane-2"] } },
    });
    expect(document.querySelector(".deck__tray-label")!.textContent).toBe(
      "Minimized · 2",
    );

    openOverflow();
    expect(overflowItems()).toHaveLength(2);
    expect(overflowItems()[0].textContent).toContain("Codex 2");
    expect(overflowItems()[1].textContent).toContain("Codex 3");

    // The explicit minimize keeps its classic restore...
    act(() => overflowItems()[0].click());
    expect(callbacks.onToggleMinimize).toHaveBeenCalledWith("ws-1", "pane-2");
    expect(callbacks.onSelectPane).not.toHaveBeenCalled();
    expect(callbacks.onToggleFocus).not.toHaveBeenCalled();

    // ...the maximize-hidden one switches the spotlight.
    openOverflow();
    act(() => overflowItems()[1].click());
    expect(callbacks.onSelectPane).toHaveBeenCalledWith("ws-1", "pane-3");
    expect(callbacks.onToggleFocus).toHaveBeenCalledWith("ws-1", "pane-3");
  });

  it("leaves the none style without any minimize zone, maximized or not", () => {
    render({
      minimizeStyle: "none",
      viewByWs: { "ws-1": { focus: "pane-1" } },
    });
    expect(
      document
        .querySelector<HTMLElement>("[data-pane-id='pane-2']")!
        .classList.contains("pane--hidden"),
    ).toBe(true);
    expect(document.querySelector(".deck__tray")).toBeNull();
    expect(document.querySelector(".deck__folds")).toBeNull();
  });
});

describe("DeckStage — status frames across layouts", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    vi.mocked(TerminalPane).mockClear();
    statusTracker = createAgentStatusTracker();
    statusTracker.registerNormalizer(
      "codex",
      (payload: unknown) =>
        (payload as { edge?: AgentStatusEvent }).edge ?? null,
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    statusTracker = createAgentStatusTracker();
  });

  const render = (overrides: Record<string, unknown> = {}) =>
    act(() => root.render(withRuntime(createElement(DeckStage, props(overrides)))));

  const paneEl = (paneId: string) =>
    document.querySelector<HTMLElement>(`[data-pane-id='${paneId}']`)!;

  const reportEdge = (paneId: string, edge: AgentStatusEvent) =>
    act(() => statusTracker.report(paneId, { agent: "codex", edge }));

  it("frames working and done on list rows — an accordion row is not the stage", () => {
    render({ deckLayout: "list", viewByWs: { "ws-1": { select: "pane-2" } } });
    reportEdge("pane-1", { kind: "turn-start", at: 1 });
    reportEdge("pane-2", { kind: "turn-end", at: 1 });

    // Both rows keep the frames a gridded pane wears, and neither wears a
    // selection border — expansion itself marks the cursor's row.
    expect(paneEl("pane-1").classList.contains("pane--frame-working")).toBe(
      true,
    );
    expect(paneEl("pane-2").classList.contains("pane--frame-done")).toBe(true);
    expect(paneEl("pane-2").classList.contains("pane--frame-selected")).toBe(
      false,
    );
  });

  it("keeps a stage-filling grid pane's rim for attention alone", () => {
    // Maximized by hand.
    render({ viewByWs: { "ws-1": { focus: "pane-1" } } });
    reportEdge("pane-1", { kind: "turn-start", at: 1 });
    expect(paneEl("pane-1").classList.contains("pane--frame-working")).toBe(
      false,
    );
    reportEdge("pane-1", { kind: "waiting", at: 2, reason: "permission" });
    expect(paneEl("pane-1").classList.contains("pane--frame-waiting")).toBe(
      true,
    );

    // The lone pane left on the grid reads the same.
    render({ viewByWs: { "ws-1": { minimized: ["pane-2"] } } });
    reportEdge("pane-1", { kind: "turn-start", at: 3 });
    expect(paneEl("pane-1").classList.contains("pane--frame-working")).toBe(
      false,
    );
    reportEdge("pane-1", { kind: "waiting", at: 4, reason: "question" });
    expect(paneEl("pane-1").classList.contains("pane--frame-waiting")).toBe(
      true,
    );
  });
});
