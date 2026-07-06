function m(t, i) {
  const s = () => {
  }, l = /* @__PURE__ */ new Map(), g = /* @__PURE__ */ new Map(), d = /* @__PURE__ */ new Map(), a = /* @__PURE__ */ new Map();
  let b = 1;
  function v(e, n, o, r) {
    let c = l.get(e);
    c || (c = /* @__PURE__ */ new Set(), l.set(e, c), o()), c.add(n);
    let u = !0;
    return {
      dispose() {
        if (!u) return;
        u = !1;
        const f = l.get(e);
        f && (f.delete(n), f.size === 0 && (l.delete(e), r()));
      }
    };
  }
  function h(e, n, o) {
    const r = b++;
    t.call(e, [r, n]).catch(s);
    let c = !0;
    return {
      dispose() {
        c && (c = !1, o(), t.call("registrations.dispose", [r]).catch(s));
      }
    };
  }
  const w = {
    manifest: i,
    ui: {
      registerDockTab: (e) => {
        if ("Component" in e)
          throw new Error(
            "external dock tabs must use the `iframe` variant: a React Component cannot cross the plugin sandbox boundary"
          );
        return h(
          "ui.registerDockTab",
          { id: e.id, label: e.label, iframe: e.iframe },
          s
        );
      },
      registerTopBarAction: (e) => {
        const n = p("topBar", e.id);
        return a.set(n, () => e.run()), h(
          "ui.registerTopBarAction",
          { id: e.id, title: e.title },
          () => a.delete(n)
        );
      },
      registerPaneAction: (e) => {
        const n = p("pane", e.id);
        return a.set(
          n,
          (o) => e.run(o)
        ), h(
          "ui.registerPaneAction",
          { id: e.id, title: e.title },
          () => a.delete(n)
        );
      }
    },
    settings: {
      registerSection: (e) => h("settings.registerSection", e, s),
      read: () => t.call("settings.read", []),
      // The settings-change feed is just another broadcast channel — ref-counted
      // and fanned out exactly like a deck event, over its own subscribe path.
      onChange: (e) => v(
        "settingsChanged",
        (n) => e(n),
        () => {
          t.call("settings.onChange", []).catch(s);
        },
        () => {
          t.call("settings.offChange", []).catch(s);
        }
      )
    },
    agents: {
      // Identity crosses; hooks are functions and are not modelled at this tier.
      register: (e) => h(
        "agents.register",
        { id: e.id, label: e.label, detect: e.detect },
        s
      )
    },
    storage: {
      workspace: (e) => ({
        get: (n) => t.call("storage.workspace.get", [e, n]),
        set: (n, o) => t.call("storage.workspace.set", [e, n, o]).then(s),
        delete: (n) => t.call("storage.workspace.delete", [e, n]).then(s)
      }),
      global: {
        get: (e) => t.call("storage.global.get", [e]),
        set: (e, n) => t.call("storage.global.set", [e, n]).then(s),
        delete: (e) => t.call("storage.global.delete", [e]).then(s)
      }
    },
    events: {
      onWorkspaceClosed: (e) => v(
        "workspaceClosed",
        (n) => e(n),
        () => {
          t.call("events.subscribe", ["workspaceClosed"]).catch(s);
        },
        () => {
          t.call("events.unsubscribe", ["workspaceClosed"]).catch(s);
        }
      ),
      onPaneSelected: (e) => v(
        "paneSelected",
        (n) => e(n),
        () => {
          t.call("events.subscribe", ["paneSelected"]).catch(s);
        },
        () => {
          t.call("events.unsubscribe", ["paneSelected"]).catch(s);
        }
      ),
      onDeckChanged: (e) => v(
        "deckChanged",
        () => e(),
        () => {
          t.call("events.subscribe", ["deckChanged"]).catch(s);
        },
        () => {
          t.call("events.unsubscribe", ["deckChanged"]).catch(s);
        }
      )
    },
    services: {
      sessions: {
        spawn: (e, n) => t.call("services.sessions.spawn", [e]).then(
          ({ id: o }) => {
            g.set(o, n);
            const r = d.get(o);
            if (r) {
              d.delete(o);
              for (const c of r) n(c);
            }
            return {
              id: o,
              write: (c) => t.call("services.sessions.write", [o, c]).then(s),
              resize: (c, u) => t.call("services.sessions.resize", [o, c, u]).then(s),
              close: () => (g.delete(o), t.call("services.sessions.close", [o]).then(s))
            };
          }
        )
      },
      ports: {
        allocate: (e) => t.call("services.ports.allocate", [e])
      },
      opener: {
        openUrl: (e) => t.call("services.opener.openUrl", [e]).then(s),
        openPath: (e) => t.call("services.opener.openPath", [e]).then(s)
      }
    },
    host: {
      settings: () => t.call("host.settings", [])
    },
    log: {
      info: (e) => {
        t.call("log.info", [e]).catch(s);
      },
      warn: (e) => {
        t.call("log.warn", [e]).catch(s);
      },
      error: (e) => {
        t.call("log.error", [e]).catch(s);
      }
    }
  };
  function k(e, n) {
    if (e.startsWith("session:")) {
      const r = e.slice(8), c = y(n), u = g.get(r);
      if (u)
        u(c);
      else {
        const f = d.get(r) ?? [];
        f.push(c), d.set(r, f);
      }
      return;
    }
    if (e.startsWith("action:")) {
      const r = a.get(e.slice(7));
      r && r(n);
      return;
    }
    const o = l.get(e);
    if (o) for (const r of [...o]) r(n);
  }
  return { ctx: w, dispatchEvent: k };
}
function p(t, i) {
  return `${t}:${i}`;
}
function y(t) {
  const i = t;
  return i.type === "output" ? { type: "output", bytes: new Uint8Array(i.bytes) } : { type: "exit", code: i.code };
}
function C(t) {
  if (t instanceof Error) return t.message;
  if (typeof t == "string") return t;
  try {
    return JSON.stringify(t) ?? String(t);
  } catch {
    return String(t);
  }
}
class S {
  constructor(i) {
    this.port = i;
  }
  port;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  /** Invoke a host method; resolves with its return value, rejects with an
   * `Error` carrying the host's message on `ok:false`. */
  call(i, s) {
    const l = this.nextId++;
    return new Promise((g, d) => {
      this.pending.set(l, { resolve: g, reject: d }), this.port.postMessage({ kind: "call", id: l, path: i, args: s });
    });
  }
  /** Settle the pending promise for one incoming result. Unknown ids (already
   * settled, or never ours) are ignored — a result is at most one promise. */
  settle(i) {
    const s = this.pending.get(i.id);
    s && (this.pending.delete(i.id), i.ok ? s.resolve(i.value) : s.reject(new Error(i.error)));
  }
}
function E(t, i) {
  const s = new S(t);
  let l = null;
  async function g(d) {
    try {
      const a = m(s, d);
      l = a.dispatchEvent, await i.activate(a.ctx), t.postMessage({ kind: "activated" });
    } catch (a) {
      t.postMessage({ kind: "failed", error: C(a) });
    }
  }
  t.onmessage = (d) => {
    const a = d.data;
    switch (a.kind) {
      case "result":
        s.settle(a);
        return;
      case "event":
        l?.(a.channel, a.payload);
        return;
      case "init":
        g(a.manifest);
        return;
    }
  }, t.postMessage({ kind: "ready" });
}
function M(t) {
  const i = (s) => {
    const l = s.ports[0];
    l && (window.removeEventListener("message", i), E(l, t));
  };
  window.addEventListener("message", i);
}
M({
  activate(t) {
    t.log.info(`logic realm alive (${t.manifest.name})`), t.settings.read().then((i) => t.log.info(`rpc settings.read ok: ${JSON.stringify(i)}`)).catch((i) => t.log.error(`rpc failed: ${String(i)}`));
  }
});
