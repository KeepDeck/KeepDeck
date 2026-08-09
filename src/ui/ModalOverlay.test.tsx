// @vitest-environment happy-dom
import { DROP_BLOCKER_ATTR } from "@keepdeck/ui-kit/dropBlocker";
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

  it("declares itself a drop blocker — eating clicks does not stop a file drop", () => {
    act(() =>
      root.render(createElement(ModalOverlay, null, createElement("p", null, "hi"))),
    );
    // The backdrop swallows pointer events, but an OS file drop never becomes
    // one: it arrives from the window as raw coordinates and never consults
    // the DOM, so without this marker a path dragged from Finder onto an open
    // dialog is typed into a pane behind it.
    expect(
      document.querySelector(`.modal-overlay[${DROP_BLOCKER_ATTR}]`),
    ).not.toBeNull();
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

  it("makes the app behind it inert, and gives it back on unmount", () => {
    act(() =>
      root.render(createElement(ModalOverlay, null, createElement("p", null, "x"))),
    );

    // Eating clicks never stopped the keyboard: the pane behind kept its
    // focus and every key over the dialog still reached the agent.
    expect(stage.hasAttribute("inert")).toBe(true);
    expect(
      document.querySelector(".modal-overlay")!.hasAttribute("inert"),
    ).toBe(false);

    act(() => root.unmount());
    expect(stage.hasAttribute("inert")).toBe(false);
    root = createRoot(stage);
  });

  it("takes the keyboard when the dialog placed it nowhere", () => {
    // Two of the dialogs autofocus nothing at all, so without this the
    // keyboard sits on <body> with the whole app inert behind it: nothing to
    // tab from, and a screen reader landing outside the dialog.
    act(() =>
      root.render(createElement(ModalOverlay, null, createElement("p", null, "x"))),
    );

    expect(document.activeElement).toBe(
      document.querySelector(".modal-overlay"),
    );
  });

  it("leaves a dialog's own autofocus where the dialog put it", () => {
    act(() =>
      root.render(
        createElement(
          ModalOverlay,
          null,
          createElement("button", { autoFocus: true }, "Close"),
        ),
      ),
    );

    // Its choice, not ours: pulling focus back up to the backdrop would put
    // the reader one Tab away from the control the dialog opened on.
    expect(document.activeElement).toBe(document.querySelector("button"));
  });

  it("stacks: the confirm covers the dialog, which comes back when it goes", () => {
    // The real shape — a ConfirmDialog renders its own ModalOverlay from
    // inside an already-open one (SkillsDialog's delete, WorkspaceForm's
    // nudge). Only exercised at the module level until now, and the module
    // cannot see React's mount order or its portals.
    function Stack({ confirm }: { confirm: boolean }) {
      return createElement(
        ModalOverlay,
        null,
        createElement("p", null, "dialog"),
        confirm
          ? createElement(
              ModalOverlay,
              { key: "c", children: createElement("p", null, "confirm") },
            )
          : null,
      );
    }

    act(() => root.render(createElement(Stack, { confirm: false })));
    const dialog = document.querySelector(".modal-overlay")!;

    act(() => root.render(createElement(Stack, { confirm: true })));
    const layers = document.querySelectorAll(".modal-overlay");
    expect(layers).toHaveLength(2);
    const confirm = layers[1];
    // Tab past the confirm's last control must not walk into the form it is
    // covering — the app root being inert is not enough on its own.
    expect(dialog.hasAttribute("inert")).toBe(true);
    expect(confirm.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(confirm);

    act(() => root.render(createElement(Stack, { confirm: false })));
    expect(dialog.hasAttribute("inert")).toBe(false);
    // And the dialog underneath gets the keyboard back: the engine blurred it
    // when it went inert, so lifting the attribute alone would leave it
    // interactive with focus on <body> and its own Tab order dead.
    expect(document.activeElement).toBe(dialog);
  });
});
