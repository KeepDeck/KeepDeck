// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Segmented } from "./Segmented";

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
    act(() => radios()[0].click());
    expect(onChange).toHaveBeenCalledWith("list");
    expect(radios()[1].disabled).toBe(true);
    expect(radios()[1].title).toBe("Not here");
    render(true);
    expect(radios().every((r) => r.disabled)).toBe(true);
  });
});
