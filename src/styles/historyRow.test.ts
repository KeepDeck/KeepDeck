import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

// The data row's layout contract, read from the shipped stylesheet: the
// geometry no DOM can answer in happy-dom (tracks are never resolved
// there), so the SOURCE is the witness. Pinned exactly — template,
// display, and the clip side of the folder label — because "almost the
// same template" is how the ragged rows came back the first time.
describe("history data row layout contract", () => {
  const css = readStyles("history.css");

  it("the data row is a grid with ONE explicit template shared by every row", () => {
    const rule = ruleBody(css, ".history__datarow");
    expect(rule["display"]).toBe("grid");
    // Whitespace-normalized, comments stripped: the nine tracks in
    // order, explicit — auto/max-content would size per row and rebuild
    // the same raggedness in new clothes.
    const template = rule["grid-template-columns"].replace(/\s+/g, " ").trim();
    expect(template).toBe(
      "7px 16px minmax(220px, 1fr) minmax(0px, 180px) 120px 64px 96px 72px 56px",
    );
  });

  it("the folder label clips from the LEFT: scoped rtl on the clipping wrapper", () => {
    const rule = ruleBody(css, ".history__cwd .chip__label");
    expect(rule["direction"]).toBe("rtl");
    // The clipping itself is the chip's own label slot — the ellipsis
    // half of the pair must stand beside the rtl half.
    const chipCss = readStyles("chip.css");
    expect(ruleBody(chipCss, ".chip__label")["text-overflow"]).toBe(
      "ellipsis",
    );
    // And the direction NEVER leaks anywhere else in this sheet — one
    // declaration total; on the row or a slot it would reverse the
    // column order.
    const everyDirection = [
      ...css.matchAll(/(?<![-\w])direction\s*:\s*[^;}]+[;}]/g),
    ].map((m) => m[0].trim());
    expect(everyDirection).toEqual(["direction: rtl;"]);
  });
});
