// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentPaneHeader } from "../components/agent/AgentPaneHeader";
import { MinimizedItem } from "../components/deck/MinimizedItem";
import { AppRuntimeProvider } from "../app/runtimeContext";
import { createAgentStatusTracker } from "../app/agentStatusTracker";
import type { AppRuntime } from "../app/runtime";
import { appCss, px, readStyles, ruleBody } from "./testSupport";
import { paneHeaderView } from "../presentation/paneHeaderView";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The pane's own wrappers, hand-written: mounting the real `AgentPane` costs
 * the module mocks its test file needs (xterm, the PTY registry), and this file
 * is about the cascade, not the component. The nesting below is not taken on
 * trust — `AgentPane.test.tsx` asserts that a stopped pane really renders
 * `.pane > .pane__body > .pane__card`, so this fixture cannot quietly outlive
 * the markup it stands in for.
 *
 * The HEADER and the minimized stand-in are not faked at all. They were, and
 * the fake drifted: it dressed the close button in a class the real one never
 * wears. Both render from the shipped components below.
 */
const STOPPED_BODY = `
  <div class="pane pane--idle" data-pane-id="p1">
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

const LONG_BRANCH = "fix/a-deliberately-long-branch-name";

let sheet: HTMLStyleElement;
let root: Root;
let host: HTMLElement;

beforeEach(() => {
  sheet = document.createElement("style");
  sheet.textContent = appCss;
  document.head.append(sheet);
  document.body.innerHTML = "<div id='host'></div>";
  host = document.getElementById("host")!;
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  sheet.remove();
  document.body.innerHTML = "";
});

/** The shipped pane header, with every badge the cluster can hold. */
function renderHeader(): void {
  act(() =>
    root.render(
      createElement(AgentPaneHeader, {
        paneId: "pane-1",
        title: "A deliberately long agent title that has to yield",
        keyboardFocusEnabled: true,
        focused: false,
        solo: false,
        view: paneHeaderView({
          activity: {
            tone: "failed",
            label: "A failure a CLI named at deliberate length",
            sentence: "failed",
            at: 1_754_000_000_000,
          },
          now: 1_754_000_000_000,
          ctxPct: 100,
          paneLive: true,
          team: { name: "platform", role: "reviewer-1" },
          showTeamName: true,
        }),
        yolo: true,
        onRename: () => {},
        onMinimize: () => {},
        onToggleFocus: () => {},
        onClose: () => {},
      }),
    ),
  );
}

/** The shipped minimized stand-in, in its tray-chip form. */
function renderStandIn(): void {
  act(() =>
    root.render(
      createElement(
        AppRuntimeProvider,
        {
          runtime: {
            statusTracker: createAgentStatusTracker(),
          } as unknown as AppRuntime,
        },
        createElement(MinimizedItem, {
          paneId: "pane-1",
          title: "A deliberately long agent title that has to yield",
          gitBadge: { label: LONG_BRANCH, title: LONG_BRANCH },
          yolo: true,
          label: "Restore the agent",
          active: true,
          onClick: () => {},
        }),
      ),
    ),
  );
}

const styleOf = (selector: string) => {
  const element = document.querySelector(selector);
  expect(element, `no element matched ${selector}`).not.toBeNull();
  return getComputedStyle(element as HTMLElement);
};

function mountBody(): void {
  host.innerHTML = STOPPED_BODY;
}

describe("pane layout", () => {
  it("lets a status card shrink to the pane, so its longest line ellipsizes inside it", () => {
    // The bug this pins: `.pane__card` had no `min-width`, so its automatic
    // minimum was its min-content width — and its widest line is a session id
    // set in `white-space: nowrap`, which contributes its full width. The card
    // floored at the id and grew past a third-width pane, painting its opaque
    // background over the neighbour and over the docked dock beside the deck.
    //
    // The two halves are asserted together because neither is worth anything
    // alone. `max-width: 80%` resolves against the CARD, so while this very
    // line floored the card the percentage meant 80% of the overflow — the ids
    // were cut mid-uuid, past the pane edge, with no ellipsis in sight. And one
    // `auto` anywhere in the chain restores that floor, which no layout engine
    // available here would notice.
    mountBody();

    for (const selector of [".pane", ".pane__body", ".pane__card"]) {
      expect(
        Number.parseFloat(styleOf(selector).minWidth),
        `${selector} keeps a min-content floor`,
      ).toBe(0);
    }

    const line = styleOf(".pane__idle-session");
    expect(line.maxWidth).toBe("80%");
    expect(line.overflow).toBe("hidden");
    expect(line.textOverflow).toBe("ellipsis");
    expect(line.whiteSpace).toBe("nowrap");
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
    mountBody();

    expect(styleOf(".pane").overflow).toBe("clip");
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
    renderHeader();

    expect(styleOf(".pane__identity").flexShrink).toBe("1");
    expect(styleOf(".pane__actions").flexShrink).toBe("0");
  });

  it("sheds role and context, then the state word, before the cluster outgrows the bar", () => {
    // The promise the ladder states in words — maximize and close never hide —
    // and the arithmetic that has to hold for it to be true. Nothing in the
    // cluster shrinks, so whatever it still carries when the bar runs out is
    // what the bar's clip cuts, from the right, where those two buttons are.
    // Read out of the source rather than restated, so widening a control
    // without widening its rung fails instead of shipping.
    const paneCss = readStyles("pane.css");
    const gap = px(ruleBody(paneCss, ".pane__actions").gap);
    const button = px(ruleBody(paneCss, ".pane__action").width);
    const close = px(ruleBody(readStyles("base.css"), ".ui-close").width);
    const state = px(ruleBody(paneCss, ".pane__state")["max-width"]);
    const yolo = px(ruleBody(readStyles("badges.css"), ".yolo-mark").width);
    const barGap = px(ruleBody(paneCss, ".pane__bar").gap);
    // What the identity keeps with its title and role ellipsized away.
    const idGap = px(ruleBody(paneCss, ".pane__identity").gap);
    const identity =
      px(ruleBody(paneCss, ".pane__status").width) +
      px(ruleBody(paneCss, ".pane__agent")["font-size"]) +
      2 * idGap;
    const width = (items: number[]) =>
      items.reduce((a, b) => a + b, 0) + gap * (items.length - 1) + barGap + identity;

    const rungOpening = (selector: string) =>
      Number(
        new RegExp(
          `@container[^{(]*\\(max-width: (\\d+)px\\)\\s*\\{\\s*\\${selector}[\\s,{]`,
        ).exec(paneCss)?.[1],
      );
    const ctxRung = rungOpening(".pane__ctx");
    const stateRung = rungOpening(".pane__state");
    expect(ctxRung, "the context rung is gone").toBeGreaterThan(0);
    expect(stateRung, "the state-word rung is gone").toBeGreaterThan(0);

    // The whole cluster, down to the state-word rung. Role and context ride
    // the title in the identity, so they are not in the cluster's sum...
    expect(stateRung).toBeGreaterThanOrEqual(width([state, yolo, button, button, close]));
    // ...and they go first, so the room left goes to the name.
    expect(ctxRung).toBeGreaterThan(stateRung);
  });

  it("never squeezes a badge below its own glyph", () => {
    // The chip cannot defend itself: the shared `.chip` sets `min-width: 0`
    // (chip.css), so a shrinkable branch badge collapses past its icon into a
    // sliver — still wearing `border-radius: 999px`, so it reads as a vertical
    // stadium with the glyph clipped off centre. pane.css claimed the opposite
    // ("No min-width:0 — the chip must never shrink below its icon") while
    // declaring nothing that made it true.
    //
    // Both surfaces, because the header and the tray stand-in deliberately
    // draw from one set of badges (ui-kit badges.tsx) and a fix to one of them
    // is a drift from the other. Neither declares it any more — the primitive
    // does, once, which is the point: a new chip in a shrinkable row inherits
    // the fix instead of the trap.
    renderHeader();
    expect(styleOf(".pane__yolo").flexShrink).toBe("0");

    renderStandIn();
    expect(styleOf(".minimized__yolo").flexShrink).toBe("0");
  });
});
