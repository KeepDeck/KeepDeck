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

/** A dock tab, in one of two forms — by TIER, not by author choice:
 * built-in plugins (compiled with the app, trusted) contribute a React
 * component rendered in the host tree; external plugins contribute a
 * document path inside their own bundle, rendered as a sandboxed iframe
 * under the plugin's origin. The host renders whichever variant it finds. */
export type DockTabContribution =
  | {
      id: string;
      label: string;
      /** Built-in tier: rendered in the host React tree, fed `DockTabProps`. */
      Component: ComponentType<DockTabProps>;
    }
  | {
      id: string;
      label: string;
      /** External tier: a document path relative to the plugin's install
       * folder (e.g. `"ui/panel.html"`), served from the plugin's own origin
       * and shown in a sandboxed iframe. */
      iframe: string;
    };

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
