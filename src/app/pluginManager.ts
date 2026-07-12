import { invoke } from "@tauri-apps/api/core";
import {
  readManifest,
  type Disposable,
  type KeepDeckPlugin,
  type PluginCategory,
  type PluginManifest,
} from "@keepdeck/plugin-api";
import {
  createContributionRegistries,
  PluginHost,
  type PluginInstall,
} from "../plugins";
import {
  createCapabilityGate,
  type FsScope,
  type ServiceBackends,
} from "../plugins/capabilities";
import {
  onProjectFsChange,
  projectFsReadDir,
  projectFsReadFile,
  projectFsUnwatch,
  projectFsWatch,
} from "../ipc/projectFs";
import {
  onProjectGitChange,
  projectGitBranches,
  projectGitChangedFiles,
  projectGitDiffFile,
  projectGitHistory,
  projectGitStatus,
  projectGitUnwatch,
  projectGitWatch,
} from "../ipc/projectGit";
import { enabledByPolicy } from "../plugins/host/enabledPolicy";
import { makeExternalPlugin } from "../plugins/external/realmPlugin";
import { capabilityFingerprint } from "../plugins/external/consent";
import { openPath, openUrl } from "../ipc/app";
import { describeError, log } from "../ipc/log";
import { allocatePorts } from "../ipc/ports";
import { scanPlugins } from "../ipc/plugins";
import { spawnSession } from "../ipc/session";
import { DEFAULT_SETTINGS } from "../domain/settings";
import { getSettings, subscribeSettings, updateSettings } from "./settingsManager";
import { makeGlobalKvStub, makeWorkspaceKv, type DeckAccess } from "./pluginKv";
import { ensurePluginStylesheet } from "./pluginStylesheets";
import { clearOverlayVisibility, setOverlayVisibility } from "./overlayVisibility";
import { clearPluginCrashes } from "./pluginHealth";
import { mergeSectionValues } from "./pluginSettingsValues";

/**
 * The owner of the plugin system — one per app, outside React, like
 * `settingsManager` and `ptyManager`. It constructs the contribution
 * registries and the `PluginHost`, supplies every port the host needs
 * (storage over the deck, settings values over `settingsManager`, deck
 * events, capability-gated platform services, the namespaced log), and boots
 * the built-in plugins. React reads through the `useContributions` /
 * `useInstalledPlugins` bridges; the deck side is wired late by
 * `usePluginDeckBridge` because the deck lives inside React.
 */

export const pluginRegistries = createContributionRegistries();

// ------------------------------------------------------------- deck access

/** Late-bound deck accessors (see `DeckAccess`). Until the bridge wires them
 * (first App render), workspace storage answers as an empty deck — plugins
 * only touch storage from interactions, which require a mounted App. */
let deckAccess: DeckAccess = {
  workspaces: () => [],
  setPluginSlot: () => {},
};

export function wireDeckAccess(access: DeckAccess): void {
  deckAccess = access;
}

// The indirection keeps KV instances valid across re-wires.
const liveDeckAccess: DeckAccess = {
  workspaces: () => deckAccess.workspaces(),
  setPluginSlot: (wsId, pluginId, value) =>
    deckAccess.setPluginSlot(wsId, pluginId, value),
};

/** The deck's UI actions, late-bound like `DeckAccess` but a SEPARATE port:
 * the KV factories consume DeckAccess as a storage port and must not be
 * handed UI powers they never use. */
export interface DeckUiAccess {
  /** Open the dock on the ACTIVE workspace with `tabId` selected — the host
   * side of `ctx.ui.revealDockTab` (tabId is the full `pluginId:entryId`). */
  revealDockTab(tabId: string): void;
}

let deckUi: DeckUiAccess = { revealDockTab: () => {} };

export function wireDeckUi(ui: DeckUiAccess): void {
  deckUi = ui;
}

// ------------------------------------------------------------- deck events

type Listener<E> = (event: E) => void;

function channel<E>() {
  const listeners = new Set<Listener<E>>();
  return {
    on(cb: Listener<E>): Disposable {
      listeners.add(cb);
      return {
        dispose() {
          listeners.delete(cb);
        },
      };
    },
    emit(event: E): void {
      for (const cb of [...listeners]) cb(event);
    },
  };
}

