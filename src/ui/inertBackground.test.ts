// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inertBackground, isBehindModalLayer } from "./inertBackground";

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

function push(layer: HTMLElement): () => void {
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

/** A layer as `ModalOverlay` builds one: a body child that can hold focus. */
function layer(): HTMLElement {
  const node = child("modal-overlay");
  node.tabIndex = -1;
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
    const top = layer();

    push(top);

    expect(app.hasAttribute("inert")).toBe(true);
    expect(top.hasAttribute("inert")).toBe(false);
  });

  it("actually refuses the keyboard to the background, not just marks it", () => {
    const app = child("app-root");
    const behind = document.createElement("button");
    app.appendChild(behind);

    const top = layer();
    push(top);

    behind.focus();
    // The whole point of using the platform rather than modelling focus: a
    // pane behind the dialog CANNOT take the keyboard, even if something asks
    // it to. Marking the attribute would be worthless if this did not hold —
    // and the keyboard stays with the live surface rather than falling to
    // <body>.
    expect(document.activeElement).toBe(top);
  });

  it("gives the keyboard to the layer it pushes", () => {
    child("app-root");
    const top = layer();

    push(top);

    expect(document.activeElement).toBe(top);
  });

  it("leaves the keyboard where the layer already placed it", () => {
    child("app-root");
    const top = layer();
    const own = document.createElement("button");
    top.appendChild(own);
    own.focus();

    push(top);

    // A dialog that autofocuses its own control has already run by the time
    // the shell pushes; taking it back would undo a deliberate choice.
    expect(document.activeElement).toBe(own);
  });

  it("makes the dialog UNDER a stacked layer background too", () => {
    const app = child("app-root");
    const dialog = layer();
    push(dialog);
    const confirm = layer();
    push(confirm);

    // Without this, Tab past the confirm's last control wraps around, skips
    // the inert app root, and lands in the form the confirm is covering.
    expect(dialog.hasAttribute("inert")).toBe(true);
    expect(confirm.hasAttribute("inert")).toBe(false);
    expect(app.hasAttribute("inert")).toBe(true);
  });

  it("hands the keyboard back to the covered dialog when the layer above it goes", () => {
    child("app-root");
    const dialog = layer();
    push(dialog);
    const releaseConfirm = push(layer());

    releaseConfirm();

    // The engine blurred the dialog when it went inert, so lifting the
    // attribute is not enough — without this the surviving dialog is
    // interactive with the keyboard on <body>, and its own arrow/Tab
    // navigation is dead until the user clicks.
    expect(dialog.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(dialog);
  });

  it("holds the background inert until the LAST layer leaves", () => {
    const app = child("app-root");
    const releaseDialog = push(layer());
    const releaseConfirm = push(layer());

    releaseConfirm();
    expect(app.hasAttribute("inert")).toBe(true);

    releaseDialog();
    expect(app.hasAttribute("inert")).toBe(false);
  });

  it("survives layers released out of order", () => {
    const app = child("app-root");
    const releaseDialog = push(layer());
    const confirm = layer();
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
    const releaseDialog = push(layer());
    const releaseConfirm = push(layer());

    releaseConfirm();
    releaseConfirm();

    expect(app.hasAttribute("inert")).toBe(true);
    releaseDialog();
    expect(app.hasAttribute("inert")).toBe(false);
  });
});

describe("isBehindModalLayer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    for (const release of releases) release();
    releases = [];
  });

  it("answers no while nothing is stacked", () => {
    const app = child("app-root");
    expect(isBehindModalLayer(app)).toBe(false);
  });

  it("puts everything outside the top layer behind it", () => {
    const app = child("app-root");
    const top = layer();
    const inside = document.createElement("button");
    top.appendChild(inside);
    const sibling = child("some-popover");

    push(top);

    expect(isBehindModalLayer(app)).toBe(true);
    // A popover portaled to <body> is a sibling of the layer, not part of it.
    expect(isBehindModalLayer(sibling)).toBe(true);
    expect(isBehindModalLayer(inside)).toBe(false);
    expect(isBehindModalLayer(top)).toBe(false);
  });

  it("follows the top of the stack, not the bottom", () => {
    child("app-root");
    const dialog = layer();
    push(dialog);
    const releaseConfirm = push(layer());

    expect(isBehindModalLayer(dialog)).toBe(true);
    releaseConfirm();
    expect(isBehindModalLayer(dialog)).toBe(false);
  });
});
