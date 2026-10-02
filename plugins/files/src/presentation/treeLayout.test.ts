import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

describe("TREE_ROW_ESTIMATE_PX", () => {
  it("is the row the stylesheet draws — padding and one line of its type, rounded up", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "..", "styles.css"), "utf8");
    const row = /\.files__row \{([^}]*)\}/.exec(css)![1];
    const tokens = readFileSync(join(here, "..", "..", "..", "..", "src", "styles", "tokens.css"), "utf8");
    const font = Number(/--kd-font-small:\s*(\d+)px/.exec(tokens)![1]);
    const lineHeight = Number(/line-height:\s*([\d.]+);/.exec(row)![1]);
    // padding: top right bottom left — the rows' height takes top and bottom.
    const [, top, bottom] = /padding:\s*(\d+)px\s+\d+px\s+(\d+)px/.exec(row)!.map(Number);
    expect(row).toContain("font-size: var(--kd-font-small)");
    expect(TREE_ROW_ESTIMATE_PX).toBe(Math.ceil(top + bottom + font * lineHeight));
  });
});
