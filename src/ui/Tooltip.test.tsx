// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Tooltip } from "./Tooltip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

let root: Root;
afterEach(() => act(() => root.unmount()));

function render(extra: Record<string, unknown> = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(Tooltip, {
        tip: "the detail card",
        children: "the anchor",
        ...extra,
      }),
    ),
  );
  return host;
}

const over = (target: Element, type: string) =>
  act(() => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });

describe("Tooltip", () => {
  it("shows the tip while hovered, hides it after", () => {
    const host = render();
    const anchor = host.querySelector(".kd-tip__anchor")!;
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    over(anchor, "mouseover");
    // Portaled to the BODY — a scrolling ancestor must never clip it.
    const tip = document.querySelector('[role="tooltip"]')!;
    expect(tip.parentElement).toBe(document.body);
    expect(tip.textContent).toBe("the detail card");
    over(anchor, "mouseout");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("gets out of the way when the anchor is pressed", () => {
    // The failure this exists for: a menu button's own menu came up BEHIND
    // its explanation. The pointer has not moved, so nothing else was going
    // to dismiss the card, and it covered the thing the press had just asked
    // for.
    const host = render();
    const anchor = host.querySelector(".kd-tip__anchor")!;
    over(anchor, "mouseover");
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    act(() => {
      anchor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("keeps ONE tip open — a second anchor steals the spotlight", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement(Tooltip, { tip: "first", children: "a" }),
          createElement(Tooltip, { tip: "second", children: "b" }),
        ),
      ),
    );
    const anchors = host.querySelectorAll(".kd-tip__anchor");
    over(anchors[0], "mouseover");
    over(anchors[1], "mouseover"); // the first never saw a mouseout
    const tips = document.querySelectorAll('[role="tooltip"]');
    expect(tips).toHaveLength(1);
    expect(tips[0].textContent).toBe("second");
  });

  it("lets focus hold the tip through a brushing cursor", () => {
    const host = render({ focusable: true });
    const anchor = host.querySelector(".kd-tip__anchor") as HTMLElement;
    act(() => anchor.focus());
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    over(anchor, "mouseover");
    over(anchor, "mouseout"); // the mouse leaves, the FOCUS stays
    expect(document.querySelector('[role="tooltip"]')).not.toBeNull();
    act(() => anchor.blur());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
