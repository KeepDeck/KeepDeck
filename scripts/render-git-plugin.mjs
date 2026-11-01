import assert from "node:assert/strict";

// What the DOM realm hands back is module namespaces from vm: nothing types
// them, so each one is checked for the members this step calls before use.
/** @typedef {import("happy-dom").Window} Window */
/** @typedef {{ activate(context: object): Promise<void>, deactivate(): Promise<void> }} PluginEntry */
/** @typedef {{ id: string, Component: unknown }} DockTab */
/** @typedef {{ createElement(type: unknown, props: object): unknown }} ReactBridge */
/** @typedef {{ flushSync(callback: () => void): void }} ReactDomBridge */
/** @typedef {{ render(node: unknown): void, unmount(): void }} Root */
/** @typedef {{ onUncaughtError(error: unknown): void, onRecoverableError(error: unknown): void }} RootOptions */
/** @typedef {{ createRoot(host: Element, options: RootOptions): Root }} ReactDomClientBridge */
/** @typedef {{ installResizeObserver(): void, pinListViewport(list: string, height: number, width?: number, rowHeight?: number): () => void }} Geometry */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/**
 * @param {unknown} value
 * @param {string[]} members
 * @returns {boolean}
 */
function hasFunctions(value, members) {
  return isRecord(value) && members.every((name) => typeof value[name] === "function");
}

/** @type {(value: unknown) => value is PluginEntry} */
const isPluginEntry = (value) => hasFunctions(value, ["activate", "deactivate"]);
/** @type {(value: unknown) => value is ReactBridge} */
const isReactBridge = (value) => hasFunctions(value, ["createElement"]);
/** @type {(value: unknown) => value is ReactDomBridge} */
const isReactDomBridge = (value) => hasFunctions(value, ["flushSync"]);
/** @type {(value: unknown) => value is ReactDomClientBridge} */
const isReactDomClientBridge = (value) => hasFunctions(value, ["createRoot"]);
/** @type {(value: unknown) => value is Geometry} */
const isGeometry = (value) => hasFunctions(value, ["installResizeObserver", "pinListViewport"]);

/**
 * @template T
 * @param {string} name
 * @param {unknown} value
 * @param {(value: unknown) => value is T} guard
 * @returns {T}
 */
function expectPort(name, value, guard) {
  if (!guard(value)) throw new Error(`${name}: not the shape the render check calls`);
  return value;
}

// The render step of scripts/check-plugin-bundles.mjs, the last step of
// `pnpm build`. The REAL bundled entry activates against fake host ports.
// React, its DOM renderer, the tab and the virtualizer all execute inside the
// browser realm.
/**
 * @param {object} realm
 * @param {Window} realm.window
 * @param {unknown} realm.plugin the plugin's default export
 * @param {unknown} realm.react the react bridge's namespace
 * @param {unknown} realm.reactDom the react-dom bridge's namespace
 * @param {unknown} realm.reactDomClient the react-dom/client bridge's namespace
 * @param {unknown} realm.geometry the UI kit's virtual-geometry test support namespace
 */
export async function checkGitRender(realm) {
  const { window } = realm;
  const plugin = expectPort("plugin", realm.plugin, isPluginEntry);
  const react = expectPort("react", realm.react, isReactBridge);
  const reactDom = expectPort("react-dom", realm.reactDom, isReactDomBridge);
  const reactDomClient = expectPort("react-dom/client", realm.reactDomClient, isReactDomClientBridge);
  const geometry = expectPort("geometry", realm.geometry, isGeometry);
  /** @type {unknown[]} */
  const errors = [];
  // Assigned from the fake ports below, once the plugin has run.
  /** @type {DockTab | undefined} */
  let tab;
  /** @type {(() => void) | undefined} */
  let watcher;
  let watched = false;
  let status = {
    branch: "main", detached: false, oid: "a1".repeat(20),
    upstream: null, ahead: null, behind: null,
    entries: [{
      path: "src/browser-check.ts", origPath: null, staged: ".", unstaged: "M",
      untracked: false, conflicted: false,
    }],
  };
  let history = {
    forkSha: null, ahead: null,
    commits: [{
      sha: "a1".repeat(20), author: "Author", timestamp: 1_760_000_000,
      subject: "Render a built plugin",
    }],
  };
  const workspace = {
    id: "ws-build", instance: "instance-build", name: "Build test",
    cwd: "/repo", teams: [], panes: [],
  };
  const context = {
    ui: {
      /** @param {DockTab} value */
      registerDockTab(value) { tab = value; },
      registerOverlay() {},
    },
    storage: {
      workspace: () => ({
        get: async () => ({ changes: true, history: true }),
        set: async () => {},
      }),
    },
    services: {
      git: {
        status: async () => status,
        history: async () => history,
        /**
         * @param {unknown} _repo
         * @param {() => void} onChange
         */
        watch(_repo, onChange) {
          watcher = onChange;
          watched = true;
          return { ready: Promise.resolve(), dispose() { watched = false; } };
        },
      },
    },
    log: { warn: (/** @type {string} */ message) => errors.push(new Error(message)) },
  };
  geometry.installResizeObserver();
  const restoreGeometry = geometry.pinListViewport("git__list", 1000, 340, 24);
  const host = window.document.createElement("div");
  window.document.body.appendChild(host);
  const root = reactDomClient.createRoot(host, {
    onUncaughtError: (error) => errors.push(error),
    onRecoverableError: (error) => errors.push(error),
  });
  const settle = async () => {
    await window.happyDOM.waitUntilComplete();
    if (errors.length) throw errors[0];
  };
  try {
    await plugin.activate(context);
    assert.ok(tab);
    assert.equal(tab.id, "git");
    const { Component } = tab;
    reactDom.flushSync(() => root.render(react.createElement(Component, {
      workspace, selectedPaneId: null,
    })));
    await settle();
    // Actual rows must reach BOTH lists; loading or error placeholders
    // cannot satisfy the render check.
    assert.equal(host.querySelectorAll(".git__list").length, 2);
    assert.ok(host.textContent.includes("browser-check.ts"), host.textContent);
    assert.ok(host.textContent.includes("Render a built plugin"), host.textContent);
    assert.equal(watched, true);

    // Exercise a live refresh too, including the lists' empty states.
    status = { ...status, entries: [] };
    history = { ...history, commits: [] };
    assert.ok(watcher);
    watcher();
    await settle();
    assert.ok(host.textContent.includes("No changes"), host.textContent);
    assert.ok(host.textContent.includes("No commits yet"), host.textContent);
    assert.equal(host.querySelectorAll(".git__row").length, 0);
  } finally {
    root.unmount();
    await plugin.deactivate();
    restoreGeometry();
    host.remove();
  }
  assert.equal(watched, false);
}
