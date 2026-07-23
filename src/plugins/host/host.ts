import {
  API_VERSION,
  declaredAgentBins,
  MIN_COMPATIBLE_API_VERSION,
  satisfiesApiFloor,
  type KeepDeckPlugin,
  type PluginManifest,
} from "@keepdeck/plugin-api";
import {
  orderBySource,
  type InstalledPlugin,
  type PluginSource,
  type PluginStatus,
} from "../model/installed";
import type { ContributionRegistries } from "../registries/contributions";
import { buildPluginContext } from "./context";
import type { PluginHostDeps } from "./deps";
import { describeError } from "./errors";

/** What `install` takes: the pre-validated manifest plus a lazy loader for the
 * bundle. The host never inspects the code — the loader (another task) has
 * already validated the manifest and will produce the module; the host only
 * decides WHEN to run `load()` and owns the lifecycle around it. */
export interface PluginInstall {
  readonly manifest: PluginManifest;
  load(): Promise<KeepDeckPlugin>;
}

/** One installed plugin's live bookkeeping — the install model plus the two
 * things only the host holds: the loader and, once active, the plugin instance
 * and its cleanup handle. */
interface HostEntry {
  readonly manifest: PluginManifest;
  readonly source: PluginSource;
  readonly load: () => Promise<KeepDeckPlugin>;
  status: PluginStatus;
  /** Set while active — the module whose `deactivate` hook we owe a call. */
  plugin: KeepDeckPlugin | null;
  /** Set while active — the cascade cleanup for this activation's context. */
  disposeAll: (() => void) | null;
  /** An activation is in flight (`load()`/`activate` awaited). Guards a
   * concurrent second `activate` from double-loading, and lets the commit
   * point detect a mid-flight disable. */
  activating: boolean;
}

/**
 * The plugin host — install, activate, deactivate, enable/disable, and a
 * subscribable snapshot of what's installed.
 *
 * It owns the lifecycle and NOTHING else: the contribution registries and the
 * backend ports are injected (the app constructs and owns one host), so the
 * whole thing is driven from tests with in-memory fakes. Activation walks a
 * deterministic order (built-ins first, install order within each group) and
 * the registries record in insertion order, so contributions are reproducible
 * run to run.
 *
 * Failure is contained: a `activate` that throws mid-registration leaves the
 * plugin `failed` and its registries EMPTY — a half-activated plugin never
 * leaves residue behind. Enabled-state persistence is not the host's: it reads
 * the initial flag through a dep and reports flips back through one, keeping no
 * store of its own.
 */
export class PluginHost {
  // Insertion order == install order; ordering for activation/snapshot is
  // derived on demand via `orderBySource`, never by mutating this map.
  private readonly entries = new Map<string, HostEntry>();
  private readonly listeners = new Set<() => void>();
  // Stable snapshot for `useSyncExternalStore`; rebuilt only on real change.
  private snapshot: readonly InstalledPlugin[] = [];

  constructor(
    private readonly deps: PluginHostDeps,
    private readonly registries: ContributionRegistries,
  ) {}

  /**
   * Record a plugin as installed. Duplicate id → the LATER install is
   * rejected with a warn and the first one wins: install order decides
   * identity, deterministically, rather than a last-write race. Seeds status
   * from the enabled flag so a disabled plugin never activates on boot.
   */
  install(install: PluginInstall, source: PluginSource): void {
    const id = install.manifest.id;
    if (this.entries.has(id)) {
      this.deps
        .log(id)
        .warn(`duplicate plugin id "${id}" ignored — first install wins`);
      return;
    }
    const enabled = this.deps.isEnabled?.(id) ?? true;
    this.entries.set(id, {
      manifest: install.manifest,
      source,
      load: install.load,
      status: enabled ? { kind: "registered" } : { kind: "disabled" },
      plugin: null,
      disposeAll: null,
      activating: false,
    });
    this.notify();
  }

