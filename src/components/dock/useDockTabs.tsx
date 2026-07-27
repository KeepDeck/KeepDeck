import { toWorkspaceSnapshot } from "../../app/pluginSnapshots";
import { reportPluginCrash, type PluginCrash } from "../../app/pluginHealth";
import type { Workspace } from "../../domain/deck";
import { describeError, log } from "../../ipc/log";
import { externalPluginUrl } from "../../plugins/external/url";
import type { Contribution } from "../../plugins/registries/contributions";
import type { DockTabContribution } from "@keepdeck/plugin-api";
import { ErrorBoundary } from "../../ui/ErrorBoundary";
import { PluginFailurePanel } from "./PluginFailurePanel";
import type { DockTabItem } from "./DockPanel";

/**
 * Turn the plugin registry's dock-tab contributions into the panel's tab list.
 *
 * Everything about a tab that is a POLICY rather than a rendering decision
 * lives here: which crashes badge a tab, which crashes replace its content,
 * and how each tier is mounted — a built-in as a trusted component behind an
 * error boundary, an external one as its own document at its own origin. The
 * panel below only switches between whatever it is handed; the composition
 * root above only passes the result on.
 *
 * Returns an empty list when the dock is closed or no workspace is active,
 * which is also what makes the dock disappear: it is contribution-driven
 * chrome and exists exactly while this list is non-empty.
 */
export function buildDockTabs({
  contributions,
  crashes,
  workspace,
  selectedPaneId,
  open,
}: {
  contributions: readonly Contribution<DockTabContribution>[];
  crashes: readonly PluginCrash[];
  /** The active workspace, or null when there is none. */
  workspace: Workspace | null;
  selectedPaneId: string | null;
  open: boolean;
}): DockTabItem[] {
  if (!open || !workspace) return [];
  return contributions.map((c) => {
    // Any crash badges every tab of the plugin, but the failure panel REPLACES
    // content only where the crash lives: this tab's own crash, or an
    // overlay's (shared, tab-less infrastructure — the plugin's tabs are the
    // only place its panel can live). A SIBLING tab's crash leaves this tab's
    // healthy content alone.
    const pluginCrashList = crashes.filter(
      (crash) => crash.pluginId === c.pluginId,
    );
    const panelCrashes = pluginCrashList.filter(
      (crash) =>
        crash.surfaceKind === "overlay" ||
        (crash.surfaceKind === "tab" && crash.surfaceId === c.entry.id),
    );
    return {
      id: `${c.pluginId}:${c.entry.id}`,
      label: c.entry.label,
      alert: pluginCrashList.length > 0,
      element:
        panelCrashes.length > 0 ? (
          <PluginFailurePanel
            pluginId={c.pluginId}
            label={c.entry.label}
            crashes={panelCrashes}
          />
        ) : "Component" in c.entry ? (
          // Built-in tier: a trusted React component in the host tree.
          <ErrorBoundary
            label={c.entry.label}
            onError={(e) => {
              log.error(
                `web:plugin:${c.pluginId}`,
                `dock tab "${c.entry.id}" crashed: ${describeError(e)}`,
              );
              reportPluginCrash(c.pluginId, "tab", c.entry.id, e);
            }}
          >
            <c.entry.Component
              workspace={toWorkspaceSnapshot(workspace)}
              selectedPaneId={selectedPaneId}
            />
          </ErrorBoundary>
        ) : (
          // External tier: the plugin's own document at its own kdplugin://<id>
          // origin. allow-same-origin lets it load its own scripts/assets under
          // that origin (per-plugin CSP still bounds its network); the origin —
          // cross-origin to the host — is the isolation boundary, so it can't
          // reach the host or other plugins.
          <iframe
            className="dock__plugin-frame"
            title={c.entry.label}
            sandbox="allow-scripts allow-same-origin"
            src={externalPluginUrl(c.pluginId, c.entry.iframe)}
          />
        ),
    };
  });
}
