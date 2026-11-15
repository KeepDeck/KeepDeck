import { describe, expect, it } from "vitest";
import { dropPlace, markAtY, type MarkRect } from "./stripDnd";

describe("markAtY", () => {
  const rects: MarkRect[] = [
    { id: "a", top: 0, bottom: 30 },
    { id: "b", top: 30, bottom: 60 },
    { id: "c", top: 60, bottom: 90 },
  ];

  it("returns the item whose vertical span contains the point", () => {
    expect(markAtY(15, rects)).toBe("a");
    expect(markAtY(45, rects)).toBe("b");
    expect(markAtY(75, rects)).toBe("c");
  });

  it("treats the bottom edge as the next item's (top-inclusive spans)", () => {
    expect(markAtY(30, rects)).toBe("b"); // y == a.bottom == b.top
    expect(markAtY(60, rects)).toBe("c");
  });

  it("clamps past either end to the nearest item", () => {
    expect(markAtY(-100, rects)).toBe("a"); // above the first
    expect(markAtY(1000, rects)).toBe("c"); // below the last
  });

  it("returns null when there are no items", () => {
    expect(markAtY(10, [])).toBeNull();
  });
});

describe("dropPlace", () => {
  const column = ["a", "b", "c", "d"];

  it("puts a mark dragged down after the mark under the pointer", () => {
    expect(dropPlace(column, "a", "c")).toEqual({ after: "c" });
    expect(dropPlace(column, "b", "c")).toEqual({ after: "c" });
  });

  it("puts a mark dragged up before the mark under the pointer", () => {
    expect(dropPlace(column, "d", "b")).toEqual({ before: "b" });
    expect(dropPlace(column, "c", "b")).toEqual({ before: "b" });
  });

  it("moves nothing over the dragged mark itself or a mark the column lacks", () => {
    expect(dropPlace(column, "b", "b")).toBeNull();
    expect(dropPlace(column, "b", "zz")).toBeNull();
    expect(dropPlace(column, "zz", "b")).toBeNull();
  });
});
