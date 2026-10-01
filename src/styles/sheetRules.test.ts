import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STYLES_DIR, stripComments } from "./testSupport";

/**
 * House rules read across EVERY host and built-in plugin sheet at once —
 * the kind a single component's test cannot see, and exactly the kind the
 * surfaces audit found broken in several places at the same time.
 */

type Body = Record<string, string>;

/** The sheet with every at-rule block (@media, @container, @keyframes…)
 * cut out: a declaration that holds only in a container or a media query
 * is not the thing's rest state, and must not be merged into it. */
function withoutAtRules(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    if (css[i] !== "@") {
      out += css[i++];
      continue;
    }
    const open = css.indexOf("{", i);
    const semi = css.indexOf(";", i);
    if (semi !== -1 && (open === -1 || semi < open)) {
      i = semi + 1; // a statement at-rule (@import)
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}" && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

/** Every flat rule, by selector (grouped selectors split; later rules for
 * the same selector merge over earlier ones, as the cascade would). */
function allRules(): Map<string, Body> {
  const pluginsDir = join(STYLES_DIR, "../../plugins");
  const files = [
    ...readdirSync(STYLES_DIR)
      .filter((file) => file.endsWith(".css"))
      .map((file) => join(STYLES_DIR, file)),
    ...readdirSync(pluginsDir).flatMap((plugin) => {
      const dir = join(pluginsDir, plugin, "src");
      try {
        return readdirSync(dir)
          .filter((file) => file.endsWith(".css"))
          .map((file) => join(dir, file));
      } catch {
        return [];
      }
    }),
  ];
  const rules = new Map<string, Body>();
  for (const file of files) {
    const css = withoutAtRules(stripComments(readFileSync(file, "utf8")));
    for (const [, head, body] of css.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
      const declarations: Body = Object.fromEntries(
        body
          .split(";")
          .filter((line) => line.includes(":"))
          .map((line) => {
            const colon = line.indexOf(":");
            return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
          }),
      );
      for (const selector of head.split(",").map((s) => s.trim().replace(/\s+/g, " "))) {
        rules.set(selector, { ...rules.get(selector), ...declarations });
      }
    }
  }
  return rules;
}

/** A longhand's value at rest, read through the shorthand that usually
 * sets it: `border: 1px solid X` sets border-color X, `background: X` sets
 * background-color X. Without this a hover that restates a shorthand's
 * colour through its longhand looks like a change. */
function restValue(rest: Body, property: string): string | undefined {
  if (property in rest) return rest[property];
  if (property === "border-color" && rest.border) {
    return rest.border.split(/\s+(?![^(]*\))/).find((part) => !/^(\d|solid|dashed|dotted|none)/.test(part));
  }
  if (property === "background-color" && rest.background) return rest.background;
  return undefined;
}

const hasWidth = (body: Body | undefined) =>
  body !== undefined && ("border" in body || "border-width" in body);

/** States that hold still under the pointer ON PURPOSE — each says so in
 * its own sheet: a picked choice (`.form__type--active`: "the pointer over
 * it changes nothing") and states that must not read as hoverable (a
 * copied or failed voice entry, the armed log toggle). */
const PINNED_AGAINST_HOVER = [
  ".form__type--active:hover:not(:disabled)",
  ".voice__entry--copied:hover",
  ".voice__entry--failed:hover",
  ".run__logcap-act--on:hover",
  // The open team's row stays selected under the pointer, never steps
  // down to the hover fill.
  ".strip__team--open:hover",
];

/** Extra classes that ride on the shared Button, whose variant gives the
 * border its width — the sheet cannot see the second class. */
const ON_SHARED_BUTTON = [".bar__update"];

describe("the sheets, read together", () => {
  const rules = allRules();

  it("never hover a thing into exactly how it already looks", () => {
    // A hover that restates the rest state is no hover (the voice chord
    // shipped one). Read for a class and its modifiers, plain or
    // `:not(:disabled)`; the few states pinned on purpose are named.
    const invisible = [...rules]
      .filter(([selector]) => /^\.[\w-]+:hover(:not\(:disabled\))?$/.test(selector))
      .filter(([selector]) => !PINNED_AGAINST_HOVER.includes(selector))
      .filter(([selector, hover]) => {
        const rest = rules.get(selector.slice(0, selector.indexOf(":hover")));
        const changed = Object.keys(hover);
        return (
          rest !== undefined &&
          changed.length > 0 &&
          changed.every((property) => restValue(rest, property) === hover[property])
        );
      })
      .map(([selector]) => selector);
    expect(invisible).toEqual([]);
  });

  it("never recolour or restyle an edge that has no width of its own", () => {
    // A state that sets only border-colour or -style draws the INITIAL
    // 3px width when the thing at rest has none — the tasks board shifted
    // 6px mid-drag that way. The rest state must reserve the edge.
    const widthless = [...rules]
      .filter(([, body]) => ("border-style" in body || "border-color" in body) && !hasWidth(body))
      .filter(([selector]) => {
        const state = /^(\.[\w-]+)(:.*)$/.exec(selector);
        const modifier = /^(\.[a-z0-9]+(?:[-_][a-z0-9]+)*?(?:__[a-z0-9-]+?)?)--/.exec(selector);
        if (!state && !modifier) return false; // not a state of a single class
        if (ON_SHARED_BUTTON.some((cls) => selector.startsWith(cls))) return false;
        const withoutPseudo = state ? state[1] : selector;
        const base = modifier ? modifier[1] : withoutPseudo;
        return !hasWidth(rules.get(withoutPseudo)) && !hasWidth(rules.get(base));
      })
      .map(([selector]) => selector);
    expect(widthless).toEqual([]);
  });
});