const workspaceClosed = channel<{ wsId: string }>();
const paneSelected = channel<{ wsId: string; paneId: string | null }>();
const deckChanged = channel<void>();

/** Fired by the deck bridge (`usePluginDeckBridge`) — not exported to
 * plugins; they subscribe through their context, which tracks disposal. */
export const pluginDeckEvents = {
  emitWorkspaceClosed: (e: { wsId: string }) => workspaceClosed.emit(e),
  emitPaneSelected: (e: { wsId: string; paneId: string | null }) =>
    paneSelected.emit(e),
  emitDeckChanged: () => deckChanged.emit(),
};

// ------------------------------------------------------------------ ports

function loggerFor(pluginId: string) {
  return {
    info: (m: string) => log.info(`web:plugin:${pluginId}`, m),
    warn: (m: string) => log.warn(`web:plugin:${pluginId}`, m),
    error: (m: string) => log.error(`web:plugin:${pluginId}`, m),
  };
}

/** The folders a `workspace`-scoped `fs` call may reach: every open
 * workspace's cwd plus each of its panes' worktree cwds — the live "workspace
 * folder and its panes' worktrees" the capability's scope names, read fresh
 * per call so a just-opened workspace is reachable at once. `everywhere` needs
 * none (the Rust side skips containment). */
function fsRoots(scope: FsScope): string[] {
  if (scope === "everywhere") return [];
  const roots = new Set<string>();
  for (const ws of liveDeckAccess.workspaces()) {
    if (ws.cwd) roots.add(ws.cwd);
    for (const pane of ws.panes) {
      if (pane.cwd) roots.add(pane.cwd);
    }
  }
  return [...roots];
}

// ---- path watching (one OS listener, fanned out by path) ----

/** Build a path-watch fan-out over one backend watcher family (fs dirs, git
 * repos): one Rust watcher per path (started on the first subscriber, stopped
 * after the last), fanned out to every callback watching it — so two panes
 * browsing the same folder share one OS watcher. The single subscription to
 * the backend's change event attaches lazily on first use. */
function makeWatchFanout(backend: {
  label: string;
  subscribe: (handler: (path: string) => void) => Promise<() => void>;
  start: (path: string, roots: string[], everywhere: boolean) => Promise<void>;
  stop: (path: string) => Promise<void>;
}) {
  const watchCbs = new Map<string, Set<() => void>>();
  let changeListener: Promise<() => void> | null = null;

  return function watchPath(
    path: string,
    scope: FsScope,
    onChange: () => void,
  ): Disposable {
    changeListener ??= backend
      .subscribe((changed) => {
        const cbs = watchCbs.get(changed);
        if (cbs) for (const cb of [...cbs]) cb();
      })
      .catch((e) => {
        log.warn(
          "web:plugins",
          `${backend.label} change listener failed: ${describeError(e)}`,
        );
        return () => {};
      });

    let set = watchCbs.get(path);
    if (!set) {
      set = new Set();
      watchCbs.set(path, set);
      void backend.start(path, fsRoots(scope), scope === "everywhere").catch((e) =>
        log.warn(
          "web:plugins",
          `${backend.label} watch ${path} failed: ${describeError(e)}`,
        ),
      );
    }
    set.add(onChange);

    let live = true;
    return {
      dispose() {
        if (!live) return;
        live = false;
        const current = watchCbs.get(path);
        if (!current) return;
        current.delete(onChange);
        if (current.size === 0) {
          watchCbs.delete(path);
          void backend.stop(path).catch(() => {});
        }
      },
    };
  };
}

const watchProjectDir = makeWatchFanout({
  label: "fs",
  subscribe: onProjectFsChange,
  start: projectFsWatch,
  stop: projectFsUnwatch,
});

const watchProjectGit = makeWatchFanout({
  label: "git",
  subscribe: onProjectGitChange,
  start: projectGitWatch,
  stop: projectGitUnwatch,
});

/** The ungated platform services — what the capability gate decorates. `fs`
 * is scope-aware here (the gate injects the scope it derived from the
 * manifest); this backend turns that scope into concrete roots. */
