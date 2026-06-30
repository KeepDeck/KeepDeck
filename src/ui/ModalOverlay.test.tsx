// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModalOverlay } from "./ModalOverlay";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("ModalOverlay", () => {
  let stage: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    // Mimics the real mount point: the dialog is spawned from inside the deck
    // stage, which is only part of the window.
    stage = document.createElement("div");
    stage.className = "deck__stage";
    document.body.appendChild(stage);
    root = createRoot(stage);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("portals the backdrop to <body>, OUTSIDE the stage it was spawned from", () => {
    act(() =>
      root.render(
        createElement(ModalOverlay, null, createElement("p", null, "hi")),
      ),
    );

    const overlay = document.querySelector(".modal-overlay");
    expect(overlay).not.toBeNull();
    // The whole point: it escaped the partial-window stage and now lives at the
    // top of <body>, so it can cover (and block) the entire app.
    expect(stage.contains(overlay)).toBe(false);
    expect(overlay!.parentElement).toBe(document.body);
    expect(overlay!.textContent).toBe("hi");
  });

  it("removes the portaled backdrop from <body> on unmount", () => {
    act(() =>
      root.render(createElement(ModalOverlay, null, createElement("p", null, "x"))),
    );
    expect(document.querySelector(".modal-overlay")).not.toBeNull();

    act(() => root.unmount());
    expect(document.querySelector(".modal-overlay")).toBeNull();
    // re-create so afterEach's unmount is a no-op rather than a double-unmount.
    root = createRoot(stage);
  });
});
