import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Untyped resource JS — shipped to, and loaded by, the user's opencode
// process, never bundled into the plugin.
// @ts-expect-error untyped resource module
import { startComponents } from "../resources/keepdeck-plugin/components.js";
// @ts-expect-error untyped resource module
import keepdeckPlugin, { composeHooks } from "../resources/keepdeck-plugin/index.js";
// @ts-expect-error untyped resource module
import tuiPlugin from "../resources/keepdeck-plugin/tui.js";

/** The directory the spawn plan injects (src/index.ts sessionConfigEnv). */
const PLUGIN_DIR = join(__dirname, "..", "resources", "keepdeck-plugin");

describe("one plugin, two components", () => {
  it("hands every handler of a name the same arguments", async () => {
    const reporter = vi.fn();
    const courier = vi.fn();
    const hooks = composeHooks([{ event: reporter }, { event: courier }]);
    const event = { event: { type: "session.idle" } };

    await hooks.event(event);

    expect(reporter).toHaveBeenCalledWith(event);
    expect(courier).toHaveBeenCalledWith(event);
  });

  it("starts every handler before waiting on any", () => {
    // opencode 1.x fires `event` at each plugin without waiting; the reporter
    // waiting on hydration must not hold the courier's mail back.
    const courier = vi.fn();
    const hooks = composeHooks([{ event: () => new Promise(() => {}) }, { event: courier }]);

    void hooks.event({ event: { type: "session.idle" } });

    expect(courier).toHaveBeenCalledOnce();
  });

  it("silences a handler that throws or rejects, and only that one", async () => {
    const courier = vi.fn();
    const throws = composeHooks([
      { event: () => { throw new Error("reporter broke"); } },
      { event: courier },
    ]);
    const rejects = composeHooks([{ event: () => Promise.reject(new Error("no")) }, { event: courier }]);

    await expect(throws.event({})).resolves.toBeUndefined();
    await expect(rejects.event({})).resolves.toBeUndefined();
    expect(courier).toHaveBeenCalledTimes(2);
  });

  it("keeps a hook only one component has", async () => {
    const chat = vi.fn();
    const hooks = composeHooks([{ event: vi.fn() }, { event: vi.fn(), "chat.message": chat }]);

    await hooks["chat.message"]("info", "output");

    expect(Object.keys(hooks).sort()).toEqual(["chat.message", "event"]);
    expect(chat).toHaveBeenCalledWith("info", "output");
  });

  it("starts the other component when one fails to start", async () => {
    const event = vi.fn();
    const maps = await startComponents(
      [
        async () => { throw new Error("no client"); },
        async () => ({ event }),
        async () => undefined,
      ],
      { client: {} },
    );

    expect(maps).toEqual([{}, { event }, {}]);
  });
});

describe("the directory each opencode generation loads", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is found by 1.x as a directory index whose default has a server function", () => {
    // 1.19.3 resolves a configured directory to its index file and reads only
    // `default`: a record with a function `server`, no `tui`, other keys
    // ignored (packages/opencode/src/plugin/shared.ts resolvePathPluginTarget,
    // readV1Plugin). A directory holding only server.js is not loaded.
    expect(existsSync(join(PLUGIN_DIR, "index.js"))).toBe(true);
    expect(typeof keepdeckPlugin.server).toBe("function");
    expect(keepdeckPlugin).not.toHaveProperty("tui");
  });

  it("is accepted by 2.x as an object with an id and a setup function", async () => {
    // 2.1.2 decodes `default` as {id, setup} | {id, effect} and strips the
    // rest, `server` included (packages/core/src/plugin/module.ts).
    expect(typeof keepdeckPlugin.id).toBe("string");
    expect(typeof keepdeckPlugin.setup).toBe("function");
    await expect(keepdeckPlugin.setup({})).resolves.toBeUndefined();
  });

  it("stays inert on 1.x outside a KeepDeck pane", async () => {
    vi.stubEnv("KEEPDECK_BRIDGE", "");

    expect(await keepdeckPlugin.server({})).toEqual({});
  });
});

describe("the TUI plugin's own config file", () => {
  it("names only the route observer, by a path relative to the file itself", () => {
    // OPENCODE_TUI_CONFIG points here (src/launch.ts). Only `plugin`, so the
    // user's theme and keys stay theirs; a FILE path, since a directory would
    // resolve to the server-only index.js; relative, since opencode resolves
    // it against this file (verified live on 1.19.3).
    const config = JSON.parse(readFileSync(join(PLUGIN_DIR, "tui-v1.json"), "utf8"));
    expect(config).toEqual({ plugin: ["./route-observer.js"] });
    expect(existsSync(join(PLUGIN_DIR, "route-observer.js"))).toBe(true);
  });
});

describe("what opencode 2.x finds in the directory", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("holds exactly one TUI entry — tui.js — and nothing else 2.x would take for one", () => {
    // 2.x resolves a plugin directory's TUI entry by the bare name `tui`, and
    // a `tui.json` meant for 1.x was refused as a module — "1 plugin failed"
    // on every 2.x pane (task-448). A file or a directory (Bun resolves
    // `tui/index.js` too), in any case — a case-insensitive volume answers
    // `TUI.json` to `tui`. The one that may answer is the 2.x TUI half
    // (task-436).
    const named = readdirSync(PLUGIN_DIR).filter((file) => /^tui([./]|$)/i.test(file));
    expect(named).toEqual(["tui.js"]);
  });

  it("finds a TUI plugin with an id and a setup — not a server half, not a 1.x tui", () => {
    // 2.x refuses a TUI module whose default lacks `id` or `setup`
    // (packages/tui/src/plugin/context.tsx isPlugin), with a toast.
    expect(typeof tuiPlugin.id).toBe("string");
    expect(tuiPlugin.id).not.toBe(keepdeckPlugin.id);
    expect(typeof tuiPlugin.setup).toBe("function");
    expect(tuiPlugin).not.toHaveProperty("server");
    expect(tuiPlugin).not.toHaveProperty("tui");
  });

  it("stays inert, and never throws, outside a pane or on a context it cannot read", () => {
    vi.stubEnv("KEEPDECK_BRIDGE", "");
    expect(tuiPlugin.setup({ ui: { router: { current: () => ({ type: "home" }) } } })).toBeUndefined();
    vi.stubEnv("KEEPDECK_BRIDGE", JSON.stringify({ v: 2, dir: "/nonexistent", pane: "p", token: "t", url: "http://127.0.0.1:9/envelope" }));
    expect(() => tuiPlugin.setup({})).not.toThrow();
    expect(tuiPlugin.setup({})).toBeUndefined();
    expect(tuiPlugin.setup(undefined)).toBeUndefined();
  });
});
