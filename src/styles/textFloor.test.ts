import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readStyles, STYLES_DIR, stripComments } from "./testSupport";

/** The only things that may be painted in --kd-text-4: marks (a glyph, a
 * ring, a separator) and disabled states. Everything a person READS sits
 * at --kd-text-3 or above (tokens.css). Classified in task-140. */
const MARKS_AND_DISABLED = [
  ".deck__crumb-sep", // the "/" between crumbs
  ".strip__tile .strip__dot--idle", // the idle dot's hollow ring
  ".minimized__status--stopped", // the stopped dot's hollow ring
  ".tasks__remove", // the × that detaches a row
  ".artifacts__remove", // the same ×
  ".tasks__card--cancelled .tasks__card-title", // a cancelled task
  ".tasks__link:disabled",
];

function sheets(): [string, string][] {
  const host = readdirSync(STYLES_DIR)
    .filter((file) => file.endsWith(".css") && file !== "tokens.css")
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

describe("the reading floor", () => {
  it("paints nothing a person reads in --kd-text-4 — only marks and disabled states", () => {
    const offenders = sheets().flatMap(([file, css]) =>
      [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, , body]) => body.includes("var(--kd-text-4)"))
        .map(([, selector]) => selector.trim().replace(/\s+/g, " "))
        .filter((selector) => !MARKS_AND_DISABLED.includes(selector))
        .map((selector) => `${file}: ${selector}`),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps no stale allowance — every allowed selector still paints text-4", () => {
    const painting = new Set(
      sheets().flatMap(([, css]) =>
        [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
          .filter(([, , body]) => body.includes("var(--kd-text-4)"))
          .map(([, selector]) => selector.trim().replace(/\s+/g, " ")),
      ),
    );
    expect(MARKS_AND_DISABLED.filter((selector) => !painting.has(selector))).toEqual([]);
  });
});
