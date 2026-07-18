import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import { makeGlobalKvStub, makeWorkspaceKv, type DeckAccess } from "./pluginKv";

const ws = (id: string, plugins?: Record<string, unknown>): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id,
  cwd: `/tmp/${id}`,
  worktreeBaseDir: null,
  panes: [],
  ...(plugins && { plugins }),
});
const ref = (workspace: Workspace) => ({
  id: workspace.id,
  instance: workspace.instance,
});

function access(workspaces: Workspace[]): DeckAccess & {
  setPluginSlot: ReturnType<typeof vi.fn>;
} {
  return { workspaces: () => workspaces, setPluginSlot: vi.fn() };
}

describe("makeWorkspaceKv", () => {
  it("reads a key out of the plugin's slot", async () => {
    const workspace = ws("w1", { "keepdeck.sample": { note: "hi" } });
    const a = access([workspace]);
    const kv = makeWorkspaceKv(a, "keepdeck.sample", ref(workspace));
    expect(await kv.get("note")).toBe("hi");
    expect(await kv.get("missing")).toBeUndefined();
  });

  it("answers undefined for an unknown workspace or foreign slot", async () => {
    const workspace = ws("w1", { other: { note: "x" } });
    const a = access([workspace]);
    expect(
      await makeWorkspaceKv(a, "keepdeck.sample", ref(workspace)).get("note"),
    ).toBeUndefined();
    expect(
      await makeWorkspaceKv(a, "keepdeck.sample", {
        id: "gone",
        instance: "gone-instance",
      }).get("note"),
    ).toBeUndefined();
  });

  it("set spreads the new key over the existing slot", async () => {
    const workspace = ws("w1", { p: { keep: 1 } });
    const a = access([workspace]);
    await makeWorkspaceKv(a, "p", ref(workspace)).set("added", 2);
    expect(a.setPluginSlot).toHaveBeenCalledWith(
      "w1",
      workspace.instance,
      "p",
      { keep: 1, added: 2 },
    );
  });

  it("delete drops the key, and deleting the last key deletes the slot", async () => {
    const first = ws("w1", { p: { one: 1, two: 2 } });
    const a = access([first]);
    await makeWorkspaceKv(a, "p", ref(first)).delete("one");
    expect(a.setPluginSlot).toHaveBeenCalledWith(
      "w1",
      first.instance,
      "p",
      { two: 2 },
    );

    const last = ws("w1", { p: { last: 1 } });
    const b = access([last]);
    await makeWorkspaceKv(b, "p", ref(last)).delete("last");
    expect(b.setPluginSlot).toHaveBeenCalledWith(
      "w1",
      last.instance,
      "p",
      undefined,
    );
  });

  it("reads through the accessor LIVE — a later state is visible to an old kv", async () => {
    let current = [ws("w1")];
    const a: DeckAccess = {
      workspaces: () => current,
      setPluginSlot: vi.fn(),
    };
    const kv = makeWorkspaceKv(a, "p", ref(current[0]));
    expect(await kv.get("k")).toBeUndefined();
    current = [{ ...current[0], plugins: { p: { k: "now" } } }];
    expect(await kv.get("k")).toBe("now");
  });

  it("never attaches a stale handle to a workspace that reuses its id", async () => {
    let current = [ws("ws-3", { p: { old: true } })];
    const setPluginSlot = vi.fn();
    const a: DeckAccess = { workspaces: () => current, setPluginSlot };
    const stale = makeWorkspaceKv(a, "p", ref(current[0]));

    current = [ws("ws-3", { p: { fresh: true } })];

    expect(await stale.get("old")).toBeUndefined();
    await stale.set("leak", true);
    await stale.delete("fresh");
    expect(setPluginSlot).not.toHaveBeenCalled();
  });
});

describe("makeGlobalKvStub", () => {
  it("reads as empty and rejects writes loudly", async () => {
    const warn = vi.fn();
    const kv = makeGlobalKvStub(warn);
    expect(await kv.get("k")).toBeUndefined();
    await expect(kv.set("k", 1)).rejects.toThrow("not implemented");
    await expect(kv.delete("k")).rejects.toThrow("not implemented");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
