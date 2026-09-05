// @vitest-environment happy-dom
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { createAgentStatusTracker } from "../app/agentStatusTracker";
import { createUsageManager } from "../app/usageManager";
import { AppRuntimeProvider } from "../app/runtimeContext";
import type { AppRuntime } from "../app/runtime";

/** The runtime slice the panes under DeckStage read (activity + ctx%). */
const withRuntime = (el: ReactElement) =>
  createElement(
    AppRuntimeProvider,
    {
      runtime: {
        statusTracker: createAgentStatusTracker(),
        usageManager: createUsageManager(),
      } as unknown as AppRuntime,
    },
    el,
  );

vi.mock("./terminal/TerminalPane", () => ({
  TerminalPane: vi.fn(() => null),
}));
const sessions = vi.hoisted(() => ({ none: { kind: "none" } }));
vi.mock("../app/ptyManager", () => ({
  paneSessionState: () => sessions.none,
  subscribeSessions: () => () => undefined,
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

const callbacks = {
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
  scanning: false,
  revision: 1,
  invalidated: new Set<string>(),
  enrichment: {
    entries: new Map(),
    pending: false,
    declare: vi.fn(),
  },
  ensureFresh: vi.fn(),
  transcript: vi.fn(() => Promise.resolve({ entries: [] })),
};

const props = (overrides: Record<string, unknown> = {}) => ({
  journal: {},
  browserShared: browser,
  workspaces,
  activeId: "ws-1",
  viewByWs: {},
  selectedPaneId: null,
  keyboardFocusEnabled: true,
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
  occupiedPanes: {},
  onForkOccupied: () => {},
  startupPanes: {},
  onForkStalled: () => {},
  onDismissOccupied: () => {},
  specByPane: {
    "pane-1": { command: "codex", args: [], env: [] },
    "pane-2": { command: "codex", args: [], env: [] },
  },
  failedPanes: new Set<string>(),
  restartEpochs: {} as Record<string, number>,
  ...callbacks,
  ...overrides,
});

describe("DeckStage — suspended agents", () => {
  let root: Root;
  const suspended = [
    {
      ...workspaces[0],
      panes: [
        {
          ...workspaces[0].panes[0],
          idle: { reason: "suspended" as const, at: "2026-07-25T09:00:00.000Z" },
        },
        workspaces[0].panes[1],
      ],
    },
  ];

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

  const openOnlyTrayEntry = () => {
    act(() =>
      document
        .querySelector<HTMLButtonElement>(".minimized-overflow__trigger")!
        .click(),
    );
    return document.querySelector<HTMLButtonElement>(
      "[role='dialog'] .minimized--chip",
    )!;
  };

  it("keeps the stopped card in place and resumes only from its action", () => {
    render({ workspaces: suspended });
    const pane = document.querySelector<HTMLElement>("[data-pane-id='pane-1']")!;
    expect(pane.textContent).toContain("Suspended");
    expect(vi.mocked(TerminalPane).mock.calls.map((call) => call[0].paneId)).toEqual([
      "pane-2",
    ]);
    act(() => pane.querySelector<HTMLButtonElement>(".pane__card-action")!.click());
    expect(callbacks.onResumeAgent).toHaveBeenCalledWith("ws-1", "pane-1");
  });

  it("restores from the tray without resuming, then resumes from the card", () => {
    render({
      workspaces: suspended,
      viewByWs: { "ws-1": { suspendedTray: ["pane-1"] } },
    });
    expect(
      document
        .querySelector<HTMLElement>("[data-pane-id='pane-1']")!
        .classList.contains("pane--hidden"),
    ).toBe(true);
    expect(document.querySelector(".deck__tray-label")?.textContent).toBe(
      "Suspended · 1",
    );

    const trayEntry = openOnlyTrayEntry();
    expect(trayEntry.getAttribute("aria-label")).toContain("Restore");
    act(() => trayEntry.click());
    expect(callbacks.onRestoreSuspendedPane).toHaveBeenCalledWith(
      "ws-1",
      "pane-1",
    );
    expect(callbacks.onResumeAgent).not.toHaveBeenCalled();

    render({
      workspaces: suspended,
      viewByWs: { "ws-1": { select: "pane-1" } },
    });
    const pane = document.querySelector<HTMLElement>("[data-pane-id='pane-1']")!;
    expect(pane.classList.contains("pane--hidden")).toBe(false);
    expect(pane.textContent).toContain("Suspended");
    expect(document.querySelector(".deck__tray")).toBeNull();
    act(() => pane.querySelector<HTMLButtonElement>(".pane__card-action")!.click());
    expect(callbacks.onResumeAgent).toHaveBeenCalledWith("ws-1", "pane-1");
  });

  it("keeps tray placement addressable while an external resume is waking it", () => {
    const waking = [
      {
        ...workspaces[0],
        panes: [
          {
            ...workspaces[0].panes[0],
            idle: { reason: "waking" as const, origin: "manual" as const },
          },
          workspaces[0].panes[1],
        ],
      },
    ];
    render({
      workspaces: waking,
      viewByWs: { "ws-1": { suspendedTray: ["pane-1"] } },
    });

    expect(
      document
        .querySelector<HTMLElement>("[data-pane-id='pane-1']")!
        .classList.contains("pane--hidden"),
    ).toBe(true);
    expect(document.querySelector(".deck__tray-label")?.textContent).toBe(
      "Hidden · 1",
    );
    const trayEntry = openOnlyTrayEntry();
    act(() => trayEntry.click());
    expect(callbacks.onRestoreSuspendedPane).toHaveBeenCalledWith(
      "ws-1",
      "pane-1",
    );
  });

  it("does not derive tray placement from the suspended marker alone", () => {
    render({ workspaces: suspended });
    expect(
      document
        .querySelector<HTMLElement>("[data-pane-id='pane-1']")!
        .classList.contains("pane--hidden"),
    ).toBe(false);
    expect(document.querySelector(".deck__tray")).toBeNull();
  });

  it("uses hidden wording when minimized and suspended agents share the tray", () => {
    // One shelf for both: naming it Suspended would call a merely minimized
    // agent stopped, naming it Minimized would hide that one has no process.
    render({
      workspaces: suspended,
      viewByWs: {
        "ws-1": {
          minimized: ["pane-2"],
          suspendedTray: ["pane-1"],
        },
      },
    });
    expect(document.querySelector(".deck__grid-empty-title")?.textContent).toBe(
      "Every agent is hidden",
    );
    expect(document.querySelector(".deck__tray-label")?.textContent).toBe(
      "Hidden · 2",
    );
  });

  it("delegates tray restore to the dedicated transition", () => {
    render({
      workspaces: suspended,
      viewByWs: { "ws-1": { suspendedTray: ["pane-1"] } },
    });
    const trayEntry = openOnlyTrayEntry();
    act(() => trayEntry.click());
    expect(callbacks.onRestoreSuspendedPane).toHaveBeenCalledWith(
      "ws-1",
      "pane-1",
    );
    expect(callbacks.onResumeAgent).not.toHaveBeenCalled();
  });

  it("marks a durable stopped stand-in", () => {
    render({
      workspaces: suspended,
      viewByWs: { "ws-1": { minimized: ["pane-1"] } },
    });
    expect(openOnlyTrayEntry().querySelector(".minimized__stopped")).not.toBeNull();
  });

  it("leaves a running stand-in unmarked", () => {
    render({ viewByWs: { "ws-1": { minimized: ["pane-1"] } } });
    expect(openOnlyTrayEntry().querySelector(".minimized__stopped")).toBeNull();
  });

  it("does not mark a pane that is still waking", () => {
    const waking = [
      {
        ...workspaces[0],
        panes: [
          {
            ...workspaces[0].panes[0],
            idle: { reason: "waking" as const, origin: "restore" as const },
          },
          workspaces[0].panes[1],
        ],
      },
    ];
    render({
      workspaces: waking,
      viewByWs: { "ws-1": { minimized: ["pane-1"] } },
    });
    expect(openOnlyTrayEntry().querySelector(".minimized__stopped")).toBeNull();
  });

  it("marks a waking pane that is blocked on a missing folder", () => {
    const waking = [
      {
        ...workspaces[0],
        panes: [
          {
            ...workspaces[0].panes[0],
            idle: { reason: "waking" as const, origin: "restore" as const },
          },
          workspaces[0].panes[1],
        ],
      },
    ];
    render({
      workspaces: waking,
      idleBlocked: { "pane-1": "/gone/worktree" },
      viewByWs: { "ws-1": { minimized: ["pane-1"] } },
    });
    expect(openOnlyTrayEntry().querySelector(".minimized__stopped")).not.toBeNull();
  });

  it("shows only a local suspended pane's own session id", () => {
    render({ workspaces: suspended });
    expect(
      document.querySelector("[data-pane-id='pane-1'] .pane__idle-session-id")
        ?.textContent,
    ).toBe("session-1");

    render({
      workspaces: [
        {
          ...suspended[0],
          panes: [
            {
              ...suspended[0].panes[0],
              location: { kind: "remote", endpoint: "ws://vps:4500" },
            },
            suspended[0].panes[1],
          ],
        },
      ],
    });
    expect(document.querySelector(".pane__idle-session")).toBeNull();
    expect(document.body.textContent).toContain("Starts a fresh session");
  });
});
