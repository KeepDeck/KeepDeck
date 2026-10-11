// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isAway } from "./useAwayClose";

describe("isAway — whether a press or a focus has left the layer", () => {
  const tree = () => {
    document.body.innerHTML = "";
    const shell = document.body.appendChild(document.createElement("div"));
    const root = shell.appendChild(document.createElement("div"));
    const inRoot = root.appendChild(document.createElement("button"));
    const layer = shell.appendChild(document.createElement("ul"));
    const inLayer = layer.appendChild(document.createElement("li"));
    const sibling = shell.appendChild(document.createElement("button"));
    return { shell, root, inRoot, layer, inLayer, sibling };
  };

  it("inside the anchor or the portaled layer is never away, by press or focus", () => {
    const t = tree();
    for (const kind of ["pointer", "focus"] as const) {
      expect(isAway(kind, t.inRoot, t.root, t.layer)).toBe(false);
      expect(isAway(kind, t.inLayer, t.root, t.layer)).toBe(false);
    }
  });

  it("another control beside it is away, by press or focus", () => {
    const t = tree();
    expect(isAway("pointer", t.sibling, t.root, t.layer)).toBe(true);
    expect(isAway("focus", t.sibling, t.root, t.layer)).toBe(true);
  });

  it("the shell holding the anchor: focus landing there has not left, a press on it has", () => {
    const t = tree();
    expect(isAway("focus", t.shell, t.root, t.layer)).toBe(false);
    expect(isAway("pointer", t.shell, t.root, t.layer)).toBe(true);
    // Only a shell of the ANCHOR: what holds the layer alone is not one.
    const lone = document.body.appendChild(document.createElement("div"));
    const layer = lone.appendChild(document.createElement("ul"));
    expect(isAway("focus", lone, t.root, layer)).toBe(true);
  });

  it("with no anchor mounted, there is no shell to excuse", () => {
    const t = tree();
    expect(isAway("focus", t.shell, null, t.layer)).toBe(true);
  });
});
