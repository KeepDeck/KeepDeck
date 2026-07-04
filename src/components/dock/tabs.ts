import type { ComponentType } from "react";
import type { WorkspaceRun } from "../../domain/runPresets";
import type { Workspace } from "../../domain/workspaces";
import { RunTab } from "./RunTab";

/** What every dock tab receives: the active workspace's context. A tab uses
 * what it needs and ignores the rest — adding a tab never widens App's
 * contract, it adds a row here. */
export interface DockTabProps {
  ws: Workspace;
  /** The active workspace's highlighted pane — e.g. the default run target. */
  selectedPaneId: string | null;
  /** Replace the workspace's run config (preset save/delete). */
  onSetRun(run: WorkspaceRun): void;
}

/** One tab of the dock panel: a nav entry plus the panel it shows. */
export interface DockTab {
  id: string;
  label: string;
  Component: ComponentType<DockTabProps>;
}

export const DOCK_TABS: readonly DockTab[] = [
  { id: "run", label: "Run", Component: RunTab },
];
