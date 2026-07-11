import { useSyncExternalStore } from "react";
import {
  overlayVisibility,
  subscribeOverlayVisibility,
} from "../app/overlayVisibility";
import { pluginRegistries } from "../app/pluginManager";
import { describeError, log } from "../ipc/log";
import { useContributions } from "../plugins";
import { externalPluginUrl } from "../plugins/external/url";
import { ErrorBoundary } from "../ui/ErrorBoundary";

/**
 * The resident slot for plugin overlays — the host side of
 * `ui.registerOverlay`. Pure machinery: whatever a plugin contributed is
 * mounted for its whole active lifetime (registry entries dispose with the
 * plugin), each inside its own error boundary so a crashing overlay can't
 * take the deck down. The host neither knows nor cares what an overlay
 * renders. Visibility (`ui.setOverlayVisible`) toggles `hidden`, never
 * mounting: a resident's state must survive being out of sight. Defaults by
 * tier — a Component self-manages (visible), a full-window iframe cannot
 * (hidden, or it would swallow every click).
 */
export function PluginOverlays() {
  const overlays = useContributions(pluginRegistries.overlays);
  const visibility = useSyncExternalStore(
    subscribeOverlayVisibility,
    overlayVisibility,
  );
  return (
    <>
      {overlays.map((c) => {
        const key = `${c.pluginId}:${c.entry.id}`;
        const visible = visibility.get(key) ?? "Component" in c.entry;
        return (
          <ErrorBoundary
            key={key}
            label={c.entry.id}
            onError={(e) =>
              log.error(
                `web:plugin:${c.pluginId}`,
                `overlay "${c.entry.id}" crashed: ${describeError(e)}`,
              )
            }
          >
            {"Component" in c.entry ? (
              <div hidden={!visible}>
                <c.entry.Component />
              </div>
            ) : (
              // External tier: the plugin's own document, same origin isolation
              // as its dock tabs — resident (kept mounted while hidden).
              <iframe
                className="plugin-overlay__frame"
                title={c.entry.id}
                sandbox="allow-scripts allow-same-origin"
                src={externalPluginUrl(c.pluginId, c.entry.iframe)}
                hidden={!visible}
              />
            )}
          </ErrorBoundary>
        );
      })}
    </>
  );
}
