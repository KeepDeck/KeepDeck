import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStyles, ruleBody, STYLES_DIR, stripComments } from "./testSupport";

/** Every host and built-in plugin stylesheet, comments stripped. */
function sheets(): [string, string][] {
  const host = readdirSync(STYLES_DIR)
    .filter((file) => file.endsWith(".css"))
    .map((file): [string, string] => [file, readStyles(file)]);
  const pluginsDir = join(STYLES_DIR, "../../plugins");
  const plugins = readdirSync(pluginsDir).flatMap((plugin) => {
    const dir = join(pluginsDir, plugin, "src");
    try {
      return readdirSync(dir)
        .filter((file) => file.endsWith(".css"))
        .map((file): [string, string] => [
          `${plugin}/${file}`,
          stripComments(readFileSync(join(dir, file), "utf8")),
        ]);
    } catch {
      return [];
    }
  });
  return [...host, ...plugins];
}

/** Things that cast the float shadow on purpose WITHOUT being a floating
 * card: the dock and the strip are docked panels lifted over the stage,
 * and the burn chart's tooltip takes its colours from the chart palette. */
const NOT_SHELLS = [".dock--floating", ".strip--revealed .strip__col", ".usage-burn-tooltip"];

describe("the float shell", () => {
  it("is float surface, seam edge and float shadow", () => {
    const shell = ruleBody(readStyles("float.css"), ".pane-drag-ghost");
    expect(shell).toEqual({
      border: "1px solid var(--kd-seam)",
      "background-color": "var(--kd-float)",
      "box-shadow": "var(--kd-shadow-float)",
    });
  });

  it("lives in float.css alone — no other sheet casts the float shadow itself", () => {
    // Thirteen hand copies drifted (two tooltips on tile, two edges on
    // seam-strong). A rule outside float.css that casts the shadow is a
    // shell copied again.
    const copies = sheets()
      .filter(([file]) => file !== "float.css")
      .flatMap(([file, css]) =>
        [...css.matchAll(/([^{}]+)\{[^{}]*box-shadow:\s*var\(--kd-shadow-float\)[^{}]*\}/g)]
          .map(([, selector]) => selector.trim())
          .filter((selector) => !NOT_SHELLS.includes(selector))
          .map((selector) => `${file}: ${selector}`),
      );
    expect(copies).toEqual([]);
  });
});
