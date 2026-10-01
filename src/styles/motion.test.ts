import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readStyles, STYLES_DIR } from "./testSupport";

/** Every selector in `css` that runs a status rhythm (status-* keyframes),
 * outside any at-rule. */
function rhythmic(css: string): string[] {
  const flat = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  return [...flat.matchAll(/([^{}]+)\{[^{}]*animation:[^;]*\bstatus-[\w-]+[^;]*;[^{}]*\}/g)].flatMap(
    ([, head]) => head.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
  );
}

/** Every selector a reduced-motion block in `css` puts to rest. */
function rested(css: string): Set<string> {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)];
  return new Set(
    blocks.flatMap(([, body]) =>
      [...body.matchAll(/([^{}]+)\{[^{}]*animation:\s*none[^{}]*\}/g)].flatMap(([, head]) =>
        head.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
      ),
    ),
  );
}

/** The host sheets in cascade order, as index.css imports them. */
function cascadeOrder(): string[] {
  return [...readStyles("index.css").matchAll(/@import "\.\/([\w-]+\.css)"/g)].map(([, file]) => file);
}

describe("status rhythms under reduced motion", () => {
  it("rest every element that runs one — the colour still says the state", () => {
    // The rest list is explicit, selector by selector: a new family of dots
    // (the strip's team rows) that is not added to it keeps pulsing for a
    // person who asked for stillness. A rest in ANOTHER sheet counts only if
    // that sheet comes later in the cascade — at equal specificity an
    // earlier `animation: none` loses to the rhythm.
    const order = cascadeOrder();
    const restless = order.flatMap((file, index) => {
      const restingSheets = order.slice(index).map((later) => rested(readStyles(later)));
      return rhythmic(readStyles(file))
        .filter((selector) => !restingSheets.some((rest) => rest.has(selector)))
        .map((selector) => `${file}: ${selector}`);
    });
    expect(restless).toEqual([]);
  });

  it("reads every sheet in the cascade", () => {
    const sheets = readdirSync(STYLES_DIR).filter((file) => file.endsWith(".css") && file !== "index.css");
    expect(new Set(cascadeOrder())).toEqual(new Set(sheets));
  });
});
