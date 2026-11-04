// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { present } from "@keepdeck/plugin-api/testing";
import { appCss, readStyles, ruleBody } from "./testSupport";

/**
 * What a terminal costs while nobody can see it, read off the shipped cascade.
 *
 * The markup is hand-written, but it is not taken on trust:
 * `TerminalPane.test.tsx` mounts the real terminal and asserts that its root
 * wears `terminal-pane--offscreen` exactly while it is not visible, and that
 * xterm's own element sits directly in `.terminal-pane__host`.
 */
const LAYER = (hidden: boolean, offscreen: boolean) => `
  <main class="deck__workspace${hidden ? " deck__workspace--hidden" : ""}">
    <span class="pane__status pane__status--working">Working</span>
    <div class="terminal-pane${offscreen ? " terminal-pane--offscreen" : ""}">
      <div class="terminal-pane__host"><div class="terminal xterm"><canvas></canvas></div></div>
    </div>
  </main>
`;

let sheet: HTMLStyleElement;

beforeEach(() => {
  sheet = document.createElement("style");
  sheet.textContent = appCss;
  document.head.append(sheet);
});

afterEach(() => {
  sheet.remove();
  document.body.innerHTML = "";
});

function render(hidden: boolean, offscreen: boolean) {
  document.body.innerHTML = LAYER(hidden, offscreen);
  const at = (selector: string) =>
    getComputedStyle(present(document.querySelector<HTMLElement>(selector), selector));
  return {
    layer: at(".deck__workspace"),
    host: at(".terminal-pane__host"),
    renderer: at(".xterm"),
    status: at(".pane__status--working"),
  };
}

describe("a terminal nobody can see", () => {
  it("takes its renderer out of layout and keeps its host's box", () => {
    const { host, renderer } = render(true, true);
    expect(renderer.display).toBe("none");
    // The host is what the fit measures: it must keep the tile's size, or the
    // PTY would be told a size nobody sees.
    expect(host.display).not.toBe("none");
    expect(host.position).toBe("absolute");
  });

  it("keeps its renderer laid out while it is on screen", () => {
    expect(render(false, false).renderer.display).not.toBe("none");
  });
});

describe("a background workspace", () => {
  it("stays laid out, so the terminals in it keep the size they would show at", () => {
    const { layer } = render(true, true);
    expect(layer.visibility).toBe("hidden");
    expect(layer.display).not.toBe("none");
  });

  it("pauses every animation in it, and only in it", () => {
    expect(render(true, true).status.animationPlayState).toBe("paused");
    expect(render(false, false).status.animationPlayState).not.toBe("paused");
  });

  it("pauses even an animation set by a more specific shorthand", () => {
    // Every status animation is an `animation:` shorthand, some on two-class
    // selectors (`.minimized.minimized--frame-working`), and a shorthand
    // resets the play state. happy-dom does not expand the shorthand, so that
    // reset cannot be observed above; the declaration has to win by itself.
    const pause = ruleBody(
      readStyles("deck.css"),
      ".deck__workspace--hidden *,\n.deck__workspace--hidden *::before,\n.deck__workspace--hidden *::after",
    );
    expect(pause["animation-play-state"]).toBe("paused !important");
  });
});
