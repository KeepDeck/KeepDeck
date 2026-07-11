// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  onStartWorkspace: vi.fn(),
  onSelectPane: vi.fn(),
  onToggleFocus: vi.fn(),
  onToggleMinimize: vi.fn(),
  onOpenInEditor: vi.fn(),
  onCloseAgent: vi.fn(),
  onRenamePane: vi.fn(),
  onPaneTitle: vi.fn(),
  onStartFresh: vi.fn(),
  onRetryProvision: vi.fn(),
  onAgentExited: vi.fn(),
  onRestartAgent: vi.fn(() => Promise.resolve()),
};

const props = (overrides: Record<string, unknown> = {}) => ({
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
      installed: true,
      path: null,
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

    act(() => terminalProps("pane-1").onExit?.(0));
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
    act(() => terminalProps("pane-1").onExit?.(1));

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
});
