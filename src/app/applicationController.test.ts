import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../domain/commands";
import {
  initialDeckState,
  type Workspace,
} from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Notification } from "../domain/notifications";
import { createDeckStore } from "./deckStore";
import { createApplicationController } from "./applicationController";
import type { createPluginManager } from "./pluginManager";
import type { createAgentOrchestrator } from "./agentOrchestrator";
import type { PaneInputFocusPort } from "./paneInputFocusPort";
import type { PaneViewPort } from "./paneViewPort";
import { createPaneViewActions } from "../presentation/paneViewActions";

const workspace = (): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "Workspace",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [{ id: "pane-1" }, { id: "pane-2" }],
});

function dependencies() {
  const plugins = {
    bootstrapPlugins: vi.fn(async () => {}),
    revealPluginDockTab: vi.fn(() => true),
  } as unknown as ReturnType<typeof createPluginManager>;
  const orchestrator = {
    suspend: vi.fn(async () => "suspended"),
    resume: vi.fn(() => "resuming"),
    createPane: vi.fn(() => ({ kind: "created" })),
    createWorkspace: vi.fn(() => ({ ok: true })),
  } as unknown as ReturnType<typeof createAgentOrchestrator>;
  return { plugins, orchestrator };
}

function ui() {
  return {
    agents: vi.fn(() => []),
    requestCloseAgent: vi.fn(),
    openSettings: vi.fn(() => true),
    openUsage: vi.fn(() => true),
    setCreating: vi.fn(),
    pushAlert: vi.fn(),
  };
}

function paneInputFocus(): PaneInputFocusPort {
  return { requestFocus: vi.fn() };
}

function paneView(): PaneViewPort {
  return { revealPane: vi.fn() };
}

describe("application controller", () => {
  it("owns command registration and plugin bootstrap for its lifetime", async () => {
    const deck = createDeckStore();
    const registry = createCommandRegistry();
    const { plugins, orchestrator } = dependencies();
    const controller = createApplicationController(
      deck,
      plugins,
      orchestrator,
      paneInputFocus(),
      paneView(),
      registry,
    );
    const view = ui();
    controller.bindUi(view);

    controller.start();
    controller.start();
    expect(plugins.bootstrapPlugins).toHaveBeenCalledOnce();
    expect(registry.has("settings.open")).toBe(true);
    await registry.execute(
      "settings.open",
      {},
      { kind: "plugin", pluginId: "keepdeck.example" },
    );
    expect(view.openSettings).toHaveBeenCalledWith(
      "plugin:keepdeck.example",
    );

    controller.dispose();
    expect(registry.has("settings.open")).toBe(false);
  });

  it("reveals a command-addressed pane before requesting its input focus", async () => {
    const target = workspace();
    const deck = createDeckStore({
      ...initialDeckState,
      workspaces: [target],
      activeId: "ws-1",
      viewByWs: { "ws-1": { select: "pane-1", focus: "pane-1" } },
    });
    const registry = createCommandRegistry();
    const { plugins, orchestrator } = dependencies();
    const focus = paneInputFocus();
    const paneView = createPaneViewActions(deck, focus);
    const controller = createApplicationController(
      deck,
      plugins,
      orchestrator,
      focus,
      paneView,
      registry,
    );
    controller.bindUi(ui());
    controller.start();

    const result = await registry.execute(
      "agent.focus",
      { agent: "pane-2" },
      { kind: "host" },
    );

    expect(result).toEqual({
      ok: true,
      value: { workspaceId: "ws-1", paneId: "pane-2" },
    });
    expect(deck.getSnapshot().viewByWs["ws-1"]).toEqual({
      select: "pane-2",
      focus: "pane-2",
    });
    expect(focus.requestFocus).toHaveBeenCalledWith("pane-2");
  });

  it("applies pane-notification navigation in one ordered policy operation", () => {
    const target = workspace();
    const deck = createDeckStore({
      ...initialDeckState,
      workspaces: [target],
      activeId: "ws-1",
      viewByWs: {
        "ws-1": {
          select: "pane-1",
          minimized: ["pane-2"],
          suspendedTray: ["pane-2"],
        },
      },
    });
    const { plugins, orchestrator } = dependencies();
    const focus = paneInputFocus();
    const paneView = createPaneViewActions(deck, focus);
    const revealPane = vi.spyOn(paneView, "revealPane");
    const controller = createApplicationController(
      deck,
      plugins,
      orchestrator,
      focus,
      paneView,
      createCommandRegistry(),
    );
    const view = ui();
    controller.bindUi(view);
    const notification = {
      source: {
        type: "pane",
        workspace: { id: target.id, instance: target.instance },
        paneId: "pane-2",
      },
    } as Notification;

    controller.openNotification(notification);

    expect(deck.getSnapshot().viewByWs["ws-1"]).toEqual({
      select: "pane-2",
    });
    expect(view.setCreating).toHaveBeenCalledWith(false);
    expect(revealPane).toHaveBeenCalledWith("ws-1", "pane-2");
    expect(focus.requestFocus).toHaveBeenCalledWith("pane-2");
  });

  it("reports workspace-allocation failures through the bound UI", () => {
    const deck = createDeckStore();
    const { plugins, orchestrator } = dependencies();
    vi.mocked(orchestrator.createWorkspace).mockReturnValue({
      ok: false,
      reason: "sequence-exhausted",
    });
    const controller = createApplicationController(
      deck,
      plugins,
      orchestrator,
      paneInputFocus(),
      paneView(),
      createCommandRegistry(),
    );
    const view = ui();
    controller.bindUi(view);

    controller.createWorkspace({
      name: "Workspace",
      cwd: "/repo",
      worktreeBaseDir: null,
      agentType: "codex",
      count: 1,
    });

    expect(view.pushAlert).toHaveBeenCalledWith(
      "Workspace creation failed",
      expect.stringContaining("No numeric workspace ID"),
    );
  });
});
