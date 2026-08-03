import { readFileSync } from "node:fs";
import { join } from "node:path";

export const STYLES_DIR = "src/styles";

/**
 * CSS with its comments stripped. Some of these tests read the SOURCE rather
 * than the cascade — the cases no DOM can answer, like whether a rule inside a
 * container query still matches the shared rule it copies — and a comment can
 * hold anything a naive scan would trip over, braces included.
 */
export const stripComments = (css: string): string =>
  css.replace(/\/\*[\s\S]*?\*\//g, "");

/** One stylesheet, comments gone — the form the source readers below want. */
export const readStyles = (file: string): string =>
  stripComments(readFileSync(join(STYLES_DIR, file), "utf8"));

/**
 * The declarations of ONE flat rule, by selector, for the questions no DOM can
 * answer: happy-dom evaluates no `@container` at all, so a rule that lives
 * inside one is only reachable as text.
 *
 * The body pattern is deliberately `[^{}]*`: a rule that ever gains nesting
 * stops matching and the caller fails loudly, rather than a looser scan
 * quietly reading the wrong half of it. Values are read after `stripComments`,
 * and a declaration whose VALUE contains a brace (a generated `content`
 * string) would defeat that — so this refuses to guess, and callers pass
 * `from` to pick a copy inside a query over the base rule above it.
 */
export function ruleBody(
  css: string,
  selector: string,
  from = 0,
): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(
    css.slice(from),
  );
  if (!match) throw new Error(`no flat rule for ${selector}`);
  if (/["']/.test(match[1])) {
    throw new Error(
      `${selector} has a quoted value — this reader cannot tell a brace in a string from the end of a rule`,
    );
  }
  return Object.fromEntries(
    match[1]
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [
          declaration.slice(0, colon).trim(),
          declaration.slice(colon + 1).trim(),
        ];
      }),
  );
}

/** A declaration's leading number, e.g. `23px` or `min(180px, 44vw)` → 23/180. */
export function px(value: string): number {
  const match = /(\d+(?:\.\d+)?)px/.exec(value);
  if (!match) throw new Error(`no px length in "${value}"`);
  return Number(match[1]);
}

/**
 * The app's real stylesheet, assembled the way the app assembles it: every
 * sheet `index.css` imports, in import order, so a style test mounts what
 * ships rather than the one file it happens to be about. Source order is the
 * whole point — the cascade's tie-breaker is what several of these tests are
 * actually asserting.
 *
 * Shared because three test files needed it and a fourth would have copied
 * the import walk again; each caller still owns its own transform (happy-dom
 * drops some values and has to be handed them as custom properties) and its
 * own fixture.
 */
export const appCss = [
  ...readFileSync(join(STYLES_DIR, "index.css"), "utf8").matchAll(
    /@import\s+"([^"]+)"\s*;/g,
  ),
]
  .map((match) =>
    readFileSync(join(STYLES_DIR, match[1].replace(/^\.\//, "")), "utf8"),
  )
  .join("\n");
