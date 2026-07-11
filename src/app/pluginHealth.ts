/**
 * Runtime crash reports per plugin — what turns an invisible ErrorBoundary
 * trip into a VISIBLE state: a red badge on the plugin's dock tab and a
 * failure panel (log + Restart) in its UI area. No automatic recovery, by
 * decision: a render that threw once will throw again, so the way back is
 * the user's explicit Restart — which clears this store for the plugin.
 * House-idiom external store: stable snapshot, rebuilt only on real change.
 */

export interface PluginCrash {
  pluginId: string;
  /** Which surface fell — `overlay "viewer"`, `tab "files"`. */
  surface: string;
  /** The human line plus stack when available — what "Copy log" copies. */
  detail: string;
}

const records: PluginCrash[] = [];
let snapshot: readonly PluginCrash[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  snapshot = [...records];
  for (const listener of [...listeners]) listener();
}

export function reportPluginCrash(
  pluginId: string,
  surface: string,
  error: unknown,
): void {
  records.push({ pluginId, surface, detail: detailOf(error) });
  notify();
}

/** Forget a plugin's crashes — a restart (or enable-flip) starts it clean. */
export function clearPluginCrashes(pluginId: string): void {
  let changed = false;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].pluginId === pluginId) {
      records.splice(i, 1);
      changed = true;
    }
  }
  if (changed) notify();
}

/** The stable snapshot for `useSyncExternalStore`. */
export function pluginCrashes(): readonly PluginCrash[] {
  return snapshot;
}

export function subscribePluginCrashes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}