const serviceBackend: ServiceBackends = {
  sessions: {
    async spawn(opts, onEvent) {
      return spawnSession(
        {
          command: opts.command ?? null,
          args: opts.args ?? [],
          env: opts.env ?? [],
          cwd: opts.cwd ?? null,
          cols: opts.cols,
          rows: opts.rows,
        },
        (event) => {
          if (event.type === "output") {
            onEvent({ type: "output", bytes: new Uint8Array(event.bytes) });
          } else {
            onEvent({ type: "exit", code: event.code });
          }
        },
      );
    },
  },
  ports: { allocate: (key) => allocatePorts(key) },
  opener: {
    openUrl: (url) => openUrl(url),
    openPath: (path) => openPath(path),
  },
  fs: {
    readDir: (path, scope) =>
      projectFsReadDir(path, fsRoots(scope), scope === "everywhere"),
    readFile: (path, scope, opts) =>
      projectFsReadFile(path, fsRoots(scope), scope === "everywhere", opts?.maxBytes),
    watch: (path, scope, onChange) => watchProjectDir(path, scope, onChange),
  },
  git: {
    status: (repo, scope) =>
      projectGitStatus(repo, fsRoots(scope), scope === "everywhere"),
    diffFile: (repo, file, scope, opts) =>
      projectGitDiffFile(
        repo,
        fsRoots(scope),
        scope === "everywhere",
        file,
        opts?.staged ?? false,
        opts?.from,
        opts?.to,
      ),
    history: (repo, scope, opts) =>
      projectGitHistory(
        repo,
        fsRoots(scope),
        scope === "everywhere",
        opts?.base,
        opts?.limit,
        opts?.rev,
      ),
    branches: (repo, scope) =>
      projectGitBranches(repo, fsRoots(scope), scope === "everywhere"),
    changedFiles: (repo, from, to, scope) =>
      projectGitChangedFiles(repo, fsRoots(scope), scope === "everywhere", from, to),
    watch: (repo, scope, onChange) => watchProjectGit(repo, scope, onChange),
  },
};

