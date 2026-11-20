import { describe, expect, it, vi } from "vitest";
import { createCommandRegistry } from "../domain/commands";
import {
  initialDeckState,
  type Workspace,
} from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { IntentOutcome } from "../domain/lifecycle";
import type { Notification } from "../domain/notifications";
import { intentOutcomeText } from "../presentation/lifecycleWords";
import { createDeckStore } from "./deckStore";
import { createDeckActions } from "./deckActions";
import {
  createApplicationController,
  type ApplicationOrchestrator,
  type ApplicationPlugins,
} from "./applicationController";
import type { PaneInputFocusPort } from "../presentation/paneInputFocusController";
import type { PaneViewPort } from "../presentation/paneViewActions";
import { fakeMcpLibrary } from "./mcpLibrary.fake";
import { fakeSkillsLibrary } from "./skillsLibrary.fake";
import { createPaneViewActions } from "../presentation/paneViewActions";

const workspace = (): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "Workspace",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [{ id: "pane-1", agentType: "claude" }, { id: "pane-2", agentType: "claude" }],
});

function dependencies() {
  const plugins = {
    bootstrapPlugins: vi.fn<ApplicationPlugins["bootstrapPlugins"]>(async () => {}),
    revealPluginDockTab: vi.fn<ApplicationPlugins["revealPluginDockTab"]>(() => true),
  } satisfies ApplicationPlugins;
  const accepted: IntentOutcome = { kind: "accepted", op: 1, minted: { workspace: null, team: "team-1", panes: [] } };
  const orchestrator = {
    suspend: vi.fn<ApplicationOrchestrator["suspend"]>(async () => ({ kind: "suspending" })),
    resume: vi.fn<ApplicationOrchestrator["resume"]>(async () => ({ kind: "resuming" })),
    createPane: vi.fn<ApplicationOrchestrator["createPane"]>(async () => accepted),
    createTeam: vi.fn<ApplicationOrchestrator["createTeam"]>(async () => accepted),
    retryProvisioning: vi.fn<ApplicationOrchestrator["retryProvisioning"]>(async () => accepted),
    createWorkspace: vi.fn<ApplicationOrchestrator["createWorkspace"]>(async () => accepted),
    reachOf: vi.fn<ApplicationOrchestrator["reachOf"]>(() => ({ kind: "running" })),
  } satisfies ApplicationOrchestrator;
  return { plugins, orchestrator };
}

