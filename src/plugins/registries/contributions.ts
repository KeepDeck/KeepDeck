import type {
  AgentContribution,
  Disposable,
  DockTabContribution,
  FileOpenHandler,
  OverlayContribution,
  PaneActionContribution,
  SettingsSectionContribution,
  TopBarActionContribution,
} from "@keepdeck/plugin-api";

/**
 * The contribution registries — where everything a plugin registers through
 * its context lands, and where the host's React chrome reads it back. One
 * generic store, one instance per contribution kind.
 *
 * Two invariants make these safe to drive a `useSyncExternalStore` bridge and
 * to guarantee reproducible ordering:
 *
 * 1. **Insertion order is contribution order.** Entries are held in a plain
 *    array, never re-sorted; combined with the host's ordered activation this
 *    makes tab strips and action clusters deterministic run to run.
 * 2. **The snapshot is stable by reference.** `list()` returns the SAME array
 *    until a real change, a NEW array after — the exact contract React's store
 *    hook needs to avoid infinite re-render (the house idiom — a snapshot
 *    rebuilt only on real change).
 */

/** One registered entry tagged with the plugin that owns it. `pluginId` lets
 * the host attribute a contribution (settings sections need it to namespace
 * values) and lets `removeAllFor` sweep a plugin in one call. */
export interface Contribution<T> {
  readonly pluginId: string;
  readonly entry: T;
}

export interface ContributionRegistry<T> {
  /** Record `entry` for `pluginId`; the returned `Disposable` removes exactly
   * this record and is idempotent (disposing twice, or after `removeAllFor`
   * already swept it, is a harmless no-op). */
  add(pluginId: string, entry: T): Disposable;
  /** The stable snapshot for `useSyncExternalStore` — same reference until a
   * change. */
  list(): readonly Contribution<T>[];
  /** React store subscription; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Drop every entry a plugin owns at once — the belt to the context's
   * per-disposable braces, used when a plugin is forgotten wholesale. */
  removeAllFor(pluginId: string): void;
}

/**
 * Build one registry. A factory, never a module-level singleton: the host app
 * owns the instances (so tests get a fresh, isolated set and Clean
 * Architecture keeps the store injectable).
 */
export function createContributionRegistry<T>(): ContributionRegistry<T> {
  // Records carry identity so a Disposable can splice out its own by
  // reference — index math would drift as siblings come and go.
  const records: Contribution<T>[] = [];
  const listeners = new Set<() => void>();
  // Rebuilt only on real change; `list()` hands this out unchanged between
  // changes so React sees a stable snapshot.
  let snapshot: readonly Contribution<T>[] = [];

  function notify(): void {
    snapshot = records.map((record) => ({
      pluginId: record.pluginId,
      entry: record.entry,
    }));
    for (const listener of [...listeners]) listener();
  }

  function remove(record: Contribution<T>): boolean {
    const index = records.indexOf(record);
    if (index < 0) return false;
    records.splice(index, 1);
    return true;
  }

  return {
    add(pluginId, entry) {
      const record: Contribution<T> = { pluginId, entry };
      records.push(record);
      notify();
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          // Guard the notify: if `removeAllFor` already took this record, the
          // snapshot is unchanged and must keep its reference (React contract).
          if (remove(record)) notify();
        },
      };
    },
    list() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    removeAllFor(pluginId) {
      let changed = false;
      // Walk backwards so splices don't skip the neighbor of a removed entry.
      for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].pluginId === pluginId) {
          records.splice(i, 1);
          changed = true;
        }
      }
      if (changed) notify();
    },
  };
}

/**
 * The concrete registry set — one store per contribution kind the contract
 * defines. Grouped so the host threads a single object through the context
 * builder and the React hooks. `settingsSections` keeps its owning `pluginId`
 * (via `Contribution`) because the host namespaces stored values by it.
 */
export interface ContributionRegistries {
  readonly dockTabs: ContributionRegistry<DockTabContribution>;
  readonly topBarActions: ContributionRegistry<TopBarActionContribution>;
  readonly paneActions: ContributionRegistry<PaneActionContribution>;
  /** The host's file-open chain, in registration order — membership here IS
   * the whole truth of who handles file opens (no stored preference). */
  readonly fileOpeners: ContributionRegistry<FileOpenHandler>;
  /** Resident components, mounted for a plugin's whole active lifetime. */
  readonly overlays: ContributionRegistry<OverlayContribution>;
  readonly settingsSections: ContributionRegistry<SettingsSectionContribution>;
  readonly agents: ContributionRegistry<AgentContribution>;
}

export function createContributionRegistries(): ContributionRegistries {
  return {
    dockTabs: createContributionRegistry(),
    topBarActions: createContributionRegistry(),
    paneActions: createContributionRegistry(),
    fileOpeners: createContributionRegistry(),
    overlays: createContributionRegistry(),
    settingsSections: createContributionRegistry(),
    agents: createContributionRegistry(),
  };
}