  /** Activate every eligible plugin in deterministic order. Sequential on
   * purpose: contribution order must match activation order, which a parallel
   * `Promise.all` would scramble. */
  async activateAll(): Promise<void> {
    for (const entry of orderBySource([...this.entries.values()])) {
      await this.activate(entry.manifest.id);
    }
  }

  /**
   * Activate one plugin. No-op if already active (idempotent) or disabled
   * (stays off). Gates on the API floor BEFORE loading any code: too-new a
   * `minApiVersion` → `failed` with a reason naming both versions. Then
   * `load()` and `activate` run in one try/catch — ANY throw disposes whatever
   * got registered before it and marks the plugin `failed`, so a partial
   * activation leaves zero residue.
   */
  async activate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.status.kind === "active" || entry.status.kind === "disabled") {
      return;
    }
    // A second activate while `load()` is awaited would double-register every
    // contribution; the first flight owns the outcome.
    if (entry.activating) return;

    if (!satisfiesApiFloor(entry.manifest.minApiVersion)) {
      this.fail(
        entry,
        `needs plugin API ${entry.manifest.minApiVersion}, host supports ${MIN_COMPATIBLE_API_VERSION}..${API_VERSION}`,
      );
      return;
    }

    // The centralized availability gate: an agent plugin whose declared
    // binary is not installed on this machine never runs its code. One rule
    // for every agent — each plugin only declares `bin` in its manifest.
    const missingBin = declaredAgentBins(entry.manifest).find(
      (bin) => !(this.deps.isAgentBinInstalled?.(bin) ?? true),
    );
    if (missingBin !== undefined) {
      entry.plugin = null;
      entry.disposeAll = null;
      entry.status = {
        kind: "unavailable",
        reason: `agent "${missingBin}" is not installed`,
      };
      this.notify();
      return;
    }

    // Built before load so a throwing loader still has a (no-op) cleanup.
    const { ctx, disposeAll } = buildPluginContext(
      entry.manifest,
      entry.source,
      this.registries,
      this.deps,
    );
    entry.activating = true;
    try {
      const plugin = await entry.load();
      await plugin.activate(ctx);
      if (wasDisabledMidFlight(entry) || this.entries.get(id) !== entry) {
        // Disabled OR uninstalled while load()/activate were in flight —
        // committing would resurrect what the user just removed. Unwind the
        // fresh activation and leave the removal in force.
        if (plugin.deactivate) {
          try {
            await plugin.deactivate();
          } catch (error) {
            this.deps
              .log(id)
              .error(`deactivate hook failed: ${describeError(error)}`);
          }
        }
        disposeAll();
      } else {
        entry.plugin = plugin;
        entry.disposeAll = disposeAll;
        entry.status = { kind: "active" };
        this.notify();
      }
    } catch (error) {
      disposeAll();
      this.fail(entry, describeError(error));
    } finally {
      entry.activating = false;
    }

    // A re-enable that landed DURING the unwind above (its `activate` no-op'd
    // on the `activating` guard) leaves the entry `registered` (enabled) but
    // inactive. Now that the guard is clear, honor it — the plugin the user
    // last asked to be on gets activated. Terminal either way (active/failed),
    // so this settles, it doesn't loop.
    const settled = this.entries.get(id);
    if (settled === entry && settled.status.kind === "registered") {
      await this.activate(id);
    }
  }

  /** Deactivate an active plugin: run its `deactivate` hook, then the cascade
   * cleanup, and rest at `registered`. No-op on anything not active. */
  async deactivate(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.status.kind !== "active") return;
    await this.teardown(entry);
    entry.status = { kind: "registered" };
    this.notify();
  }

  /**
   * Turn a plugin on or off. Disabling an active plugin tears it down
   * immediately; enabling a disabled one activates it. A no-op when the flag
   * already matches (a `failed` plugin counts as enabled — disabling then
   * re-enabling is how a user retries it). Flips are reported through the dep
   * so the owner persists them; the host keeps no enabled store.
   */
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const currentlyEnabled = entry.status.kind !== "disabled";
    if (currentlyEnabled === enabled) return;

    if (enabled) {
      // Fresh detection before the gate, so "installed the CLI, then flipped
      // the toggle" activates without an app restart.
      const bins = declaredAgentBins(entry.manifest);
      if (bins.length > 0) await this.deps.refreshAgentBins?.(bins);
      // Re-check after the await: while suspended, a concurrent enable may
      // have owned the flip and activated already — proceeding would clobber
      // its `active` back to `registered` and double-register everything.
      if (entry.status.kind !== "disabled") return;
      entry.status = { kind: "registered" };
      this.deps.onEnabledChanged?.(id, true);
      this.notify();
      await this.activate(id);
    } else {
      if (entry.status.kind === "active") await this.teardown(entry);
      entry.status = { kind: "disabled" };
      this.deps.onEnabledChanged?.(id, false);
      this.notify();
    }
  }

  /**
   * Forget a plugin entirely — the runtime unload behind a rescan that found
   * its file gone, or an explicit uninstall. Tears an active instance down
   * first; the entry leaves the map, so a later install of the same id is a
   * fresh registration. Persisted data (workspace slots, settings values)
   * deliberately survives — reinstalling must not start from amnesia.
   */
  async uninstall(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.status.kind === "active") await this.teardown(entry);
    this.entries.delete(id);
    this.notify();
  }

  /**
   * Deactivate and activate again — the runtime restart. For external
   * plugins the loader hands out realm-backed instances, so a restart is a
   * full code reload; a BUILT-IN restarts its state only (its code ships
   * with the app bundle — new built-in code arrives with an app update).
   * No-op unless currently active.
   */
  async restart(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.status.kind !== "active") return;
    await this.deactivate(id);
    await this.activate(id);
  }

  /** The installed-plugins snapshot for the Experiments UI — stable between
   * changes, a new reference after each one (the `useSyncExternalStore`
   * contract). Bound so it can be passed to the hook by reference. */
  readonly getInstalled = (): readonly InstalledPlugin[] => this.snapshot;

  /** Subscribe to installed-plugin changes. Bound for the same reason. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Run a plugin's `deactivate` hook (tolerating a throw) then its cascade
   * cleanup. The cleanup runs even if the hook threw — a bad hook must not
   * leak the plugin's contributions. Clears the live handles either way. */
  private async teardown(entry: HostEntry): Promise<void> {
    const { plugin, disposeAll } = entry;
    entry.plugin = null;
    entry.disposeAll = null;
    if (plugin?.deactivate) {
      try {
        await plugin.deactivate();
      } catch (error) {
        this.deps
          .log(entry.manifest.id)
          .error(`deactivate hook failed: ${describeError(error)}`);
      }
    }
    disposeAll?.();
  }

  /** Mark an entry failed with a reason, clear any live handles, log it, and
   * publish. The single path to `failed` so the reason is always recorded. */
  private fail(entry: HostEntry, reason: string): void {
    entry.plugin = null;
    entry.disposeAll = null;
    entry.status = { kind: "failed", reason };
    this.deps.log(entry.manifest.id).error(`activation failed: ${reason}`);
    this.notify();
  }

  private notify(): void {
    this.snapshot = orderBySource(
      [...this.entries.values()].map(
        (entry): InstalledPlugin => ({
          manifest: entry.manifest,
          source: entry.source,
          status: entry.status,
        }),
      ),
    );
    for (const listener of [...this.listeners]) listener();
  }
}

/** Whether `setEnabled(false)` flipped the entry while `load()`/`activate`
 * were awaited. A function boundary on purpose: inline, TS's control-flow
 * narrowing from the pre-await guard makes the comparison "impossible". */
function wasDisabledMidFlight(entry: { status: PluginStatus }): boolean {
  return entry.status.kind === "disabled";
}
