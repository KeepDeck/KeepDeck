import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TREE_ROW_ESTIMATE_PX, rowsPerPage } from "./treeLayout";
import { present } from "@keepdeck/plugin-api/testing";

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
    const row = present(/\.files__row \{([^}]*)\}/.exec(css), "the regex match")[1];
    const tokens = readFileSync(join(here, "..", "..", "..", "..", "src", "styles", "tokens.css"), "utf8");
    const font = Number(present(/--kd-font-small:\s*(\d+)px/.exec(tokens), "the regex match")[1]);
    const lineHeight = Number(present(/line-height:\s*([\d.]+);/.exec(row), "the regex match")[1]);
    // padding: top right bottom left — the rows' height takes top and bottom.
    const [, top, bottom] = present(/padding:\s*(\d+)px\s+\d+px\s+(\d+)px/.exec(row), "the regex match").map(Number);
    expect(row).toContain("font-size: var(--kd-font-small)");
    expect(TREE_ROW_ESTIMATE_PX).toBe(Math.ceil(top + bottom + font * lineHeight));
  });
});
