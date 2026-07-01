// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_COUNTS,
  WORKSPACE_COUNTS,
  TerminalCountTiles,
} from "./TerminalCountTiles";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("WORKSPACE_COUNTS", () => {
  it("is the terminal presets with a leading 0 (empty-workspace option)", () => {
    expect(WORKSPACE_COUNTS).toEqual([0, ...TERMINAL_COUNTS]);
  });
});

describe("TerminalCountTiles with a 0 tile", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => act(() => root.unmount()));

  it("renders a 'None' tile for 0 without throwing (paneGrid is 1..=MAX)", () => {
    // paneGrid(0) throws — the component must guard it. Rendering at all proves it.
    act(() =>
      root.render(
        createElement(TerminalCountTiles, {
          counts: WORKSPACE_COUNTS,
          value: 1,
          onPick: () => {},
        }),
      ),
    );
    const tiles = [...host.querySelectorAll(".setup__tile")];
    expect(tiles).toHaveLength(WORKSPACE_COUNTS.length);
    // The leading tile is the empty option, labelled "None".
    expect(tiles[0].querySelector(".setup__count")?.textContent).toBe("None");
    expect(tiles[0].getAttribute("aria-label")).toBe(
      "No agents (empty workspace)",
    );
    // Its preview has one (empty/off) cell, not zero and not a crash.
    expect(tiles[0].querySelectorAll(".setup__cell")).toHaveLength(1);
    expect(tiles[0].querySelector(".setup__cell--on")).toBeNull();
  });

  it("calls onPick(0) when the empty tile is clicked", () => {
    const onPick = vi.fn();
    act(() =>
      root.render(
        createElement(TerminalCountTiles, {
          counts: WORKSPACE_COUNTS,
          value: 1,
          onPick,
        }),
      ),
    );
    const none = host.querySelector(".setup__tile") as HTMLButtonElement;
    act(() => none.click());
    expect(onPick).toHaveBeenCalledWith(0);
  });
});
