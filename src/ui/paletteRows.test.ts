import { describe, expect, it } from "vitest";
import { clampCursor, paletteItemClassName, paletteRowHeight, paletteRows, stepCursor } from "./paletteRows";

const SECTIONS = [
  { title: "Tasks", items: [{ value: "a", label: "Draft the skill", hint: "To do" }, { value: "b", label: "Ship", hint: "In progress" }] },
  { title: "More", items: [{ value: "c", label: "Review the skill" }] },
];

describe("paletteRows", () => {
  it("lays every section out as one list, rows numbered across them all", () => {
    const { rows, count } = paletteRows(SECTIONS, "");
    expect(rows.map((row) => (row.kind === "section" ? row.title : `${row.at}:${row.item.value}`))).toEqual(["Tasks", "0:a", "1:b", "More", "2:c"]);
    expect(count).toBe(3);
  });

  it("matches a row's words or its hint, and drops a section left with none", () => {
    expect(paletteRows(SECTIONS, "progress").rows.map((row) => row.key)).toEqual(["section:Tasks", "item:b"]);
    expect(paletteRows(SECTIONS, "skill").count).toBe(2);
    expect(paletteRows(SECTIONS, "zzz")).toEqual({ rows: [], count: 0 });
  });
});

describe("the palette's cursor", () => {
  it("steps round the ends, and stays on a row that is there", () => {
    expect(stepCursor(2, 3, 1)).toBe(0);
    expect(stepCursor(0, 3, -1)).toBe(2);
    expect(stepCursor(0, 0, 1)).toBe(0);
    expect(clampCursor(5, 2)).toBe(1);
    expect(clampCursor(0, 0)).toBe(0);
  });
});

describe("a palette row's look", () => {
  it("guesses a heading shorter than a row, and marks the highlighted one", () => {
    const { rows } = paletteRows(SECTIONS, "");
    expect(rows.slice(0, 2).map(paletteRowHeight)).toEqual([28, 34]);
    expect(paletteItemClassName(true)).toBe("palette__item palette__item--active");
    expect(paletteItemClassName(false)).toBe("palette__item");
  });
});
