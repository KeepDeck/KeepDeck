// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MINIMIZED_TOOLTIP_DELAY_MS,
  MinimizedItem,
} from "./MinimizedItem";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("MinimizedItem", () => {
  let root: Root;
  const onClick = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    onClick.mockClear();
    act(() => {
      root.render(
        createElement(MinimizedItem, {
          variant: "chip",
          title: "A deliberately long agent title",
          gitBadge: {
            label: "fix/a-deliberately-long-branch",
            title: "fix/a-deliberately-long-branch",
          },
          label: "Restore A deliberately long agent title",
          active: true,
          onClick,
        }),
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("replaces native title bubbles with full details after hover intent", () => {
    const button = document.querySelector<HTMLButtonElement>(".minimized")!;
    expect(button.title).toBe("");
    expect(document.querySelector("[role='tooltip']")).toBeNull();

    act(() => {
      button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(MINIMIZED_TOOLTIP_DELAY_MS - 1);
    });
    expect(document.querySelector("[role='tooltip']")).toBeNull();

    act(() => vi.advanceTimersByTime(1));
    const tooltip = document.querySelector<HTMLElement>("[role='tooltip']")!;
    expect(tooltip.textContent).toContain("A deliberately long agent title");
    expect(tooltip.textContent).toContain("fix/a-deliberately-long-branch");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);

    act(() =>
      button.dispatchEvent(new MouseEvent("mouseout", { bubbles: true })),
    );
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("shows the same details immediately for keyboard focus", () => {
    const button = document.querySelector<HTMLButtonElement>(".minimized")!;
    act(() => button.focus());
    expect(document.querySelector("[role='tooltip']")?.textContent).toContain(
      "fix/a-deliberately-long-branch",
    );

    act(() => button.blur());
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });

  it("closes details and restores the agent on click", () => {
    const button = document.querySelector<HTMLButtonElement>(".minimized")!;
    act(() => button.focus());
    act(() => button.click());

    expect(onClick).toHaveBeenCalledOnce();
    expect(document.querySelector("[role='tooltip']")).toBeNull();
  });
});
