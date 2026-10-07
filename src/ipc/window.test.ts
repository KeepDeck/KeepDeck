import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));

import { pointerInWindow, pointerOnWindow } from "./window";

/** Pins the wire contract with src-tauri/src/pointer.rs: the command names it
 * registers, and what each answers. */
describe("window pointer ipc", () => {
  beforeEach(() => invoke.mockReset());

  it("pointerInWindow invokes pointer_in_window and passes its answer through", async () => {
    invoke.mockResolvedValueOnce(false);
    await expect(pointerInWindow()).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith("pointer_in_window");
    invoke.mockResolvedValueOnce(null);
    await expect(pointerInWindow()).resolves.toBeNull();
  });

  it("pointerOnWindow invokes pointer_on_window and passes its point through", async () => {
    invoke.mockResolvedValueOnce({ x: 12, y: 340, pressed: true });
    await expect(pointerOnWindow()).resolves.toEqual({ x: 12, y: 340, pressed: true });
    expect(invoke).toHaveBeenCalledWith("pointer_on_window");
    invoke.mockResolvedValueOnce(null);
    await expect(pointerOnWindow()).resolves.toBeNull();
  });
});
