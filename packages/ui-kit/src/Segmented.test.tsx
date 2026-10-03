// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Segmented, segmentStep } from "./Segmented";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Segmented", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));
  const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

  it("is a named radiogroup, the chosen one checked and plated", () => {
    act(() =>
      root.render(
        createElement(Segmented<boolean>, {
          ariaLabel: "Tasks",
          options: [
            { value: true, label: "On" },
            { value: false, label: "Off" },
          ],
          value: false,
          onChange: () => {},
        }),
      ),
    );
    const group = document.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Tasks");
    expect(group.className).toBe("form__types");
    expect(radios().map((r) => [r.textContent, r.getAttribute("aria-checked"), r.className])).toEqual([
      ["On", "false", "form__type"],
      ["Off", "true", "form__type form__type--active"],
    ]);
  });

  it("emits the pressed option's value; a disabled group or option emits nothing", () => {
    const onChange = vi.fn();
    const render = (disabled: boolean) =>
      act(() =>
        root.render(
          createElement(Segmented<string>, {
            options: [
              { value: "list", label: "List" },
              { value: "board", label: "Board", disabled: true, title: "Not here" },
            ],
            value: "list",
            onChange,
            disabled,
            size: "sm",
          }),
        ),
      );
    render(false);
    expect(document.querySelector('[role="radiogroup"]')!.className).toBe("form__types form__types--sm");
    // Small: the small secondary button's own box — no second look.
    expect(radios()[0].className).toBe("kd-btn kd-btn--secondary kd-btn--sm");
    expect(radios()[0].getAttribute("aria-checked")).toBe("true");
    // The option already chosen changes nothing — no write of the same value.
    act(() => radios()[0].click());
    expect(onChange).not.toHaveBeenCalled();
    expect(radios()[1].disabled).toBe(true);
    expect(radios()[1].title).toBe("Not here");
    render(true);
    expect(radios().every((r) => r.disabled)).toBe(true);
  });

  it("is one Tab stop — the chosen option; arrows move the focus, and only Space or Enter chooses", () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        createElement(Segmented<string>, {
          ariaLabel: "Priority",
          options: [
            { value: "high", label: "High" },
            { value: "normal", label: "Normal", disabled: true },
            { value: "low", label: "Low" },
          ],
          value: "high",
          onChange,
        }),
      ),
    );
    expect(radios().map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    const press = (at: number, key: string) => {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      act(() => void radios()[at].dispatchEvent(event));
      return event.defaultPrevented;
    };
    expect(press(0, "ArrowRight")).toBe(true);
    expect(document.activeElement).toBe(radios()[2]);
    // A stray arrow chose nothing — a choice here may close pages.
    expect(onChange).not.toHaveBeenCalled();
    expect(press(2, "ArrowLeft")).toBe(true);
    expect(document.activeElement).toBe(radios()[0]);
    expect(press(0, "End")).toBe(true);
    expect(document.activeElement).toBe(radios()[2]);
    // Up and Down are the page's: they scroll it.
    expect(press(2, "ArrowDown")).toBe(false);
    act(() => radios()[2].click());
    expect(onChange).toHaveBeenLastCalledWith("low");
  });
});

describe("segmentStep", () => {
  const none = [false, false, false];
  it("steps either way, wrapping, past disabled options; Home and End go to the ends", () => {
    expect(segmentStep("ArrowRight", 0, none)).toBe(1);
    expect(segmentStep("ArrowRight", 2, none)).toBe(0);
    expect(segmentStep("ArrowLeft", 0, none)).toBe(2);
    expect(segmentStep("ArrowLeft", 1, none)).toBe(0);
    expect(segmentStep("ArrowLeft", 2, [false, true, false])).toBe(0);
    expect(segmentStep("ArrowRight", 0, [false, true, false])).toBe(2);
    expect(segmentStep("Home", 2, none)).toBe(0);
    expect(segmentStep("End", 0, none)).toBe(2);
    expect(segmentStep("End", 0, [false, false, true])).toBe(1);
  });

  it("goes nowhere for another key, or when nothing else may be chosen", () => {
    expect(segmentStep("Enter", 0, none)).toBeNull();
    expect(segmentStep("ArrowDown", 0, none)).toBeNull();
    expect(segmentStep("ArrowUp", 1, none)).toBeNull();
    expect(segmentStep("ArrowRight", 0, [false, true, true])).toBeNull();
    expect(segmentStep("Home", 0, none)).toBeNull();
  });
});
