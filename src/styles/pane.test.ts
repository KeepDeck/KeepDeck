// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { appCss } from "./testSupport";

/**
 * A stopped pane, built the way `AgentPane`/`AgentPaneHeader` build it
 * (AgentPane.tsx:289–437, AgentPaneHeader.tsx:87–170): the header's identity
 * and its one action cluster — badges AND window controls live in the same
 * cluster — then the body, the status card, and the resume line whose session
 * id is the longest unbreakable run the deck ever puts inside a tile.
 *
 * Hand-written rather than rendered, because mounting the real pane costs the
 * module mocks its own test file needs (xterm, the PTY registry) and this file
 * is about the cascade, not the component. The class names it leans on are not
 * free-floating: `AgentPane.test.tsx` and `AgentPaneHeader.test.tsx` query
 * them off the REAL components, so a rename breaks there before it can quietly
 * make this fixture meaningless.
 */
const STOPPED_PANE = `
  <div class="pane pane--idle" data-pane-id="p1">
    <div class="pane__bar">
      <div class="pane__identity">
        <span class="pane__agent"></span>
        <span class="pane__title">Проверяю функциональность MCP сервера</span>
      </div>
      <div class="pane__actions">
        <span class="chip pane__branch" title="kd/KeepDeck/6"
          ><span class="chip__icon"></span
          ><span class="chip__label">kd/KeepDeck/6</span></span
        >
        <button type="button" class="pane__action pane__action--minimize"></button>
        <button type="button" class="pane__action"></button>
        <button type="button" class="pane__action ui-close"></button>
      </div>
    </div>
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

/** The same agent minimized: the tray's stand-in, wearing the same shared
 * badges (MinimizedItem.tsx) so the two surfaces cannot drift apart. */
const STAND_IN = `
  <div class="minimized minimized--chip">
    <span class="minimized__agent"></span>
    <span class="minimized__title">Проверяю функциональность MCP сервера</span>
    <span class="chip chip--sm minimized__branch" title="kd/KeepDeck/6"
      ><span class="chip__icon"></span
      ><span class="chip__label">kd/KeepDeck/6</span></span
    >
    <span class="minimized__restore"></span>
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

  it("stops a pane painting past its own edge, without making it scrollable", () => {
    // The floor behind the fix above rather than a restatement of it: sizing
    // decides what SHOULD fit, this decides what happens when something
    // doesn't. It matters because the surface next door cannot defend itself —
    // a docked `.dock` is a static in-flow sibling of a positioned
    // `.deck__stage`, so the deck paints over it whenever it overflows.
    //
    // `hidden` would satisfy the first half and break the terminal: it makes
    // the pane a scroll container, and xterm keeps the textarea it focuses for
    // keystrokes at `left: -9999em`, so every keypress could scroll the tile
    // away from its own output. Only `clip` clips without scrolling.
    mount(STOPPED_PANE);

    expect(styleOf(".pane").overflow).toBe("clip");
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

describe("pane header", () => {
  it("yields the title, never the badge and control cluster", () => {
    // Flexbox shares a shortfall across EVERY shrinkable item, so the cluster
    // shrank alongside the title — and could not pass the pressure on, since
    // its buttons are all flex-none. They overflowed its box and the bar's
    // clip cut maximize and close: exactly the two the collapse cascade
    // promises never to hide. Shedding controls is the cascade's job at its
    // own breakpoints, not something a shortfall gets to improvise.
    mount(STOPPED_PANE);

    expect(styleOf(".pane__identity").flexShrink).toBe("1");
    expect(styleOf(".pane__actions").flexShrink).toBe("0");
  });

  it("never squeezes a branch badge below its own glyph", () => {
    // The chip cannot defend itself: the shared `.chip` sets `min-width: 0`
    // (chip.css), so a shrinkable branch badge collapses past its icon into a
    // sliver — still wearing `border-radius: 999px`, so it reads as a vertical
    // stadium with the glyph clipped off centre. pane.css claimed the opposite
    // ("No min-width:0 — the chip must never shrink below its icon") while
    // declaring nothing that made it true.
    //
    // Both surfaces, because the header and the tray stand-in deliberately
    // draw from one set of badges (ui-kit badges.tsx) and a fix to one of them
    // is a drift from the other.
    mount(STOPPED_PANE);
    expect(styleOf(".pane__branch").flexShrink).toBe("0");

    mount(STAND_IN);
    expect(styleOf(".minimized__branch").flexShrink).toBe("0");
  });
});
