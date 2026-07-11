import { pluginRegistries } from "../app/pluginManager";
import { describeError, log } from "../ipc/log";
import { useContributions } from "../plugins";
import { ErrorBoundary } from "../ui/ErrorBoundary";

/**
 * The resident slot for plugin overlays — the host side of
 * `ui.registerOverlay`. Pure machinery: whatever a plugin contributed is
 * mounted for its whole active lifetime (registry entries dispose with the
 * plugin), each inside its own error boundary so a crashing overlay can't
 * take the deck down. The host neither knows nor cares what an overlay
 * renders; a well-behaved one is empty until it has something to show.
 */
export function PluginOverlays() {
  const overlays = useContributions(pluginRegistries.overlays);
  return (
    <>
      {overlays.map((c) => (
        <ErrorBoundary
          key={`${c.pluginId}:${c.entry.id}`}
          label={c.entry.id}
          onError={(e) =>
            log.error(
              `web:plugin:${c.pluginId}`,
              `overlay "${c.entry.id}" crashed: ${describeError(e)}`,
            )
          }
        >
          <c.entry.Component />
        </ErrorBoundary>
      ))}
    </>
  );
}
