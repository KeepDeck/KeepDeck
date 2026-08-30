import type { JournalRecords } from "../journal";
import type { WorkspaceInstance } from "../workspaceInstance";
import type { Pane, PaneSession, PaneTeam } from "./panes";
import type { DeckState } from "./reducer";
import type { Workspace } from "./workspaces";

export type DeckAction =
  | { type: "selectWorkspace"; id: string }
  | { type: "createWorkspace"; workspace: Workspace; at: string }
  | { type: "addAgentPane"; id: string; pane: Pane }
  | { type: "renameWorkspace"; id: string; name: string }
  | { type: "moveWorkspace"; id: string; toIndex: number }
  | { type: "closeAgent"; wsId: string; paneId: string; at: string }
  | { type: "closeWorkspace"; id: string; at: string }
  | { type: "toggleFocus"; wsId: string; paneId: string }
  | { type: "toggleMinimize"; wsId: string; paneId: string }
  | { type: "clearMinimized" }
  | { type: "restoreSuspendedPane"; wsId: string; paneId: string }
  | { type: "selectPane"; wsId: string; paneId: string }
  | { type: "toggleDock"; wsId: string }
  | { type: "setDockTab"; wsId: string; tabId: string }
  | { type: "renamePane"; wsId: string; paneId: string; name: string }
  | { type: "setPaneAutoTitle"; wsId: string; paneId: string; title: string }
  | {
      type: "setPaneTeam";
      wsId: string;
      paneId: string;
      /** Null takes the pane off its team. */
      team: PaneTeam | null;
    }
  | { type: "hydrate"; state: DeckState }
  | { type: "clearPaneIdle"; wsId: string; paneId: string }
  | {
      type: "suspendPane";
      wsId: string;
      paneId: string;
      at: string;
      moveToTray?: boolean;
    }
  | { type: "requestPaneWake"; wsId: string; paneId: string }
  | { type: "failPaneWake"; wsId: string; paneId: string }
  | { type: "parkPane"; wsId: string; paneId: string }
  | { type: "resetPaneLocation"; wsId: string; paneId: string }
  | {
      type: "setPaneSession";
      wsId: string;
      paneId: string;
      session: PaneSession | null;
      transcriptPath?: string;
      at: string;
    }
  | {
      type: "resolvePaneProvisioning";
      wsId: string;
      paneId: string;
      cwd: string;
      branch: string;
    }
  | {
      type: "setPaneProvisioningError";
      wsId: string;
      paneId: string;
      error: string | null;
    }
  | {
      type: "setWorkspacePluginSlot";
      wsId: string;
      workspaceInstance: WorkspaceInstance;
      pluginId: string;
      value: unknown;
    }
  | { type: "hydrateJournal"; records: JournalRecords; at: string }
  | { type: "journalFlushed"; count: number };
