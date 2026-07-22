// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";

vi.mock("./terminal/TerminalPane", () => ({
  TerminalPane: vi.fn(() => null),
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
  onCloseAgent: vi.fn(),
  onRenamePane: vi.fn(),
  onPaneTitle: vi.fn(),
  onStartFresh: vi.fn(),
  onRetryProvision: vi.fn(),
  onAgentExited: vi.fn(),
  onAgentSpawnFailed: vi.fn(),
  onRestartAgent: vi.fn(() => Promise.resolve()),
};

const browser = {
  hits: [],
  total: 0,
  hasMore: false,
  loadingMore: false,
  query: "",
  scanning: false,
  search: vi.fn(),
  loadMore: vi.fn(),
  scan: vi.fn(),
  transcript: vi.fn(() => Promise.resolve([])),
};

const props = (overrides: Record<string, unknown> = {}) => ({
  journal: {},
  browser,
  workspaces,
  activeId: "ws-1",
  viewByWs: {},
  selectedPaneId: null,
  deckLayout: "grid" as const,
  minimizeStyle: "tray" as const,
  agents: [
    {
      id: "codex",
      label: "Codex",
      command: "codex",
      supportsYolo: false,
      installed: true,
      path: null,
      usageCapabilities: ["paneTelemetry", "accountLimits"] as const,
    },
  ],
  agentsReady: true,
  gitHeads: new Map(),
  dormantBlocked: {},
  specByPane: {
    "pane-1": { command: "codex", args: [], env: [] },
    "pane-2": { command: "codex", args: [], env: [] },
  },
  restartEpochs: new Map<string, number>(),
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
    act(() => root.render(createElement(DeckStage, props(overrides))));

  it("keeps an exit while minimized, resumes it when revealed, then remounts by epoch", async () => {
    render({ viewByWs: { "ws-1": { minimized: ["pane-1"] } } });
    const hidden = document.querySelector<HTMLElement>("[data-pane-id='pane-1']")!;
    expect(hidden.classList.contains("pane--hidden")).toBe(true);

    act(() => terminalProps("pane-1").onExit?.(0, false));
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

    render({
      viewByWs: { "ws-1": {} },
      restartEpochs: new Map([["pane-1", 1]]),
    });
    expect(
      document.querySelector("[data-pane-id='pane-1'] .pane__exit"),
    ).toBeNull();
  });

  it("keeps an exit while folded and exposes the fresh action when expanded", async () => {
    render({ deckLayout: "list", viewByWs: { "ws-1": { select: "pane-2" } } });
    const folded = document.querySelector<HTMLElement>("[data-pane-id='pane-1']")!;
    expect(folded.classList.contains("pane--folded")).toBe(true);
    act(() => terminalProps("pane-1").onExit?.(1, false));

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
    act(() => root.render(createElement(DeckStage, props(overrides))));

  it("draws the catalog's brand mark with the agent label as tooltip", () => {
    const mark = { viewBox: "0 0 24 24", paths: [{ d: "M0 0h24v24H0z" }] };
    render({
      agents: [
        {
          id: "codex",
          label: "Codex",
          icon: mark,
          command: "codex",
          supportsYolo: false,
          installed: true,
          path: null,
          usageCapabilities: ["paneTelemetry", "accountLimits"] as const,
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
    expect(chip.textContent).toContain("YOLO");
    expect(chip.title).toContain("without permission prompts");
    expect(
      document.querySelector("[data-pane-id='pane-2'] .pane__yolo"),
    ).toBeNull();
  });
});
