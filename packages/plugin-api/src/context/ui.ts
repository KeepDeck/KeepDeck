import type { ComponentType } from "react";
import type { Disposable } from "./disposable.ts";
import type { WorkspaceRef, WorkspaceSnapshot } from "./snapshots.ts";

/**
 * UI contributions. This is the one module of the contract that knows React:
 * a plugin without UI never imports it.
 */
export interface PluginUi {
  /** Contribute a tab to the right dock. The dock itself is host chrome —
   * it exists only while at least one tab is registered. */
  registerDockTab(tab: DockTabContribution): Disposable;
  /** Contribute a RESIDENT overlay: the host keeps it mounted for the whole
   * time the plugin is active, independent of any dock or panel state —
   * invisible until it renders something. This is how plugin functionality
   * that must outlive chrome (the Files peek waiting for an open request)
   * lives entirely in the plugin while the host provides only the slot. */
  registerOverlay(overlay: OverlayContribution): Disposable;
  /** Show or hide one of this plugin's overlays. The two tiers START
   * differently — a Component overlay is visible from mount (it self-manages
   * by rendering nothing), an iframe overlay starts hidden (a full-window
   * frame can't render "nothing"; unhidden it would also swallow clicks) —
   * and this is the one switch that moves either. An id the manifest doesn't
   * DECLARE is refused like any contribution; a declared id that isn't
   * currently registered is an inert no-op. */
  setOverlayVisible(id: string, visible: boolean): void;
  /** Contribute an icon action to the top bar's right cluster. */
  registerTopBarAction(action: TopBarActionContribution): Disposable;
  /** Contribute an icon action to every agent pane's header. FORWARD
   * SURFACE: wired through the contract and RPC but not yet rendered by the
   * host — a plausible pane-header contribution awaiting its first consumer. */
  registerPaneAction(action: PaneActionContribution): Disposable;
  /** Bring the dock into view on the ACTIVE workspace with this plugin's
   * dock tab `id` selected — the imperative entry a behavior like a file-open
   * handler needs to land its result somewhere visible. A no-op when the tab
   * isn't registered. */
  revealDockTab(id: string): void;
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

/** A resident overlay, in one of two forms — by TIER, like dock tabs:
 * built-in plugins contribute a React component rendered in the host tree
 * (no props — it reads its own plugin-internal state and renders nothing
 * while idle); external plugins contribute a document path inside their own
 * bundle, kept mounted as a sandboxed full-window iframe under the plugin's
 * origin — hidden until the plugin calls `setOverlayVisible`. */
export type OverlayContribution =
  | {
      id: string;
      /** Built-in tier: mounted-but-empty until the plugin has something to
       * show. Visible by default. */
      Component: ComponentType;
    }
  | {
      id: string;
      /** External tier: a document path relative to the plugin's install
       * folder, shown full-window when the plugin asks. Hidden by default. */
      iframe: string;
    };

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
  run(target: { workspace: WorkspaceRef; paneId: string }): void;
}