export const pluginHost = new PluginHost(
  {
    storage: (pluginId) => ({
      workspace: (wsId) => makeWorkspaceKv(liveDeckAccess, pluginId, wsId),
      global: makeGlobalKvStub((m) => loggerFor(pluginId).warn(m)),
    }),
    settings: (pluginId) => ({
      read: async () => readPluginValues(pluginId),
      onChange: (cb) => {
        // Fire only when this plugin's effective values actually changed —
        // the settings store notifies on every app-settings write.
        let last = JSON.stringify(readPluginValues(pluginId));
        const unsubscribe = subscribeSettings(() => {
          const next = readPluginValues(pluginId);
          const fingerprint = JSON.stringify(next);
          if (fingerprint === last) return;
          last = fingerprint;
          cb(next);
        });
        return { dispose: unsubscribe };
      },
    }),
    events: {
      onWorkspaceClosed: (cb) => workspaceClosed.on(cb),
      onPaneSelected: (cb) => paneSelected.on(cb),
      onDeckChanged: (cb) => deckChanged.on(cb),
    },
    services: (manifest, source) =>
      createCapabilityGate(manifest, serviceBackend, {
        // A trusted built-in warns on an undeclared call (a bug to fix); an
        // untrusted external plugin is refused (enforce) — the manifest's
        // declaration is the boundary the user consented to.
        mode: source === "external" ? "enforce" : "warn",
        log: loggerFor(manifest.id),
      }),
    resources: (manifest, source) => ({
      async path(relative: string) {
        // Plain /-separated segments only — a resource name, not a path
        // expression. (The dev candidate's own ../ prefix is OURS, below.)
        const segments = relative.split("/");
        if (
          segments.some((seg) => seg === "" || seg === "." || seg === "..") ||
          relative.startsWith("/")
        ) {
          loggerFor(manifest.id).warn(`resources.path: rejected "${relative}"`);
          return null;
        }
        if (source === "external") {
          // Resolved inside the plugin's install folder (dev folders in
          // place; archive entries materialized to disk) with the same
          // source resolution as its file serving.
          return invoke<string | null>("plugin_external_resource_path", {
            id: manifest.id,
            relative,
          }).catch(() => null);
        }
        // Built-in: the built plugin dirs ship as real files under the
        // app's Resource dir — in a bundle AND in dev (tauri copies the
        // configured resources next to the debug binary at dev start, so
        // this path resolves identically in both modes; a dev copy is a
        // snapshot of dist/, refreshed by `pnpm build`).
        return invoke<string | null>("plugin_resource_path", {
          path: `plugins/${manifest.id}/resources/${relative}`,
        }).catch(() => null);
      },
    }),
    ui: {
      // Dock tab ids are namespaced `pluginId:entryId` — the same shape App
      // builds when rendering the tab strip. The contract says "a no-op when
      // the tab isn't registered": honored HERE, against the registry —
      // otherwise the dock would open onto DockPanel's first-tab fallback
      // (or onto nothing at all, leaving a phantom open flag).
      revealDockTab: (pluginId, entryId) => {
        const registered = pluginRegistries.dockTabs
          .list()
          .some((c) => c.pluginId === pluginId && c.entry.id === entryId);
        if (registered) deckUi.revealDockTab(`${pluginId}:${entryId}`);
      },
      setOverlayVisible: (pluginId, entryId, visible) =>
        setOverlayVisibility(`${pluginId}:${entryId}`, visible),
    },
    log: loggerFor,
    hostFacts: {
      // The whitelisted read-only host facts (see PluginHostFacts): grown a
      // field at a time when a real plugin needs one.
      settings: async () => ({
        terminalScrollback:
          getSettings()?.scrollback ?? DEFAULT_SETTINGS.scrollback,
      }),
    },
    isEnabled: (pluginId) => {
      const stored = getSettings()?.plugins.enabled[pluginId];
      const external = externalPlugins.get(pluginId);
      if (external) {
        // Externals are opt-in AND need CURRENT consent: an update that
        // escalated capabilities no longer matches the recorded fingerprint,
        // so it drops back to off until the user consents again.
        if (stored !== true) return false;
        const consented = getSettings()?.plugins.consented[pluginId];
        return consented === capabilityFingerprint(external.manifest);
      }
      // Built-ins resolve through the default policy: cli agents ON unless
      // explicitly turned off, deck plugins opt-in (user decisions,
      // 2026-07-06 opt-in / 2026-07-11 cli override).
      return enabledByPolicy(
        stored,
        "builtin",
        builtinCategories.get(pluginId) ?? "deck",
      );
    },
    onEnabledChanged: (pluginId, enabled) => {
      // Either flip is a fresh start for the plugin's surfaces — stale crash
      // reports must not paint a just-re-enabled plugin as broken, and stale
      // visibility must not bring its overlays back over the window.
      clearPluginCrashes(pluginId);
      clearOverlayVisibility(pluginId);
      const plugins = getSettings()?.plugins ?? {
        enabled: {},
        values: {},
        consented: {},
      };
      const external = externalPlugins.get(pluginId);
      updateSettings({
        plugins: {
          ...plugins,
          enabled: { ...plugins.enabled, [pluginId]: enabled },
          // Enabling an external plugin records consent for its CURRENT
          // capabilities — that receipt is what a later update is checked
          // against. Disabling leaves the old receipt untouched (harmless).
          consented:
            enabled && external
              ? {
                  ...plugins.consented,
                  [pluginId]: capabilityFingerprint(external.manifest),
                }
              : plugins.consented,
        },
      });
    },
  },
  pluginRegistries,
);

/** Built-in plugins' categories, recorded at install — `isEnabled(id)` is a
 * narrow port and needs the category to resolve the default policy. */
const builtinCategories = new Map<string, PluginCategory>();

// ----------------------------------------------------- external discovery

/** The currently-installed EXTERNAL plugins, keyed by id: the manifest (the
 * host contract exposes only `isEnabled(id)`/`onEnabledChanged(id)`, so this
 * is how those closures recover the manifest for the consent fingerprint) and
 * whether it came from an unpacked DEV folder rather than a `.kdplugin`. Kept
 * in lockstep with what's installed as external. */
const externalPlugins = new Map<
  string,
  { manifest: PluginManifest; dev: boolean; sig: string }
>();

/** External-plugin facts the settings UI needs: whether an id is external
 * (its capabilities need consent) and whether it's a dev-folder install (a
 * badge). `undefined` for a built-in. */
