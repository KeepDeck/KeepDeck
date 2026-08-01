// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const STYLES_DIR = "src/styles";
const PLUGINS_DIR = "plugins";

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const stylesIndex = readFileSync(join(STYLES_DIR, "index.css"), "utf8");
const appCss = stripComments(
  [...stylesIndex.matchAll(/@import\s+"([^"]+)"\s*;/g)]
    .map((match) =>
      readFileSync(join(STYLES_DIR, match[1].replace(/^\.\//, "")), "utf8"),
    )
    .join("\n"),
);

/**
 * Every stylesheet the app ships — the host sheet AND each plugin's, which
 * loads into the SAME document and so obeys the same baseline. Enumerated from
 * disk rather than listed, because a list is one more thing to forget: the
 * whole point of the ownership test below is that a NEW sheet is covered on the
 * day it is added, not on the day someone remembers to add it here.
 */
function ownStylesheets(): { path: string; css: string }[] {
  const paths = readdirSync(STYLES_DIR)
    .filter((f) => f.endsWith(".css"))
    .map((f) => join(STYLES_DIR, f));
  for (const plugin of readdirSync(PLUGINS_DIR)) {
    const dir = join(PLUGINS_DIR, plugin, "src");
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // a plugin without a src/ of its own
    }
    paths.push(
      ...entries.filter((f) => f.endsWith(".css")).map((f) => join(dir, f)),
    );
  }
  return paths.map((path) => ({
    path,
    css: stripComments(readFileSync(path, "utf8")),
  }));
}

/**
 * happy-dom implements neither `user-select` nor a usable `cursor` readback —
 * the first reads empty even off a direct declaration. Carry both in custom
 * properties instead (the trick settings.test.ts uses for min()/calc() widths):
 * custom properties inherit exactly as these two do, so happy-dom's own
 * selector engine still decides every winner — specificity and source order —
 * rather than this test re-implementing a partial cascade. Both spellings of
 * user-select fold onto one property; base.css declares them together and
 * equal, so the collapse cannot invent a value.
 */
function track(css: string): string {
  return css
    .replace(
      /(^|[;{])(\s*)(?:-webkit-)?user-select(\s*:)/gm,
      "$1$2--selection-test$3",
    )
    .replace(/(^|[;{])(\s*)cursor(\s*:)/gm, "$1$2--cursor-test$3");
}

let sheet: HTMLStyleElement | undefined;

/**
 * Mounts the app's real stylesheet, then builds a DOM the way the app actually
 * builds it: the deck under `#root`, and portaled surfaces as SIBLINGS of it
 * directly under <body> — which is the whole point.
 */
function mount(html: string): void {
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.textContent = track(appCss);
    document.head.append(sheet);
  }
  document.body.innerHTML = html;
}

/**
 * The cascade's verdict for one node. happy-dom resolves which rules match a
 * given element (specificity and source order included) but does not propagate
 * an inherited custom property down the tree, so the walk up the ancestors is
 * this helper's job — that, and only that, is what it adds. An empty result
 * therefore means something precise and worth asserting: NOTHING anywhere
 * above this node states a policy. That was the bug — for every portaled
 * surface, the answer used to be exactly this.
 *
 * The emulation cannot model an explicit `initial`/`unset`/`revert`, which
 * would reset rather than inherit; the ownership test forbids those outright
 * so the gap stays closed rather than merely documented.
 */
function resolve(selector: string, property: string): string {
  const element = document.querySelector(selector);
  expect(element, `no element matched ${selector}`).not.toBeNull();
  for (
    let node: HTMLElement | null = element as HTMLElement;
    node;
    node = node.parentElement
  ) {
    const value = getComputedStyle(node).getPropertyValue(property).trim();
    if (value) return value;
  }
  return "";
}

/** What the pointer LOOKS like over this node, and what it can actually do. */
const behaviorOf = (selector: string) => ({
  cursor: resolve(selector, "--cursor-test"),
  selection: resolve(selector, "--selection-test"),
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("selection and cursor baseline", () => {
  it("shows a plain arrow over chrome, including chrome that portals OUT of the app root", () => {
    // Two independent failures met here. The cursor: WKWebView draws the I-beam
    // over plain text unless a `cursor` says otherwise — `user-select: none`
    // does NOT settle it, which is why the deck chrome below still looked like
    // a web page while carrying that rule. The reach: every dialog, popover and
    // tooltip mounts as a sibling of the app root and inherits nothing from it.
    mount(`
      <div id="root"><div class="deck"><span class="deck__brand">KeepDeck</span></div></div>
      <div class="modal-overlay">
        <div class="form settings">
          <h2 class="settings__title">Settings</h2>
          <label class="settings__toggle"><span>Experimental</span></label>
        </div>
      </div>
      <div class="minimized-tooltip"><span class="minimized-tooltip__name">agent</span></div>
    `);

    for (const selector of [
      ".deck__brand",
      ".settings__title",
      ".minimized-tooltip__name",
    ]) {
      expect(behaviorOf(selector), selector).toEqual({
        cursor: "default",
        selection: "none",
      });
    }
    // A clickable row keeps its hand — the label toggles the checkbox, and the
    // baseline must not flatten that into an arrow. Only the I-beam is wrong
    // here: the text is chrome you press, not text you select.
    expect(behaviorOf(".settings__toggle span")).toEqual({
      cursor: "pointer",
      selection: "none",
    });
  });

  it("keeps a portaled dialog's own fields editable and selectable", () => {
    // The risk the move to the document root introduces: the root now reaches
    // inside dialogs it never touched, and WebKit lets `none` kill selection
    // INSIDE a field — you could not select what you had typed.
    mount(`
      <div class="modal-overlay">
        <div class="form">
          <input class="form__input" />
          <textarea class="form__input skills__desc"></textarea>
          <button type="button" class="form__input dropdown__button">Pick one</button>
        </div>
      </div>
    `);

    // `auto`, not `text`: the engine still picks per control, so a checkbox
    // does not get an I-beam just for being an <input>.
    expect(behaviorOf("input.form__input")).toEqual({
      cursor: "auto",
      selection: "text",
    });
    expect(behaviorOf("textarea.form__input")).toEqual({
      cursor: "auto",
      selection: "text",
    });
    // Deliberately inert: the ui-kit Dropdown borrows the input LOOK for a
    // button, and its label is chrome, not text you edit.
    expect(behaviorOf("button.form__input").selection).toBe("none");
  });

  it("carries selection and cursor together on the opt-in and opt-out classes", () => {
    // Diagnostic text inside a portaled dialog is the case that regressed once
    // already: it was selectable only because the portal escaped the old rule,
    // and the baseline silently took that away. It now says so for itself.
    mount(`
      <div class="modal-overlay">
        <span class="settings__hint kd-selectable">keepdeck.git · failed: boom</span>
      </div>
      <div id="root"><div class="deck">
        <div class="peek__panel kd-selectable">
          <pre><span class="git__lineno kd-inert">12</span><span class="diff-line">+ line</span></pre>
        </div>
      </div></div>
    `);

    for (const selector of [
      ".settings__hint",
      ".peek__panel",
      // Inherits the island's opt-in — this is the peeked content itself.
      ".diff-line",
    ]) {
      // `auto`, not `text`, so the I-beam lands on an actual glyph run and the
      // arrow stays on the island's padding, header and empty space.
      expect(behaviorOf(selector), selector).toEqual({
        cursor: "auto",
        selection: "text",
      });
    }
    // The gutter opts back OUT inside that island, so a copied hunk carries no
    // line numbers — and the cursor stops promising a selection you cannot make.
    expect(behaviorOf(".git__lineno")).toEqual({
      cursor: "default",
      selection: "none",
    });
  });

  it("lets no stylesheet but base.css decide what is selectable", () => {
    // The pair — "can this be selected" and "what does the cursor say about
    // that" — is one decision, and the bug that shipped was the two halves
    // disagreeing. Binding them into .kd-selectable / .kd-inert only helps if
    // nothing else can state them, so that is what this asserts, over EVERY
    // sheet the app ships including the plugins'.
    //
    // Deliberately a property-presence check per file rather than a parse:
    // a regex that splits declaration blocks silently mis-reads CSS nesting
    // (`&:hover { … }` routes the real declarations into the selector half) and
    // would go green on exactly the regression it exists to catch.
    const sheets = ownStylesheets();
    // Guards the enumeration: an empty or truncated file list would make every
    // assertion below vacuously true.
    expect(sheets.length).toBeGreaterThanOrEqual(20);
    expect(sheets.map((s) => s.path)).toContain(join(STYLES_DIR, "base.css"));
    expect(sheets.some((s) => s.path.startsWith(PLUGINS_DIR))).toBe(true);

    for (const { path, css } of sheets) {
      const declaresSelection = /(?:^|[;{\s])(?:-webkit-)?user-select\s*:/.test(
        css,
      );
      expect(
        declaresSelection,
        `${path} declares user-select; use .kd-selectable / .kd-inert instead`,
      ).toBe(path === join(STYLES_DIR, "base.css"));

      // `initial`/`unset`/`revert` reset instead of inheriting, which neither
      // this file's ancestor walk nor a reader skimming the baseline models
      // correctly. Nothing needs them: the two classes cover both directions.
      const reset = css.match(/(?:^|[;{\s])cursor\s*:\s*(initial|unset|revert)/);
      expect(reset?.[1], `${path} resets the cursor with ${reset?.[1]}`).toBe(
        undefined,
      );
    }
  });
});
