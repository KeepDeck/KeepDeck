import type { JournalRecords } from "../journal";
import type { WorkspaceInstance } from "../workspaceInstance";
import type { Pane, PaneSession } from "./panes";
import type { DeckState } from "./reducer";
import type { Team, TeamLocation } from "./teams/model";
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
  | { type: "restoreSuspendedPane"; wsId: string; paneId: string }
  | { type: "selectPane"; wsId: string; paneId: string }
  /** Drill into a team on the stage; the highlight lands on its members. */
  | { type: "openTeam"; wsId: string; teamId: string }
  /** Back to the workspace's team cards; nothing is highlighted there. */
  | { type: "closeTeam"; wsId: string }
  | { type: "toggleDock"; wsId: string }
  | { type: "setDockTab"; wsId: string; tabId: string }
  | { type: "renamePane"; wsId: string; paneId: string; name: string }
  | { type: "setPaneAutoTitle"; wsId: string; paneId: string; title: string }
  /** Settle a team's roster — its name and every member's role — as ONE
   * change, so no address is ever held twice and a rename moves nobody. */
  | {
      type: "settleRoster";
      wsId: string;
      teamId: string;
      name: string;
      members: readonly { paneId: string; role: string }[];
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
  | { type: "resetPaneSession"; wsId: string; paneId: string }
  | {
      type: "setPaneSession";
      wsId: string;
      paneId: string;
      session: PaneSession | null;
      transcriptPath?: string;
      at: string;
    }
  | {
      type: "setWorkspacePluginSlot";
      wsId: string;
      workspaceInstance: WorkspaceInstance;
      pluginId: string;
      value: unknown;
    }
  | { type: "hydrateJournal"; records: JournalRecords; at: string }
  | { type: "journalFlushed"; count: number }
  // The team's life — see `teams/lifecycle`. Each is the transform's
  // arguments and nothing more; the refusals live in the transform.
  | { type: "createTeam"; wsId: string; team: Team & { location: TeamLocation } }
  | {
      type: "resolveTeamProvisioning";
      wsId: string;
      teamId: string;
      cwd: string;
      branch: string;
    }
  | { type: "setTeamProvisioningError"; wsId: string; teamId: string; error: string | null }
  | { type: "renameTeam"; wsId: string; teamId: string; name: string }
  | { type: "joinTeam"; wsId: string; paneId: string; teamId: string; role: string }
  | { type: "leaveTeam"; wsId: string; paneId: string }
  | { type: "dissolveTeam"; wsId: string; teamId: string };
