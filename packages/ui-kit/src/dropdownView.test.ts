import { describe, expect, it } from "vitest";
import { closesMenu, dropdownView } from "./dropdownView";

const base = { options: [{ value: "a", label: "A" }, { value: "b", label: "B", disabled: true }], value: "a", open: true, variant: "field" as const, size: "md" as const, quiet: false };

describe("dropdownView — the Dropdown's decisions", () => {
  it("draws the menu only while open with something to pick", () => {
    expect(dropdownView(base).menuOpen).toBe(true);
    expect(dropdownView({ ...base, open: false }).menuOpen).toBe(false);
    expect(dropdownView({ ...base, options: [] }).menuOpen).toBe(false);
    expect(dropdownView({ ...base, options: [base.options[0]] }).menuOpen).toBe(true);
  });

  it("names the picked option in the closed control, or the raw value", () => {
    expect(dropdownView(base).current).toBe("A");
    expect(dropdownView({ ...base, value: "z" }).current).toBe("z");
  });

  it("marks the picked option alone, and carries a refused one as refused", () => {
    expect(dropdownView(base).items).toEqual([
      { value: "a", label: "A", disabled: false, selected: true, className: "dropdown__option dropdown__option--active" },
      { value: "b", label: "B", disabled: true, selected: false, className: "dropdown__option" },
    ]);
  });

  it("dresses the control by its variant, size and quiet, and sizes the menu from the anchor or its content", () => {
    expect(dropdownView(base).className).toBe("dropdown");
    expect(dropdownView({ ...base, variant: "inline", size: "sm", quiet: true, className: "x" }).className).toBe(
      "dropdown dropdown--inline dropdown--sm dropdown--quiet x",
    );
    expect([dropdownView(base).widthFrom, dropdownView({ ...base, variant: "inline" }).widthFrom]).toEqual(["anchor", "content"]);
  });

  it("closes on Escape while open, and on nothing else", () => {
    expect([closesMenu("Escape", true), closesMenu("Escape", false), closesMenu("Enter", true)]).toEqual([true, false, false]);
  });
});
