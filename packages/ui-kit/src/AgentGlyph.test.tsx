// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentGlyph, type AgentGlyphIcon } from "./AgentGlyph";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mark: AgentGlyphIcon = {
  viewBox: "0 0 24 24",
  paths: [{ d: "M0 0h24v24H0z", color: "#D97757" }],
};

describe("AgentGlyph", () => {
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

  const render = (icon?: AgentGlyphIcon | null) =>
    act(() => root.render(createElement(AgentGlyph, { icon, className: "x" })));

  it("draws the mark's path in its brand tint, hidden from a11y", () => {
    render(mark);
    const svg = host.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    const path = svg.querySelector("path")!;
    expect(path.getAttribute("d")).toBe("M0 0h24v24H0z");
    expect(path.getAttribute("fill")).toBe("#D97757");
  });

  it("a monochrome layer inherits the text color", () => {
    render({ viewBox: "0 0 24 24", paths: [{ d: "M0 0h24v24H0z" }] });
    expect(host.querySelector("path")!.getAttribute("fill")).toBe(
      "currentColor",
    );
  });

  it("honors an evenodd fill rule (marks with punched holes)", () => {
    render({
      viewBox: "0 0 24 24",
      paths: [{ d: "M0 0h24v24H0z", fillRule: "evenodd" }],
    });
    expect(host.querySelector("path")!.getAttribute("fill-rule")).toBe(
      "evenodd",
    );
  });

  it("paints a multi-tone mark layer by layer, in order", () => {
    render({
      viewBox: "0 0 240 300",
      paths: [
        { d: "M60 120h120v120H60z", color: "#4B4646" },
        { d: "M0 0h240v300H0z", color: "#F1ECEC" },
      ],
    });
    const paths = host.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[0].getAttribute("fill")).toBe("#4B4646");
    expect(paths[1].getAttribute("fill")).toBe("#F1ECEC");
  });

  it("no mark falls back to the neutral prompt, not empty space", () => {
    render(null);
    const svg = host.querySelector("svg")!;
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.querySelector("polyline")).not.toBeNull();
  });
});
