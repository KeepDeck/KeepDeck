import { describe, expect, it, vi } from "vitest";
import type { FileOpenHandler } from "@keepdeck/plugin-api";
import type { Contribution } from "../plugins/registries/contributions";
import { createFileOpenManager } from "./fileOpenManager";

const contribution = (
  pluginId: string,
  id: string,
  open: FileOpenHandler["open"],
): Contribution<FileOpenHandler> => ({
  pluginId,
  entry: { id, label: id, open },
});

function manager(handlers: Contribution<FileOpenHandler>[]) {
  const system = vi.fn(async () => {});
  const warn = vi.fn();
  const chain = createFileOpenManager(() => handlers, system, warn);
  return { chain, system, warn };
}

describe("createFileOpenManager", () => {
  it("an empty chain goes straight to the system opener, nothing declined", async () => {
    const { chain, system } = manager([]);
    expect(await chain.open({ path: "/a" })).toEqual({
      via: "system",
      declined: false,
    });
    expect(system).toHaveBeenCalledWith("/a");
  });

  it("the first handler that accepts wins; later ones are never asked", async () => {
    const second = vi.fn(async () => true);
    const { chain, system } = manager([
      contribution("p1", "peek", async () => true),
      contribution("p2", "other", second),
    ]);
    expect(await chain.open({ path: "/a" })).toEqual({
      via: "peek",
      declined: false,
    });
    expect(second).not.toHaveBeenCalled();
    expect(system).not.toHaveBeenCalled();
  });

  it("a decline falls through — to the next handler, then to system", async () => {
    const { chain } = manager([
      contribution("p1", "first", async () => false),
      contribution("p2", "second", async () => true),
    ]);
    expect(await chain.open({ path: "/a" })).toEqual({
      via: "second",
      declined: true,
    });

    const all = manager([contribution("p1", "only", async () => false)]);
    expect(await all.chain.open({ path: "/b" })).toEqual({
      via: "system",
      declined: true,
    });
    expect(all.system).toHaveBeenCalledWith("/b");
  });

  it("a throwing handler is logged and treated as a decline — the click still lands", async () => {
    const { chain, system, warn } = manager([
      contribution("p1", "boom", async () => {
        throw new Error("realm died");
      }),
    ]);
    expect(await chain.open({ path: "/a" })).toEqual({
      via: "system",
      declined: true,
    });
    expect(system).toHaveBeenCalledWith("/a");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("p1:boom");
    expect(warn.mock.calls[0][0]).toContain("realm died");
  });

  it("a failing SYSTEM opener rejects — the caller shows the error at the click", async () => {
    const system = vi.fn(async () => {
      throw new Error("no app for this type");
    });
    const chain = createFileOpenManager(() => [], system, vi.fn());
    await expect(chain.open({ path: "/a" })).rejects.toThrow(
      "no app for this type",
    );
  });
});
