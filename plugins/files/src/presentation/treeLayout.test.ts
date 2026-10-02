import { describe, expect, it } from "vitest";
import { TREE_ROW_ESTIMATE_PX, rowsPerPage } from "./treeLayout";

describe("rowsPerPage", () => {
  it("is the whole rows the box shows", () => {
    expect(rowsPerPage(10 * TREE_ROW_ESTIMATE_PX + 5)).toBe(10);
  });

  it("is at least one — a box not laid out yet still moves the cursor", () => {
    expect(rowsPerPage(0)).toBe(1);
  });
});
