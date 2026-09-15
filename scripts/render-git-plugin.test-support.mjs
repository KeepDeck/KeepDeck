import assert from "node:assert/strict";

// The REAL bundled entry activates against fake host ports. React, its DOM
// renderer, the tab and the virtualizer all execute inside the browser realm.
export async function checkGitRender({ window, plugin, react, reactDom, reactDomClient, geometry }) {
  const errors = [];
  let tab;
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
        watch(_repo, onChange) {
          watcher = onChange;
          watched = true;
          return { ready: Promise.resolve(), dispose() { watched = false; } };
        },
      },
    },
    log: { warn: (message) => errors.push(new Error(message)) },
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
    assert.equal(tab.id, "git");
    reactDom.flushSync(() => root.render(react.createElement(tab.Component, {
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