function ui() {
  return {
    agents: vi.fn(() => []),
    requestCloseAgent: vi.fn(),
    requestDisbandTeam: vi.fn(),
    openSettings: vi.fn(() => true),
    openUsage: vi.fn(() => true),
    openTasks: vi.fn(() => true),
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

/** These cases are about registration and lifetime, not about either library
 * — each is a conduit here, and the `skills.*` / `mcp.*` sets have their own
 * suites. */
const noSkills = fakeSkillsLibrary;
const noMcp = fakeMcpLibrary;

describe("application controller", () => {
  it("owns command registration and plugin bootstrap for its lifetime", async () => {
    const deck = createDeckStore();
    const registry = createCommandRegistry();
    const { plugins, orchestrator } = dependencies();
    const controller = createApplicationController({
      deck,
      plugins,
      orchestrator,
      paneInputFocus: paneInputFocus(),
      paneView: paneView(),
      skills: noSkills(),
      mcpLibrary: noMcp(),
      registry,
      teamsIn: async () => [],
    });
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
    // A maximize lives on a team's grid, so both panes are on one team.
    const target: Workspace = {
      ...workspace(),
      teams: [{ id: "team-1", name: "team-1", location: { kind: "attached", cwd: "/repo" } }],
      panes: [
        { id: "pane-1", agentType: "claude", team: { teamId: "team-1", role: "lead" } },
        { id: "pane-2", agentType: "claude", team: { teamId: "team-1", role: "impl-1" } },
      ],
    };
    const deck = createDeckStore({
      ...initialDeckState,
      workspaces: [target],
      activeId: "ws-1",
      viewByWs: { "ws-1": { select: "pane-1", focus: ["pane-1"] } },
    });
    const registry = createCommandRegistry();
    const { plugins, orchestrator } = dependencies();
    const focus = paneInputFocus();
    const paneView = createPaneViewActions(deck, createDeckActions(deck), focus);
    const controller = createApplicationController({
      deck,
      plugins,
      orchestrator,
      paneInputFocus: focus,
      paneView,
      skills: noSkills(),
      mcpLibrary: noMcp(),
      registry,
      teamsIn: async () => [],
    });
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
      teamOpen: "team-1",
      select: "pane-2",
      focus: ["pane-2"],
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
    const paneView = createPaneViewActions(deck, createDeckActions(deck), focus);
    const revealPane = vi.spyOn(paneView, "revealPane");
    const controller = createApplicationController({
      deck,
      plugins,
      orchestrator,
      paneInputFocus: focus,
      paneView,
      skills: noSkills(),
      mcpLibrary: noMcp(),
      registry: createCommandRegistry(),
      teamsIn: async () => [],
    });
    const view = ui();
    controller.bindUi(view);
    const notification: Notification = {
      id: "n-1",
      title: "A pane",
      severity: "info",
      at: 0,
      source: {
        type: "pane",
        workspace: { id: target.id, instance: target.instance },
        paneId: "pane-2",
      },
    };

    controller.openNotification(notification);

    expect(deck.getSnapshot().viewByWs["ws-1"]).toEqual({
      select: "pane-2",
    });
    expect(view.setCreating).toHaveBeenCalledWith(false);
    expect(revealPane).toHaveBeenCalledWith("ws-1", "pane-2");
    expect(focus.requestFocus).toHaveBeenCalledWith("pane-2");
  });

  it("routes a tasks notification to its workspace and opens the dialog on the task — silently when the workspace is gone", () => {
    const target = workspace();
    const other: Workspace = { ...workspace(), id: "ws-2", instance: createWorkspaceInstance(), panes: [] };
    const deck = createDeckStore({
      ...initialDeckState,
      workspaces: [other, target],
      activeId: "ws-2",
    });
    const { plugins, orchestrator } = dependencies();
    const controller = createApplicationController({
      deck,
      plugins,
      orchestrator,
      paneInputFocus: paneInputFocus(),
      paneView: paneView(),
      skills: noSkills(),
      mcpLibrary: noMcp(),
      registry: createCommandRegistry(),
      teamsIn: async () => [],
    });
    const view = ui();
    controller.bindUi(view);

    controller.openNotification({
      id: "n-1",
      title: "A task",
      severity: "info",
      at: 0,
      source: {
        type: "tasks",
        workspace: { id: target.id, instance: target.instance },
        taskId: "task-7",
      },
    });
    expect(deck.getSnapshot().activeId).toBe("ws-1");
    expect(view.openTasks).toHaveBeenCalledWith("task-7");

    // The same id, another lifetime: the workspace this spoke of is gone.
    controller.openNotification({
      id: "n-2",
      title: "A task",
      severity: "info",
      at: 0,
      source: {
        type: "tasks",
        workspace: { id: target.id, instance: createWorkspaceInstance() },
        taskId: "task-7",
      },
    });
    expect(view.openTasks).toHaveBeenCalledTimes(1);
  });

  it("routes a stats notification to its tab, and a digest's to the week it reports", () => {
    const deck = createDeckStore({ ...initialDeckState, workspaces: [workspace()], activeId: "ws-1" });
    const { plugins, orchestrator } = dependencies();
    const controller = createApplicationController({
      deck,
      plugins,
      orchestrator,
      paneInputFocus: paneInputFocus(),
      paneView: paneView(),
      skills: noSkills(),
      mcpLibrary: noMcp(),
      registry: createCommandRegistry(),
      teamsIn: async () => [],
    });
    const view = ui();
    controller.bindUi(view);
    controller.openNotification({ id: "n-1", title: "Badge", severity: "info", at: 0, source: { type: "stats", tab: "achievements" } });
    expect(view.openUsage).toHaveBeenLastCalledWith("achievements", undefined);
    controller.openNotification({ id: "n-2", title: "Week", severity: "info", at: 0, source: { type: "stats", tab: "weekly", week: 1_000 } });
    expect(view.openUsage).toHaveBeenLastCalledWith("weekly", 1_000);
  });

  it("asks for the workspace and closes the form, and says the machine's refusal", async () => {
    const deck = createDeckStore();
    const { plugins, orchestrator } = dependencies();
    const controller = createApplicationController({
      deck,
      plugins,
      orchestrator,
      paneInputFocus: paneInputFocus(),
      paneView: paneView(),
      skills: noSkills(),
      mcpLibrary: noMcp(),
      registry: createCommandRegistry(),
      teamsIn: async () => [],
    });
    const view = ui();
    controller.bindUi(view);

    controller.createWorkspace({ name: "Workspace", cwd: "/repo", worktreeBaseDir: null });
    await Promise.resolve();

    expect(orchestrator.createWorkspace).toHaveBeenCalledWith({ name: "Workspace", cwd: "/repo", worktreeBaseDir: null });
    expect(view.setCreating).toHaveBeenCalledWith(false);
    expect(view.pushAlert).not.toHaveBeenCalled();

    // The machine's refusal is said, in its words.
    const barred: IntentOutcome = { kind: "refused", refusal: { kind: "barrierUp" } };
    orchestrator.createWorkspace.mockResolvedValueOnce(barred);
    controller.createWorkspace({ name: "Other", cwd: "/other", worktreeBaseDir: null });
    await vi.waitFor(() => expect(view.pushAlert).toHaveBeenCalledWith("Couldn't create the workspace", intentOutcomeText(barred)));
  });

  it("retries a team's worktree and says the machine's refusal, never drops it", async () => {
    const deck = createDeckStore();
    const { plugins, orchestrator } = dependencies();
    const controller = createApplicationController({
      deck,
      plugins,
      orchestrator,
      paneInputFocus: paneInputFocus(),
      paneView: paneView(),
      skills: noSkills(),
      mcpLibrary: noMcp(),
      registry: createCommandRegistry(),
      teamsIn: async () => [],
    });
    const view = ui();
    controller.bindUi(view);

    controller.retryProvisioning("ws-1", "team-1");
    await Promise.resolve();
    expect(orchestrator.retryProvisioning).toHaveBeenCalledWith("ws-1", "team-1");
    expect(view.pushAlert).not.toHaveBeenCalled();

    const leaving: IntentOutcome = { kind: "refused", refusal: { kind: "targetLeaving" } };
    orchestrator.retryProvisioning.mockResolvedValueOnce(leaving);
    controller.retryProvisioning("ws-1", "team-1");
    await vi.waitFor(() => expect(view.pushAlert).toHaveBeenCalledWith("Couldn't retry the worktree", intentOutcomeText(leaving)));
  });
});
