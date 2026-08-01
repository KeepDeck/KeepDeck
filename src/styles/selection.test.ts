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
  .join("\n")
  // Comments out, exactly as the browser drops them. Not cosmetic: these
  // stylesheets explain themselves, so a comment naming a property is common —
  // .peek__panel opens by citing the `user-select: none` it overrides — and a
  // reader that keeps them attributes prose to the rule below it.
  .replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * happy-dom implements neither `user-select` nor a usable `cursor` readback —
 * the first reads empty even off a direct declaration. Carry both in custom
 * properties instead (the trick settings.test.ts uses for min()/calc() widths):
 * custom properties inherit exactly as these two do, so happy-dom's own
 * selector engine still decides every winner — specificity and source order —
 * rather than this test re-implementing a partial cascade. Both spellings of
 * user-select fold onto one property; every block declares them together and
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

  it("offers the I-beam on the islands that really are selectable", () => {
    mount(`
      <div id="root"><div class="deck">
        <div class="pane__idle-session">Resume session: abc-123</div>
        <div class="peek"><div class="peek__panel"><pre><span class="diff-line">+ line</span></pre></div></div>
      </div></div>
    `);

    for (const selector of [
      ".pane__idle-session",
      ".peek__panel",
      // Reaches the peeked content itself — the island the git and files
      // plugins' line-number gutters opt back out of (in their own
      // stylesheets, not loaded here) so a copied diff carries no numbers.
      ".diff-line",
    ]) {
      expect(behaviorOf(selector), selector).toEqual({
        cursor: "text",
        selection: "text",
      });
    }
  });

  it("never lets the cursor disagree with what the text can actually do", () => {
    // The invariant the two rules above are instances of, checked against the
    // stylesheet as a whole so a NEW island cannot land half-done: opting text
    // back into selection without saying so with the cursor is exactly the bug
    // this file exists for, and it is invisible until someone hovers.
    // Declaration blocks only — the plugins ship their own sheets and carry the
    // same pairing (run/voice logs, the git and files gutters).
    const paired: Record<string, string[]> = {
      none: ["default"],
      text: ["text", "auto"],
    };
    const blocks = [...appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const selecting = blocks.filter(([, , body]) =>
      /(^|[;\s])(?:-webkit-)?user-select\s*:/.test(body),
    );
    // Guards the regex itself: a parse that silently matched nothing would let
    // every assertion below pass while checking absolutely nothing.
    expect(selecting.length).toBeGreaterThanOrEqual(5);

    for (const [, selector, body] of selecting) {
      const selection = body.match(/(?:^|[;\s])user-select\s*:\s*([\w-]+)/)?.[1];
      const cursor = body.match(/(?:^|[;\s])cursor\s*:\s*([\w-]+)/)?.[1];
      expect(
        cursor,
        `${selector.trim()} sets user-select but no cursor`,
      ).toBeDefined();
      expect(
        paired[selection!],
        `${selector.trim()} has an unpaired user-select: ${selection}`,
      ).toContain(cursor);
    }
  });
});
