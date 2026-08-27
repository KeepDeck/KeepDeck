// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button, type ButtonProps } from "./Button";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Button", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (props: Partial<ButtonProps> = {}) =>
    act(() =>
      root.render(
        createElement(Button, {
          onClick: () => {},
          children: "Do it",
          ...props,
        }),
      ),
    );
  const button = () => host.querySelector("button")!;

  it("is a quiet neighbour until something says otherwise", () => {
    // `secondary` is the default because promoting an action has to be a
    // decision somebody made, not what you get by leaving a prop out.
    render();
    expect(button().className).toBe("kd-btn kd-btn--secondary");
    expect(button().type).toBe("button");
  });

  it("keeps chrome and geometry on separate axes", () => {
    // The two never reach into each other: a small primary is the same colour
    // as a medium one, and the same box as a small secondary. Mixing them is
    // how the app got a different button per screen.
    render({ variant: "primary", size: "sm" });
    expect(button().className).toBe("kd-btn kd-btn--primary kd-btn--sm");
    render({ variant: "ghost" });
    expect(button().className).toBe("kd-btn kd-btn--ghost");
  });

  it("names itself by its tooltip, and separately when the two must differ", () => {
    // A toggle's tooltip says what pressing it will DO and flips with state;
    // its accessible name has to keep saying what it IS.
    render({ title: "Open settings" });
    expect(button().getAttribute("aria-label")).toBe("Open settings");
    render({ title: "Hide the dock", label: "Toggle dock panel" });
    expect(button().getAttribute("aria-label")).toBe("Toggle dock panel");
    expect(button().title).toBe("Hide the dock");
  });

  it("refuses a press while disabled, and says so once", () => {
    const onClick = vi.fn();
    render({ disabled: true, onClick });
    act(() => button().click());
    expect(onClick).not.toHaveBeenCalled();
    expect(button().disabled).toBe(true);
  });

  it("carries a caller's one-off class without losing its own", () => {
    render({ className: "bell__anchor" });
    expect(button().className).toBe("kd-btn kd-btn--secondary bell__anchor");
  });
});
