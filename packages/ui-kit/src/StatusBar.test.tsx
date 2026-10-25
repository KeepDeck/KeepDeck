// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));
  const bar = () => document.querySelector<HTMLElement>(".status-bar")!;
  const parts = () => [...document.querySelectorAll<HTMLElement>(".status-bar__part")];

  it("paints each part in its hue, in order, exactly its share — the rest of the track bare — named for what it says", () => {
    const label = "1 of 3 tasks done — 1 review, 1 to do";
    act(() => root.render(createElement(StatusBar, { parts: [{ tone: "done", share: 100 / 3 }, { tone: "waiting", share: 100 / 3 }], label, className: "x" })));
    expect(bar().className).toBe("status-bar x");
    expect(parts().map((part) => part.className)).toEqual(["status-bar__part status-bar__part--done", "status-bar__part status-bar__part--waiting"]);
    expect(parts().map((part) => part.style.flexBasis)).toEqual([`${100 / 3}%`, `${100 / 3}%`]);
    expect(bar().getAttribute("role")).toBe("img");
    expect(bar().getAttribute("aria-label")).toBe(label);
  });

  it("with nothing painted is the bare track", () => {
    act(() => root.render(createElement(StatusBar, { parts: [], label: "0 of 0 tasks done" })));
    expect(bar().children).toHaveLength(0);
  });

  it("moves in place: a part that stays keeps its node and takes its new share", () => {
    act(() => root.render(createElement(StatusBar, { parts: [{ tone: "done", share: 25 }, { tone: "working", share: 25 }], label: "a" })));
    const done = parts()[0];
    act(() => root.render(createElement(StatusBar, { parts: [{ tone: "done", share: 50 }], label: "b" })));
    expect(parts()).toEqual([done]);
    expect(done.style.flexBasis).toBe("50%");
  });

  it("beside the words that say it, is a picture only — never read twice", () => {
    act(() => root.render(createElement(StatusBar, { parts: [{ tone: "done", share: 50 }], label: "1 of 2 tasks done", decorative: true })));
    expect(bar().getAttribute("aria-hidden")).toBe("true");
    expect(bar().hasAttribute("role")).toBe(false);
    expect(bar().hasAttribute("aria-label")).toBe(false);
  });
});
