// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { appCss } from "./testSupport";

/**
 * A stopped pane, built the way `AgentPane` builds it (AgentPane.tsx:289–437):
 * the pane, its body, the status card, and the resume line whose session id is
 * the longest unbreakable run the deck ever puts inside a tile.
 *
 * Hand-written rather than rendered, because mounting the real pane costs the
 * module mocks its own test file needs (xterm, the PTY registry) and this file
 * is about the cascade, not the component. The class names it leans on are not
 * free-floating: `AgentPane.test.tsx` queries `.pane__idle-session`,
 * `.pane__idle-session-id` and `.pane__card-action` off the REAL component, so
 * a rename breaks there before it can quietly make this fixture meaningless.
 */
const STOPPED_PANE = `
  <div class="pane pane--idle" data-pane-id="p1">
    <div class="pane__bar"></div>
    <div class="pane__body">
      <div class="pane__card" role="status">
        <span class="pane__exit-title">Stopped</span>
        <span
          class="pane__exit-sub pane__card-path pane__idle-session kd-selectable"
          title="019fbfec-5889-7533-a7b4-6cbb3f2f0f21"
        >Resume session: <span class="pane__idle-session-id">019fbfec-5889-7533-a7b4-6cbb3f2f0f21</span></span>
        <button type="button" class="pane__card-action">Resume</button>
      </div>
    </div>
  </div>
`;

let sheet: HTMLStyleElement | undefined;

function mount(html: string): void {
  if (!sheet) {
    sheet = document.createElement("style");
    sheet.textContent = appCss;
    document.head.append(sheet);
  }
  document.body.innerHTML = html;
}

const styleOf = (selector: string) => {
  const element = document.querySelector(selector);
  expect(element, `no element matched ${selector}`).not.toBeNull();
  return getComputedStyle(element as HTMLElement);
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pane layout", () => {
  it("lets a status card shrink to the pane it lives in", () => {
    // The bug this pins: `.pane__card` had no `min-width`, so its automatic
    // minimum was its min-content width — and its widest line is a session id
    // set in `white-space: nowrap`, which contributes its full width. The card
    // floored at the id and grew past a third-width pane, painting its opaque
    // background over the neighbour and over the docked dock beside the deck.
    //
    // Every step from the pane down has to be able to shrink for the tile to
    // hold its own content: one `auto` anywhere in the chain restores the
    // floor, and no layout engine here would notice.
    mount(STOPPED_PANE);

    for (const selector of [".pane", ".pane__body", ".pane__card"]) {
      expect(
        Number.parseFloat(styleOf(selector).minWidth),
        `${selector} keeps a min-content floor`,
      ).toBe(0);
    }
  });

  it("keeps the resume line's ellipsis promise inside the card", () => {
    // The line's own comment promises it is "ellipsized in a narrow tile; the
    // title carries the full id". That promise is only worth anything once the
    // card matches the pane: `max-width: 80%` resolves against the CARD, so
    // while the card was floored by this very line the percentage was 80% of
    // the overflow — which is how ids ended up cut mid-uuid, past the edge,
    // with no ellipsis in sight.
    mount(STOPPED_PANE);

    const line = styleOf(".pane__idle-session");
    expect(line.maxWidth).toBe("80%");
    expect(line.overflow).toBe("hidden");
    expect(line.textOverflow).toBe("ellipsis");
    expect(line.whiteSpace).toBe("nowrap");
    // The title attribute is the tail's only route once it ellipsizes.
    expect(document.querySelector(".pane__idle-session")).toHaveProperty(
      "title",
      "019fbfec-5889-7533-a7b4-6cbb3f2f0f21",
    );
  });
});
