import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FileOpenHandler,
  FsEntry,
  OverlayContribution,
  PluginContext,
} from "@keepdeck/plugin-api";
import plugin, { OPEN_LINKS_KEY } from "./index";
import {
  requestOpen,
  subscribeOpenRequests,
  takeOpenRequest,
} from "./openRequests";

/** A context fake covering exactly what activate() touches: registrations,
 * the settings value feed, fs.readDir for the scope probe. */
function makeCtx(values: Record<string, unknown> = {}) {
  const registered: FileOpenHandler[] = [];
  let onChange: ((values: Record<string, unknown>) => void) | undefined;
  const revealDockTab = vi.fn();
  const registerOverlay = vi.fn((_overlay: OverlayContribution) => ({
    dispose: vi.fn(),
  }));
  const readDir = vi.fn(async (_path: string): Promise<FsEntry[]> => []);
  const disposable = () => ({ dispose: vi.fn() });
  const ctx = {
    ui: {
      registerDockTab: vi.fn(disposable),
      registerOverlay,
      revealDockTab,
    },
    openers: {
      register: vi.fn((handler: FileOpenHandler) => {
        registered.push(handler);
        return {
          dispose: () => {
            const at = registered.indexOf(handler);
            if (at >= 0) registered.splice(at, 1);
          },
        };
      }),
    },
    settings: {
      registerSection: vi.fn(disposable),
      read: vi.fn(async () => values),
      onChange: vi.fn((cb: (v: Record<string, unknown>) => void) => {
        onChange = cb;
        return { dispose: vi.fn() };
      }),
    },
    services: { fs: { readDir } },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
  return {
    ctx,
    registered,
    revealDockTab,
    registerOverlay,
    readDir,
    fireSettings: (v: Record<string, unknown>) => onChange?.(v),
  };
}

/** Consumer subscriptions made by tests, torn down between them. */
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
  takeOpenRequest(); // drain the open-request slot between tests
  void plugin.deactivate?.();
});

describe("Files plugin activation", () => {
  it("registers the peek opener by default — the toggle's default is on", async () => {
    const { ctx, registered } = makeCtx();
    await plugin.activate(ctx);
    expect(registered.map((h) => h.id)).toEqual(["peek"]);
  });

  it("registers the viewer overlay UNCONDITIONALLY — the tree's own opens need it", async () => {
    const { ctx, registerOverlay } = makeCtx({ [OPEN_LINKS_KEY]: false });
    await plugin.activate(ctx);
    expect(registerOverlay).toHaveBeenCalledTimes(1);
    expect(registerOverlay.mock.calls[0][0]).toMatchObject({ id: "viewer" });
  });

  it("derives the registration from the setting, both directions, live", async () => {
    const { ctx, registered, fireSettings } = makeCtx({
      [OPEN_LINKS_KEY]: false,
    });
    await plugin.activate(ctx);
    expect(registered).toEqual([]); // stored off → never registered

    fireSettings({ [OPEN_LINKS_KEY]: true });
    expect(registered.map((h) => h.id)).toEqual(["peek"]);

    fireSettings({ [OPEN_LINKS_KEY]: false });
    expect(registered).toEqual([]); // toggle off → gone from the chain
  });
});

describe("the peek opener", () => {
  const entry = (name: string, kind: FsEntry["kind"]): FsEntry => ({
    name,
    path: `/repo/${name}`,
    kind,
    size: 1,
  });

  async function handler(
    readDirImpl: (path: string) => Promise<FsEntry[]>,
    opts: { consumer?: boolean } = {},
  ) {
    const made = makeCtx();
    made.readDir.mockImplementation(readDirImpl);
    await plugin.activate(made.ctx);
    // The FilesOverlay stand-in: a handler only accepts while one listens.
    if (opts.consumer !== false) cleanups.push(subscribeOpenRequests(() => {}));
    return { open: made.registered[0].open, ...made };
  }

  it("opens an in-scope file: parks the request and accepts — the dock is NOT touched", async () => {
    const { open, revealDockTab } = await handler(async () => [
      entry("readme.md", "file"),
    ]);
    expect(await open({ path: "/repo/readme.md" })).toBe(true);
    // The resident overlay consumes this; a terminal link must never
    // rearrange the user's layout.
    expect(takeOpenRequest()).toEqual({ path: "/repo/readme.md" });
    expect(revealDockTab).not.toHaveBeenCalled();
  });

  it("declines outside the fs scope — the probe's rejection is an answer", async () => {
    const { open, revealDockTab } = await handler(async () => {
      throw new Error("outside the allowed roots");
    });
    expect(await open({ path: "/etc/hosts" })).toBe(false);
    expect(takeOpenRequest()).toBeNull();
    expect(revealDockTab).not.toHaveBeenCalled();
  });

  it("declines a missing entry, a directory AND a symlink — the peek previews plain files", async () => {
    const { open } = await handler(async () => [
      entry("src", "dir"),
      entry("link", "symlink"),
    ]);
    expect(await open({ path: "/repo/gone.md" })).toBe(false);
    expect(await open({ path: "/repo/src" })).toBe(false);
    // A symlink may point at a directory or clean out of the fs scope (the
    // backend refuses to follow it there) — the system opener's job.
    expect(await open({ path: "/repo/link" })).toBe(false);
  });

  it("declines a rootless path without probing", async () => {
    const { open, readDir } = await handler(async () => []);
    readDir.mockClear();
    expect(await open({ path: "/" })).toBe(false);
    expect(readDir).not.toHaveBeenCalled();
  });

  it("declines when NO consumer is alive — an accepted click would land nowhere", async () => {
    // The plugin was disabled while the probe was in flight (the overlay is
    // gone), or the overlay crashed: "handled" would swallow the click.
    const { open } = await handler(async () => [entry("readme.md", "file")], {
      consumer: false,
    });
    expect(await open({ path: "/repo/readme.md" })).toBe(false);
    expect(takeOpenRequest()).toBeNull(); // nothing parked to replay later
  });

  it("deactivate drains a parked request — the next activation never replays a stale peek", async () => {
    requestOpen({ path: "/repo/old-click.md" });
    await plugin.deactivate?.();
    expect(takeOpenRequest()).toBeNull();
  });
});
