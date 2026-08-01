// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const STYLES_DIR = "src/styles";
const stylesIndex = readFileSync(join(STYLES_DIR, "index.css"), "utf8");
const appCss = [...stylesIndex.matchAll(/@import\s+"([^"]+)"\s*;/g)]
  .map((match) =>
    readFileSync(join(STYLES_DIR, match[1].replace(/^\.\//, "")), "utf8"),
  )
  .join("\n");

/**
 * happy-dom does not implement `user-select` at all — it reads back empty even
 * off a direct declaration. Carry the value in a custom property instead (the
 * trick settings.test.ts uses for min()/calc() widths): custom properties
 * inherit exactly like `user-select` does, so happy-dom's own selector engine
 * still decides every winner — specificity, source order and inheritance —
 * rather than this test re-implementing a partial cascade. Both spellings fold
 * onto the same property; every block in the app declares them together and
 * equal, so the collapse cannot invent a value.
 */
function trackSelection(css: string): string {
  return css.replace(
    /(^|[;{])(\s*)(?:-webkit-)?user-select(\s*:)/gm,
    "$1$2--selection-test$3",
  );
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
    sheet.textContent = trackSelection(appCss);
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
 * above this node states a selection policy. That was the bug — for every
 * portaled surface, the answer used to be exactly this.
 */
const selectionOf = (selector: string): string => {
  const element = document.querySelector(selector);
  expect(element, `no element matched ${selector}`).not.toBeNull();
  for (
    let node: HTMLElement | null = element as HTMLElement;
    node;
    node = node.parentElement
  ) {
    const value = getComputedStyle(node)
      .getPropertyValue("--selection-test")
      .trim();
    if (value) return value;
  }
  return "";
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("selection baseline", () => {
  it("makes chrome unselectable even when it portals OUT of the app root", () => {
    // The regression this pins: every dialog, popover and tooltip mounts here,
    // as a sibling of the app root, inheriting nothing from it. While the
    // baseline lived on `.deck`, all of this text drew WebKit's I-beam.
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

    expect(selectionOf(".deck__brand")).toBe("none");
    expect(selectionOf(".settings__title")).toBe("none");
    expect(selectionOf(".settings__toggle span")).toBe("none");
    expect(selectionOf(".minimized-tooltip__name")).toBe("none");
  });

  it("keeps a portaled dialog's own fields editable and selectable", () => {
    // The risk the move introduces: the root `none` now reaches inside dialogs
    // it never touched before, and WebKit lets it kill selection INSIDE a
    // field — you could not select what you had typed.
    mount(`
      <div class="modal-overlay">
        <div class="form">
          <input class="form__input" />
          <textarea class="form__input skills__desc"></textarea>
          <button type="button" class="form__input dropdown__button">Pick one</button>
        </div>
      </div>
    `);

    expect(selectionOf("input.form__input")).toBe("text");
    expect(selectionOf("textarea.form__input")).toBe("text");
    // Deliberately NOT selectable: the ui-kit Dropdown borrows the input LOOK
    // for a button, and its label is chrome, not text you edit.
    expect(selectionOf("button.form__input")).toBe("none");
  });

  it("leaves the deliberate islands of real text selectable", () => {
    mount(`
      <div id="root"><div class="deck">
        <div class="pane__idle-session">Resume session: abc-123</div>
        <div class="peek"><div class="peek__panel"><pre><span class="diff-line">+ line</span></pre></div></div>
      </div></div>
    `);

    expect(selectionOf(".pane__idle-session")).toBe("text");
    expect(selectionOf(".peek__panel")).toBe("text");
    // Reaches the peeked content itself — this is the island the git and files
    // plugins' line-number gutters opt back OUT of (in their own stylesheets,
    // not loaded here) so a copied diff carries no line numbers.
    expect(selectionOf(".diff-line")).toBe("text");
  });
});
