import { describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { makeGlobalKvStub, makeWorkspaceKv, type DeckAccess } from "./pluginKv";

const ws = (id: string, plugins?: Record<string, unknown>): Workspace => ({
  id,
  name: id,
  cwd: `/tmp/${id}`,
  worktreeBaseDir: null,
  panes: [],
  ...(plugins && { plugins }),
});

function access(workspaces: Workspace[]): DeckAccess & {
  setPluginSlot: ReturnType<typeof vi.fn>;
} {
  return { workspaces: () => workspaces, setPluginSlot: vi.fn() };
}

describe("makeWorkspaceKv", () => {
  it("reads a key out of the plugin's slot", async () => {
    const a = access([ws("w1", { "keepdeck.sample": { note: "hi" } })]);
    const kv = makeWorkspaceKv(a, "keepdeck.sample", "w1");
    expect(await kv.get("note")).toBe("hi");
    expect(await kv.get("missing")).toBeUndefined();
  });

  it("answers undefined for an unknown workspace or foreign slot", async () => {
    const a = access([ws("w1", { other: { note: "x" } })]);
    expect(
      await makeWorkspaceKv(a, "keepdeck.sample", "w1").get("note"),
    ).toBeUndefined();
    expect(
      await makeWorkspaceKv(a, "keepdeck.sample", "gone").get("note"),
    ).toBeUndefined();
  });

  it("set spreads the new key over the existing slot", async () => {
    const a = access([ws("w1", { p: { keep: 1 } })]);
    await makeWorkspaceKv(a, "p", "w1").set("added", 2);
    expect(a.setPluginSlot).toHaveBeenCalledWith("w1", "p", {
      keep: 1,
      added: 2,
    });
  });

  it("delete drops the key, and deleting the last key deletes the slot", async () => {
    const a = access([ws("w1", { p: { one: 1, two: 2 } })]);
    await makeWorkspaceKv(a, "p", "w1").delete("one");
    expect(a.setPluginSlot).toHaveBeenCalledWith("w1", "p", { two: 2 });

    const b = access([ws("w1", { p: { last: 1 } })]);
    await makeWorkspaceKv(b, "p", "w1").delete("last");
    expect(b.setPluginSlot).toHaveBeenCalledWith("w1", "p", undefined);
  });

  it("reads through the accessor LIVE — a later state is visible to an old kv", async () => {
    let current = [ws("w1")];
    const a: DeckAccess = {
      workspaces: () => current,
      setPluginSlot: vi.fn(),
    };
    const kv = makeWorkspaceKv(a, "p", "w1");
    expect(await kv.get("k")).toBeUndefined();
    current = [ws("w1", { p: { k: "now" } })];
    expect(await kv.get("k")).toBe("now");
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
