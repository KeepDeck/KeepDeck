// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FsEntry, PluginContext } from "@keepdeck/plugin-api";
import { setRuntime } from "../runtime";
import { useFileTree } from "./useFileTree";
import type { TreeState } from "../domain/tree";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const entry = (root: string, name: string): FsEntry => ({
  name,
  path: `${root}/${name}`,
  kind: "file",
});

/** A project fs whose every readDir is settled BY THE TEST, so a re-root can be
 * driven into the exact window between a request and its answer. `watched`
 * counts live watchers per path (registrations minus disposals). */
function deferredFs() {
  const pending = new Map<string, (entries: FsEntry[]) => void>();
  const watched = new Map<string, number>();
  return {
    pending,
    live: (path: string) => watched.get(path) ?? 0,
    readDir: vi.fn(
      (path: string) =>
        new Promise<FsEntry[]>((resolve) => pending.set(path, resolve)),
    ),
    readFile: vi.fn(),
    watch: vi.fn((path: string) => {
      watched.set(path, (watched.get(path) ?? 0) + 1);
      return { dispose: () => watched.set(path, (watched.get(path) ?? 1) - 1) };
    }),
  };
}

describe("useFileTree re-rooting", () => {
  let fs: ReturnType<typeof deferredFs>;
  let host: HTMLElement;
  let root: Root;
  let latest: TreeState;

  function Probe({ rootPath }: { rootPath: string }) {
    latest = useFileTree(rootPath).state;
    return null;
  }

  const mount = (rootPath: string) =>
    act(() => root.render(createElement(Probe, { rootPath })));

  const settle = (path: string, entries: FsEntry[]) =>
    act(async () => fs.pending.get(path)!(entries));

  beforeEach(() => {
    fs = deferredFs();
    setRuntime({
      services: {
        fs: { readDir: fs.readDir, readFile: fs.readFile, watch: fs.watch },
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext);
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    setRuntime(null);
  });

  it("watches and populates the root it settled on", async () => {
    mount("/a");
    await settle("/a", [entry("/a", "a.ts")]);

    expect(latest.rootPath).toBe("/a");
    expect(latest.nodes["/a/a.ts"]).toBeDefined();
    expect(fs.live("/a")).toBe(1);
  });

  it("abandons a load whose root was replaced while readDir was in flight", async () => {
    mount("/a");
    expect(fs.readDir).toHaveBeenCalledWith("/a");

    // Re-root before /a answers, then let the new root settle.
    mount("/b");
    await settle("/b", [entry("/b", "b.ts")]);

    // The abandoned load answers LAST — the ordering that used to graft the
    // old root's children into the live tree.
    await settle("/a", [entry("/a", "a.ts")]);

    expect(latest.rootPath).toBe("/b");
    expect(latest.nodes["/a/a.ts"]).toBeUndefined();
    // The re-root cleanup already cleared the watcher map, so a watcher
    // registered after it would be live until the NEXT re-root — an OS
    // watcher on an abandoned directory, re-reading it into /b's tree.
    expect(fs.live("/a")).toBe(0);
    expect(fs.live("/b")).toBe(1);
  });
});