export function externalPluginInfo(
  pluginId: string,
): { dev: boolean } | undefined {
  const entry = externalPlugins.get(pluginId);
  return entry ? { dev: entry.dev } : undefined;
}

function readPluginValues(pluginId: string): Record<string, unknown> {
  const section = pluginRegistries.settingsSections
    .list()
    .find((c) => c.pluginId === pluginId)?.entry;
  return mergeSectionValues(section, getSettings()?.plugins.values[pluginId]);
}

// -------------------------------------------------------------- bootstrap

let boot: Promise<void> | null = null;

/**
 * Discover and start the built-in plugins, once (idempotent, like
 * `initSettings`). Discovery differs by mode on purpose (see the loader
 * spike): in production the import map resolves a bundle's bare specifiers,
 * so plugins load as prebuilt ESM from `dist/plugins/`; in dev WebKit
 * rejects the late import map, so plugins load from SOURCE through Vite,
 * which resolves the same specifiers itself.
 */
export function bootstrapPlugins(): Promise<void> {
  boot ??= (async () => {
    const builtins = import.meta.env.DEV
      ? discoverDevPlugins()
      : await discoverBuiltPlugins();
    for (const install of builtins) {
      builtinCategories.set(install.manifest.id, install.manifest.category);
      pluginHost.install(install, "builtin");
    }
    await syncExternalPlugins();
    await pluginHost.activateAll();
    // The one boot line that says the system came up — failures are logged
    // per plugin by the host, so silence here would hide a healthy boot.
    const states = pluginHost
      .getInstalled()
      .map((p) => `${p.manifest.id}=${p.status.kind}`);
    log.info("web:plugins", `bootstrap: ${states.join(", ") || "no plugins"}`);
  })().catch((e) => {
    log.error("web:plugins", `bootstrap failed: ${describeError(e)}`);
  });
  return boot;
}

/**
 * Re-read the plugins folder and reconcile the installed external plugins to
 * what's on disk — the manual "Rescan" (KeepDeck does not watch the folder,
 * by decision). A container that appeared installs (disabled until consent, or
 * activating if already consented); one that vanished is uninstalled (its
 * realms and sessions die, its stored data survives); one whose manifest
 * changed reloads (new code, and new capabilities re-gate consent). A plugin
 * that DIDN'T change is left completely alone — a no-op rescan touches
 * nothing, so it never churns the UI. Built-ins are untouched.
 */
export async function rescanPlugins(): Promise<void> {
  if (await syncExternalPlugins()) await pluginHost.activateAll();
}

/** Restart one installed plugin (Settings → a plugin's page, or the failure
 * panel). External plugins reload their code; built-ins restart their state.
 * Crash reports clear FIRST: the restarted plugin starts visibly clean, and
 * a crash during the restart itself reports fresh. */
export async function restartPlugin(pluginId: string): Promise<void> {
  clearPluginCrashes(pluginId);
  clearOverlayVisibility(pluginId);
  await pluginHost.restart(pluginId);
}

/**
 * Reconcile installed external plugins to the scan by DIFF — uninstall the
 * gone, install the new, reload only those whose manifest changed, and touch
 * nothing else. Returns whether anything changed (so the caller can skip a
 * needless `activateAll`). Idempotent; both boot and Rescan call it.
 *
 * A dev plugin whose CODE changed but whose manifest didn't is deliberately
 * not reloaded here (the signature is the manifest) — use its Restart for
 * that; a folder rescan shouldn't restart every dev plugin on every click.
 */
