import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

import { pointerInWindow, pointerOnWindow } from "./window";

/** Pins the wire contract with src-tauri/src/pointer.rs: the command names it
 * registers, and the order of the point it answers — (x, y), CSS pixels
 * from the content's top-left — so a transposition fails here, not as a
 * hit-test in the wrong place. */
describe("window pointer ipc", () => {
  beforeEach(() => invoke.mockReset());

  it("pointerInWindow invokes pointer_in_window and passes its answer through", async () => {
    invoke.mockResolvedValueOnce(false);
    await expect(pointerInWindow()).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith("pointer_in_window");
    invoke.mockResolvedValueOnce(null);
    await expect(pointerInWindow()).resolves.toBeNull();
  });

  it("pointerOnWindow invokes pointer_on_window and reads its tuple as x then y", async () => {
    invoke.mockResolvedValueOnce([12, 340]);
    await expect(pointerOnWindow()).resolves.toEqual({ x: 12, y: 340 });
    expect(invoke).toHaveBeenCalledWith("pointer_on_window");
    invoke.mockResolvedValueOnce(null);
    await expect(pointerOnWindow()).resolves.toBeNull();
  });
});
