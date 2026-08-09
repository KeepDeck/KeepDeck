// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSaveShortcut } from "./useSaveShortcut";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The chord's own suite. It had none: "physical key, not layout character" was
 * pinned only inside one dialog's cases, which is where the next writing surface
 * would copy the Cyrillic case from instead of trusting the hook.
 */
describe("useSaveShortcut", () => {
  let root: Root;
  let saves: number;

  const Surface = () => {
    useSaveShortcut(() => saves++);
    return null;
  };

  const press = (init: KeyboardEventInit) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { ...init, cancelable: true }));
    });

  beforeEach(async () => {
    saves = 0;
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    await act(async () => root.render(createElement(Surface)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("matches the PHYSICAL key, so a Cyrillic layout saves too", async () => {
    // On a Cyrillic layout the S key yields "ы"; a `key` match would never fire,
    // and the user would conclude ⌘S does not work in this app.
    await press({ code: "KeyS", key: "s", metaKey: true });
    await press({ code: "KeyS", key: "ы", metaKey: true });
    expect(saves).toBe(2);
  });

  it("takes Ctrl as well as Cmd, and ignores the key with no modifier", async () => {
    await press({ code: "KeyS", key: "s", ctrlKey: true });
    await press({ code: "KeyS", key: "s" });
    expect(saves).toBe(1);
  });

  it("saves under extra modifiers — a decorated chord still means save", async () => {
    await press({ code: "KeyS", key: "s", metaKey: true, shiftKey: true });
    await press({ code: "KeyS", key: "s", metaKey: true, altKey: true });
    expect(saves).toBe(2);
  });

  it("suppresses the browser's own save dialog", async () => {
    const event = new KeyboardEvent("keydown", {
      code: "KeyS",
      key: "s",
      metaKey: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("stops when the surface unmounts", async () => {
    act(() => root.unmount());
    await press({ code: "KeyS", key: "s", metaKey: true });
    expect(saves).toBe(0);
    // Re-rendered so `afterEach`'s unmount has a root to work with.
    root = createRoot(document.getElementById("host")!);
  });
});