async function syncExternalPlugins(): Promise<boolean> {
  let records: Awaited<ReturnType<typeof scanPlugins>>;
  try {
    records = await scanPlugins();
  } catch (e) {
    log.warn("web:plugins", `plugin scan failed: ${describeError(e)}`);
    return false;
  }

  // What's on disk now, first-id-wins (dev over archive is the scan's order).
  const scanned = new Map<
    string,
    { manifest: PluginManifest; dev: boolean; sig: string }
  >();
  for (const record of records) {
    const manifest = validate(record.dirName, safeJson(record.manifestJson));
    if (!manifest || scanned.has(manifest.id)) continue;
    scanned.set(manifest.id, {
      manifest,
      dev: record.source === "dev",
      sig: JSON.stringify(manifest),
    });
  }

  let changed = false;

  // Gone: installed external ids no longer on disk. Their runtime residue
  // (crash reports, overlay visibility) goes with them — a later reinstall
  // under the same id must start clean.
  for (const id of [...externalPlugins.keys()]) {
    if (!scanned.has(id)) {
      externalPlugins.delete(id);
      await pluginHost.uninstall(id);
      clearPluginCrashes(id);
      clearOverlayVisibility(id);
      changed = true;
    }
  }

  // New or changed: install fresh, reload on a manifest change, skip unchanged.
  for (const [id, next] of scanned) {
    const current = externalPlugins.get(id);
    if (current && current.sig === next.sig) continue; // unchanged — leave it
    if (current) await pluginHost.uninstall(id); // changed — reload its code
    externalPlugins.set(id, next);
    pluginHost.install(
      { manifest: next.manifest, load: async () => makeExternalPlugin(next.manifest) },
      "external",
    );
    changed = true;
  }

  return changed;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Dev: every `plugins/<dir>/manifest.json` in the workspace, entries loaded
 * from source through Vite. Both globs are dev-only dead code in the built
 * bundle (`bootstrapPlugins` never reaches them there). */
function discoverDevPlugins(): PluginInstall[] {
  const manifests = import.meta.glob("/plugins/*/manifest.json", {
    eager: true,
    import: "default",
  });
  const entries = import.meta.glob("/plugins/*/src/index.{ts,tsx}");
  const installs: PluginInstall[] = [];
  for (const [path, raw] of Object.entries(manifests)) {
    const manifest = validate(path, raw);
    if (!manifest) continue;
    const dir = path.slice(0, -"/manifest.json".length);
    const entryKey = Object.keys(entries).find((key) =>
      key.startsWith(`${dir}/src/index.`),
    );
    if (!entryKey) {
      log.error("web:plugins", `${dir}: no src/index.ts(x) entry — skipped`);
      continue;
    }
    installs.push({
      manifest,
      load: () => entries[entryKey]().then(defaultExport),
    });
  }
  return installs;
}

/** Production: `dist/plugins/index.json` (written by scripts/build-plugins)
 * names each prebuilt bundle; manifests are fetched, bundles dynamically
 * imported — computed URLs, same origin, resolved via the import map. An
 * entry flagged `css: true` carries the second half of its bundle, the
 * emitted `index.css` — linked alongside the module import (awaited, so the
 * tab never renders before its styles) the first time the plugin loads. */
async function discoverBuiltPlugins(): Promise<PluginInstall[]> {
  let index: { plugins: { id: string; dir: string; css?: boolean }[] };
  try {
    index = await (await fetch("/plugins/index.json")).json();
  } catch {
    // A build without the plugins step (or a dev preview) simply has none.
    log.warn("web:plugins", "no plugins index — starting without plugins");
    return [];
  }
  const installs: PluginInstall[] = [];
  for (const { dir, css } of index.plugins) {
    try {
      const raw = await (await fetch(`/${dir}/manifest.json`)).json();
      const manifest = validate(dir, raw);
      if (!manifest) continue;
      installs.push({
        manifest,
        load: async () => {
          const [module] = await Promise.all([
            import(/* @vite-ignore */ `/${dir}/index.js`),
            css
              ? ensurePluginStylesheet(
                  manifest.id,
                  `/${dir}/index.css`,
                  loggerFor(manifest.id).warn,
                )
              : null,
          ]);
          return defaultExport(module);
        },
      });
    } catch (e) {
      log.error("web:plugins", `${dir}: unreadable — ${describeError(e)}`);
    }
  }
  return installs;
}

function validate(source: string, raw: unknown): PluginManifest | null {
  const result = readManifest(raw);
  if (result.ok) return result.manifest;
  log.error(
    "web:plugins",
    `${source}: invalid manifest — ${result.errors.join("; ")}`,
  );
  return null;
}

function defaultExport(module: unknown): KeepDeckPlugin {
  const plugin = (module as { default?: KeepDeckPlugin }).default;
  if (!plugin || typeof plugin.activate !== "function") {
    throw new Error("plugin bundle has no default export with activate()");
  }
  return plugin;
}
