// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { suppressNativeContextMenu } from "./contextMenu";

const rightClick = (target: EventTarget) => {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
};

describe("suppressNativeContextMenu", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.innerHTML = "";
  });

  it("prevents the default menu on any element in the tree", () => {
    dispose = suppressNativeContextMenu();
    const child = document.createElement("div");
    document.body.appendChild(child);

    expect(rightClick(child).defaultPrevented).toBe(true);
  });

  it("still blocks when a component handler stops propagation", () => {
    dispose = suppressNativeContextMenu();
    const child = document.createElement("div");
    document.body.appendChild(child);
    child.addEventListener("contextmenu", (e) => e.stopPropagation());

    expect(rightClick(child).defaultPrevented).toBe(true);
  });

  it("stops blocking after the returned cleanup runs", () => {
    dispose = suppressNativeContextMenu();
    dispose();
    dispose = undefined;

    expect(rightClick(document.body).defaultPrevented).toBe(false);
  });
});
