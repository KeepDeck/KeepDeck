import { afterEach, describe, expect, it } from "vitest";
import { pendingIpcCallbacks } from "./ipcCallbacks";

const GLUE = "__TAURI_INTERNALS__";

afterEach(() => {
  Reflect.deleteProperty(globalThis, GLUE);
});

describe("pendingIpcCallbacks", () => {
  it("reads the size of the glue's callback registry", () => {
    Reflect.set(globalThis, GLUE, {
      callbacks: new Map([
        [1, () => {}],
        [2, () => {}],
        [3, () => {}],
      ]),
    });
    expect(pendingIpcCallbacks()).toBe(3);
  });

  it("answers null, not zero, when there is no Tauri glue", () => {
    expect(pendingIpcCallbacks()).toBeNull();
  });

  it("answers null when the glue exposes no registry", () => {
    Reflect.set(globalThis, GLUE, {});
    expect(pendingIpcCallbacks()).toBeNull();
  });
});
