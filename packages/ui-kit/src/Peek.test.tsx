// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DROP_BLOCKER_ATTR } from "./dropBlocker";
import { Peek, type PeekProps } from "./Peek";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe("Peek", () => {
  let root: Root;
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const render = (props: Partial<PeekProps> = {}) => {
    const full: PeekProps = {
      ariaLabel: "Diff of app.ts",
      name: "app.ts",
      scrollKey: "a.ts",
      onClose: vi.fn(),
      children: "content",
      ...props,
    };
    return act(() => root.render(createElement(Peek, full)));
  };

  const body = () => host.querySelector<HTMLElement>(".peek__body")!;

  /** The reader is deep into a long file, and off to the side of a wide one. */
  const scrollAway = () => {
    body().scrollTop = 640;
    body().scrollLeft = 120;
  };

  it("declares itself a drop blocker — it covers panes that stay live", () => {
    render();
    // The deck under it is still laid out, and an OS file drop is routed by
    // coordinates alone: without this marker a path dragged from Finder onto
    // an open preview is typed into a terminal the reader cannot see.
    expect(host.querySelector(`.peek[${DROP_BLOCKER_ATTR}]`)).not.toBeNull();
  });

  it("opts its content back into selection — a peek exists to be read and copied", () => {
    render();
    // Every consumer (a file preview, a diff) inherits this: the panel is the
    // island, and its gutters opt back out with .kd-inert. Drop the token and
    // peeked code silently stops being copyable, with nothing else failing.
    expect(
      host.querySelector(".peek__panel")!.classList.contains("kd-selectable"),
    ).toBe(true);
  });

  it("a new content identity puts the body back at the top, both axes", () => {
    render();
    scrollAway();
    render({ scrollKey: "b.ts", name: "b.ts", children: "other content" });
    expect(body().scrollTop).toBe(0);
    expect(body().scrollLeft).toBe(0);
  });

  it("re-rendering the same content leaves the reader where they were", () => {
    render();
    scrollAway();
    // Same key, different children — a load step landing, or a watcher
    // refresh re-reading the file the reader is halfway through.
    render({ children: "content, refreshed" });
    expect(body().scrollTop).toBe(640);
    expect(body().scrollLeft).toBe(120);
  });

  const railButton = () =>
    host.querySelector<HTMLElement>(".peek__aside button")!;
  const headerButton = () =>
    host.querySelector<HTMLElement>(".peek__head button:last-of-type")!;
  const aside = () => createElement("button", { type: "button" }, "sibling");
  const actions = () => createElement("button", { type: "button" }, "wrap");

  it("takes focus back from a rail row when the content changes", () => {
    render({ aside: aside() });
    const before = body();
    expect(document.activeElement).toBe(before);

    // The thief is INSIDE the peek, which is the case that matters: on
    // engines where clicking a control focuses it, picking a file in the rail
    // leaves focus on that row's button. A reclaim that only fired when focus
    // had left the dialog would sail past this.
    railButton().focus();
    expect(document.activeElement).toBe(railButton());

    render({ scrollKey: "b.ts", aside: aside(), children: "other content" });

    // The same node, not a remount — nothing about rendering new children
    // would restore the scroll or the focus by itself.
    expect(body()).toBe(before);
    expect(document.activeElement).toBe(before);
  });

  it("leaves a header control holding focus, so its toggle stays repeatable", () => {
    render({ actions: actions() });
    const toggle = headerButton();
    toggle.focus();

    // A header action that changes the content is a toggle the reader may
    // want to press again; pulling focus to the body would cost them the
    // second press and announce nothing to assistive tech.
    render({ scrollKey: "b.ts", actions: actions(), children: "other content" });

    expect(document.activeElement).toBe(toggle);
  });

  it("hands the scrolling keys to the body while the header holds focus", () => {
    render({ actions: actions() });
    const scroller = body();
    Object.defineProperty(scroller, "clientHeight", {
      value: 100,
      configurable: true,
    });
    const toggle = headerButton();
    toggle.focus();

    // The header is outside the scroll body, so without this these keys reach
    // no scrollable ancestor at all and the reader is simply stuck.
    act(() =>
      void toggle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }),
      ),
    );

    expect(scroller.scrollTop).toBe(90);
    expect(document.activeElement).toBe(toggle);
  });
});
