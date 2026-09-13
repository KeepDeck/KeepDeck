import { describe, expect, it } from "vitest";
import { DEFAULT_SECTIONS, readSections, toggleSection } from "./sections";

describe("sections", () => {
  it("opens with Changes alone", () => {
    expect(DEFAULT_SECTIONS).toEqual({ changes: true, history: false });
  });

  it("toggles one section and leaves the other as it was — both may be open", () => {
    const both = toggleSection(DEFAULT_SECTIONS, "history");
    expect(both).toEqual({ changes: true, history: true });
    expect(toggleSection(both, "changes")).toEqual({ changes: false, history: true });
    expect(toggleSection(toggleSection(both, "changes"), "history")).toEqual({
      changes: false,
      history: false,
    });
  });

  it("reads a stored state back, and the default for anything that is not one", () => {
    expect(readSections({ changes: false, history: true })).toEqual({
      changes: false,
      history: true,
    });
    expect(readSections(undefined)).toBe(DEFAULT_SECTIONS);
    expect(readSections({ changes: "yes" })).toBe(DEFAULT_SECTIONS);
    expect(readSections("history")).toBe(DEFAULT_SECTIONS);
  });
});
