import type { ComponentType } from "react";
import type { Disposable } from "./disposable.ts";
import type { WorkspaceSnapshot } from "./snapshots.ts";

/**
 * UI contributions. This is the one module of the contract that knows React:
 * a plugin without UI never imports it.
 */
export interface PluginUi {
  /** Contribute a tab to the right dock. The dock itself is host chrome —
   * it exists only while at least one tab is registered. */
  registerDockTab(tab: DockTabContribution): Disposable;
  /** Contribute an icon action to the top bar's right cluster. */
  registerTopBarAction(action: TopBarActionContribution): Disposable;
  /** Contribute an icon action to every agent pane's header. */
  registerPaneAction(action: PaneActionContribution): Disposable;
}

/** Built-in tier: the tab is a React component rendered in the host tree.
 * (The external tier's iframe form joins this union with the sandbox.) */
export interface DockTabContribution {
  id: string;
  label: string;
  Component: ComponentType<DockTabProps>;
}

/** What every dock tab receives — snapshots, not live state. */
export interface DockTabProps {
  workspace: WorkspaceSnapshot;
  selectedPaneId: string | null;
}

/** `title` on actions is tooltip semantics — it feeds the button's
 * `title`/`aria-label`, matching how the host's own bar icons work. */
export interface TopBarActionContribution {
  id: string;
  title: string;
  Icon?: ComponentType;
  run(): void;
}

export interface PaneActionContribution {
  id: string;
  title: string;
  Icon?: ComponentType;
  run(target: { wsId: string; paneId: string }): void;
}
