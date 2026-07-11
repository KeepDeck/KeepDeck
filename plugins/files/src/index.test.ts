import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  FileOpenHandler,
  FsEntry,
  PluginContext,
} from "@keepdeck/plugin-api";
import plugin, { OPEN_LINKS_KEY } from "./index";
import { takeOpenRequest } from "./openRequests";

/** A context fake covering exactly what activate() touches: registrations,
 * the settings value feed, fs.readDir for the scope probe, the dock reveal. */
function makeCtx(values: Record<string, unknown> = {}) {
  const registered: FileOpenHandler[] = [];
  let onChange: ((values: Record<string, unknown>) => void) | undefined;
  const revealDockTab = vi.fn();
  const readDir = vi.fn(async (_path: string): Promise<FsEntry[]> => []);
  const disposable = () => ({ dispose: vi.fn() });
  const ctx = {
    ui: {
      registerDockTab: vi.fn(disposable),
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
    readDir,
    fireSettings: (v: Record<string, unknown>) => onChange?.(v),
  };
}

afterEach(() => {
  takeOpenRequest(); // drain the open-request slot between tests
  void plugin.deactivate?.();
});

describe("Files plugin activation", () => {
  it("registers the peek opener by default — the toggle's default is on", async () => {
    const { ctx, registered } = makeCtx();
    await plugin.activate(ctx);
    expect(registered.map((h) => h.id)).toEqual(["peek"]);
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

  async function handler(readDirImpl: (path: string) => Promise<FsEntry[]>) {
    const made = makeCtx();
    made.readDir.mockImplementation(readDirImpl);
    await plugin.activate(made.ctx);
    return { open: made.registered[0].open, ...made };
  }

  it("opens an in-scope file: parks the request, reveals the tab, accepts", async () => {
    const { open, revealDockTab } = await handler(async () => [
      entry("readme.md", "file"),
    ]);
    expect(await open({ path: "/repo/readme.md" })).toBe(true);
    expect(takeOpenRequest()).toBe("/repo/readme.md");
    expect(revealDockTab).toHaveBeenCalledWith("files");
  });

  it("declines outside the fs scope — the probe's rejection is an answer", async () => {
    const { open, revealDockTab } = await handler(async () => {
      throw new Error("outside the allowed roots");
    });
    expect(await open({ path: "/etc/hosts" })).toBe(false);
    expect(takeOpenRequest()).toBeNull();
    expect(revealDockTab).not.toHaveBeenCalled();
  });

  it("declines a missing entry and a directory — the peek previews files", async () => {
    const { open } = await handler(async () => [entry("src", "dir")]);
    expect(await open({ path: "/repo/gone.md" })).toBe(false);
    expect(await open({ path: "/repo/src" })).toBe(false);
  });

  it("declines a rootless path without probing", async () => {
    const { open, readDir } = await handler(async () => []);
    readDir.mockClear();
    expect(await open({ path: "/" })).toBe(false);
    expect(readDir).not.toHaveBeenCalled();
  });
});
