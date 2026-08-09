// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inertBackground } from "./inertBackground";

// happy-dom implements HALF of `inert`: it refuses `.focus()` on anything
// inside an inert subtree (HTMLElementUtility.focus -> isInert), which is what
// the focus-refusal test below rests on. It does NOT run the focus-fixup rule,
// so marking an ancestor inert does not blur an ALREADY-focused descendant —
// that half is a browser fact these tests cannot reach, and the attribute
// assertions stand in for it.

// The stack is per-document, so it is module state — and every push here is
// popped, because an unbalanced one is a caller bug, not a case to tolerate.
// Tracking them keeps an early `expect` failure from stranding the stack.
let releases: (() => void)[] = [];

function push(layer: Element): () => void {
  const release = inertBackground(layer);
  releases.push(release);
  return release;
}

function child(className: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
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
    const layer = child("modal-overlay");

    push(layer);

    expect(app.hasAttribute("inert")).toBe(true);
    expect(layer.hasAttribute("inert")).toBe(false);
  });

  it("actually refuses the keyboard to the background, not just marks it", () => {
    const app = child("app-root");
    const behind = document.createElement("button");
    app.appendChild(behind);

    push(child("modal-overlay"));

    behind.focus();
    // The whole point of using the platform rather than modelling focus: a
    // pane behind the dialog CANNOT take the keyboard, even if something asks
    // it to. Marking the attribute would be worthless if this did not hold.
    expect(document.activeElement).not.toBe(behind);
  });

  it("makes the dialog UNDER a stacked layer background too", () => {
    const app = child("app-root");
    const dialog = child("modal-overlay");
    push(dialog);
    const confirm = child("modal-overlay");
    push(confirm);

    // Without this, Tab past the confirm's last control wraps around, skips
    // the inert app root, and lands in the form the confirm is covering.
    expect(dialog.hasAttribute("inert")).toBe(true);
    expect(confirm.hasAttribute("inert")).toBe(false);
    expect(app.hasAttribute("inert")).toBe(true);
  });

  it("gives the covered dialog back when the layer above it goes", () => {
    child("app-root");
    const dialog = child("modal-overlay");
    push(dialog);
    const releaseConfirm = push(child("modal-overlay"));

    releaseConfirm();

    expect(dialog.hasAttribute("inert")).toBe(false);
  });

  it("holds the background inert until the LAST layer leaves", () => {
    const app = child("app-root");
    const releaseDialog = push(child("modal-overlay"));
    const releaseConfirm = push(child("modal-overlay"));

    releaseConfirm();
    // The dialog is still up — lifting here would hand the keyboard back to
    // a pane the user cannot even see.
    expect(app.hasAttribute("inert")).toBe(true);

    releaseDialog();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("survives layers released out of order", () => {
    const app = child("app-root");
    const dialog = child("modal-overlay");
    const releaseDialog = push(dialog);
    const confirm = child("modal-overlay");
    const releaseConfirm = push(confirm);

    // The owner leaving first is the order a refcount could not survive: it
    // would have decremented to 1 and left the background derived from a
    // layer that no longer exists.
    releaseDialog();
    expect(app.hasAttribute("inert")).toBe(true);
    expect(confirm.hasAttribute("inert")).toBe(false);

    releaseConfirm();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("survives a release called twice", () => {
    const app = child("app-root");
    const releaseDialog = push(child("modal-overlay"));
    const releaseConfirm = push(child("modal-overlay"));

    releaseConfirm();
    releaseConfirm();

    expect(app.hasAttribute("inert")).toBe(true);
    releaseDialog();
    expect(app.hasAttribute("inert")).toBe(false);
  });
});
