import type { AgentInfo } from "../domain/agents";
import type { CommandRegistry } from "../domain/commands";
import type { SpawnConfig } from "../domain/deck";
import type { Notification } from "../domain/notifications";
import type { PaneActivity } from "../domain/status";
import type { StatsTab } from "../domain/usage/statsTabs";
import { commands } from "./commandRegistry";
import { registerCoreCommands } from "./coreCommands";
import { createDeckActions } from "./deckActions";
import { readDeck } from "./deckSurface";
import type { DeckStore } from "./deckStore";
import type { createPluginManager } from "./pluginManager";
import type { SkillsLibrary } from "./skillsLibrary";
import { openArtifactFromNotification } from "./artifacts/entryPoints";
import {
  settingsSectionForNotification,
  shouldRevealPluginDock,
  workspaceForNotification,
} from "./notificationNavigation";
import type { createAgentOrchestrator } from "./agentOrchestrator";
import type { PaneInputFocusPort } from "./paneInputFocusPort";
import type { PaneViewPort } from "./paneViewPort";

type Plugins = ReturnType<typeof createPluginManager>;
type Orchestrator = ReturnType<typeof createAgentOrchestrator>;

export interface ApplicationUi {
  agents(): AgentInfo[];
  requestCloseAgent(wsId: string, paneId: string, label: string): void;
  openSettings(sectionId: string | null): boolean;
  openUsage(tab: StatsTab | null): boolean;
  setCreating(creating: boolean): void;
  pushAlert(title: string, message: string): void;
}

export interface ApplicationController {
  start(): void;
  bindUi(ui: ApplicationUi): () => void;
  selectWorkspace(id: string): void;
  openNotification(notification: Notification): void;
  createWorkspace(config: SpawnConfig): void;
  dispose(): void;
}

const UI_UNAVAILABLE_MESSAGE = "The application UI is not available";

/**
 * Plain application-policy owner. React supplies a replaceable UI port; deck
 * transitions, command registration, bootstrap and navigation ordering remain
 * app-scoped and survive render-tree churn.
 *
 * Dependencies as an OBJECT: six positional ports, two of them small
 * method bags of similar shape, is a signature where the next insertion
 * transposes silently at a call site the compiler cannot help.
 */
export interface ApplicationControllerDeps {
  deck: DeckStore;
  plugins: Plugins;
  orchestrator: Orchestrator;
  paneInputFocus: PaneInputFocusPort;
  paneView: PaneViewPort;
  skills: SkillsLibrary;
  /** The registry to contribute the core command set to; the process-wide one
   * unless a suite wants its own. */
  registry?: CommandRegistry;
  /** What each pane's agent is doing. Defaulted to "nothing reports" so the
   * roster degrades to what it always was rather than becoming a required
   * wiring step for every caller. */
  activityOf?: (paneId: string) => PaneActivity | undefined;
}

export function createApplicationController({
  deck,
  plugins,
  orchestrator,
  paneInputFocus,
  paneView,
  skills,
  registry = commands,
  activityOf = () => undefined,
}: ApplicationControllerDeps): ApplicationController {
  const actions = createDeckActions(deck);
  let ui: ApplicationUi | null = null;
  let unregisterCommands: (() => void) | null = null;
  let started = false;
  let disposed = false;

  const requireUi = (): ApplicationUi => {
    if (!ui) throw new Error(UI_UNAVAILABLE_MESSAGE);
    return ui;
  };

  const selectWorkspace = (id: string) => {
    actions.selectWorkspace(id);
    ui?.setCreating(false);
  };

  const activatePane = (wsId: string, paneId: string) => {
    selectWorkspace(wsId);
    paneView.revealPane(wsId, paneId);
    actions.selectPane(wsId, paneId);
    paneInputFocus.requestFocus(paneId);
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      void plugins.bootstrapPlugins();
      unregisterCommands = registerCoreCommands(registry, {
        deck: () => readDeck(deck),
        agents: () => ui?.agents() ?? [],
        activityOf,
        activatePane,
        requestCloseAgent: (wsId, paneId, label) =>
          requireUi().requestCloseAgent(wsId, paneId, label),
        suspendAgent: orchestrator.suspend,
        resumeAgent: orchestrator.resume,
        createPane: orchestrator.createPane,
        openSettings: (sectionId) =>
          ui?.openSettings(sectionId) ?? false,
        openUsage: () => ui?.openUsage(null) ?? false,
        skills,
      });
    },

    bindUi(nextUi) {
      if (disposed) return () => {};
      ui = nextUi;
      return () => {
        if (ui === nextUi) ui = null;
      };
    },

    selectWorkspace,

    openNotification(notification) {
      switch (notification.source.type) {
        case "pane": {
          const { workspace, paneId } = notification.source;
          const state = deck.getSnapshot();
          const target = workspaceForNotification(
            state.workspaces,
            workspace,
          );
          if (!target) return;
          if (target.panes.some((pane) => pane.id === paneId)) {
            activatePane(target.id, paneId);
          } else {
            selectWorkspace(target.id);
          }
          return;
        }
        case "plugin": {
          const source = notification.source;
          let preciseTargetResolved = true;
          if (source.workspace !== undefined) {
            const target = workspaceForNotification(
              deck.getSnapshot().workspaces,
              source.workspace,
            );
            if (target) selectWorkspace(target.id);
            else preciseTargetResolved = false;
          }
          if (shouldRevealPluginDock(source, preciseTargetResolved)) {
            preciseTargetResolved =
              plugins.revealPluginDockTab(
                source.pluginId,
                source.dockTab,
              ) && preciseTargetResolved;
          }
          const section = settingsSectionForNotification(
            source,
            preciseTargetResolved,
          );
          if (section !== null) ui?.openSettings(section);
          return;
        }
        case "app": {
          ui?.openSettings(
            settingsSectionForNotification(notification.source),
          );
          return;
        }
        case "stats": {
          ui?.openUsage(notification.source.tab ?? null);
          return;
        }
        case "artifacts": {
          // The external destination: resolve the LIVE URL at click time
          // (identifiers only — never a stored URL) and hand it to the
          // system browser. Fallbacks and failures live in the helper:
          // dead artifactId → the workspace index; unresolvable → a
          // silent no-op, never an error dialog off a click.
          void openArtifactFromNotification(
            notification.source,
            (workspace) =>
              workspaceForNotification(
                deck.getSnapshot().workspaces,
                workspace,
              ) !== null,
          );
          return;
        }
        default: {
          const unhandled: never = notification.source;
          void unhandled;
        }
      }
    },

    createWorkspace(config) {
      const result = orchestrator.createWorkspace(config);
      if (result.ok) {
        ui?.setCreating(false);
        return;
      }
      ui?.pushAlert(
        "Workspace creation failed",
        result.reason === "sequence-exhausted"
          ? "No numeric workspace ID is available. Remove the workspace with the highest numeric ID and try again."
          : "The allocated workspace ID is already in use. Please try again.",
      );
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      ui = null;
      unregisterCommands?.();
      unregisterCommands = null;
    },
  };
}
