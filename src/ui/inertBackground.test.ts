// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODAL_OVERLAY_CLASS, inertBackground } from "./inertBackground";

// happy-dom reflects the `inert` attribute but does NOT implement its
// semantics — it will not refuse focus or blur what is inside. These tests
// therefore pin the CONTRACT (which nodes carry the marker, and which are
// restored); that the engine acts on it is a browser fact, not a jsdom one.

// The count is per-document, so it is module state — and every acquire here
// is released, because an unbalanced one is a caller bug, not a case to
// tolerate. Tracking them makes an early `expect` failure unable to strand
// the count for the next test.
let releases: (() => void)[] = [];

function acquire(layer: Element): () => void {
  const release = inertBackground(layer);
  releases.push(release);
  return release;
}

function child(className?: string): HTMLElement {
  const node = document.createElement("div");
  if (className) node.className = className;
  document.body.appendChild(node);
  return node;
}

describe("inertBackground", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    for (const release of releases) release();
    releases = [];
  });

  it("makes the layer's siblings inert and leaves the layer itself alive", () => {
    const app = child("app-root");
    const layer = child(MODAL_OVERLAY_CLASS);

    acquire(layer);

    expect(app.hasAttribute("inert")).toBe(true);
    expect(layer.hasAttribute("inert")).toBe(false);
  });

  it("spares a second layer that mounted in the same commit", () => {
    const app = child("app-root");
    const under = child(MODAL_OVERLAY_CLASS);
    const over = child(MODAL_OVERLAY_CLASS);

    acquire(under);

    // Both are layers, so both stay interactive; only the app behind them
    // goes inert. Without the class check the dialog UNDER the confirm would
    // be dead by the time the user got back to it.
    expect(over.hasAttribute("inert")).toBe(false);
    expect(app.hasAttribute("inert")).toBe(true);
  });

  it("holds the background inert until the LAST layer leaves", () => {
    const app = child("app-root");
    const releaseDialog = acquire(child(MODAL_OVERLAY_CLASS));
    const releaseConfirm = acquire(child(MODAL_OVERLAY_CLASS));

    releaseConfirm();
    // The dialog is still up — lifting here would hand the keyboard back to
    // a pane the user cannot even see.
    expect(app.hasAttribute("inert")).toBe(true);

    releaseDialog();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("restores exactly what it took, never a node that came in inert", () => {
    const app = child("app-root");
    const alreadyInert = child("hidden-thing");
    alreadyInert.setAttribute("inert", "");

    acquire(child(MODAL_OVERLAY_CLASS))();

    expect(app.hasAttribute("inert")).toBe(false);
    // Not ours to give back: something else is holding this one inert for a
    // reason of its own.
    expect(alreadyInert.hasAttribute("inert")).toBe(true);
  });

  it("survives a release called twice without unbalancing the count", () => {
    const app = child("app-root");
    const releaseDialog = acquire(child(MODAL_OVERLAY_CLASS));
    const releaseConfirm = acquire(child(MODAL_OVERLAY_CLASS));

    releaseConfirm();
    releaseConfirm();

    // A double teardown (StrictMode, a remount race) must not decrement past
    // the dialog that is still standing.
    expect(app.hasAttribute("inert")).toBe(true);
    releaseDialog();
    expect(app.hasAttribute("inert")).toBe(false);
  });
});
