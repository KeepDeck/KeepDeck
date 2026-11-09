// @vitest-environment happy-dom
/**
 * The real terminal, mounted: what its markup says about whether anyone can
 * see it. `src/styles/terminal.test.ts` reads the cascade over this markup —
 * the class the root wears while the terminal is off screen, and xterm's own
 * element directly inside the host — so the two cannot drift apart.
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { present } from "@keepdeck/plugin-api/testing";
import { AppRuntimeProvider } from "../../app/runtimeContext";
import { createFileOpenManager } from "../../app/testing";
import { createPaneInputFocusController } from "../../presentation/paneInputFocusController";
import { recordingContext2d, stubCanvasContext } from "../canvasContext.test-support";

vi.mock("../../app/usePaneTerminal", () => {
  const port = {
    isLaunched: () => true,
    attach: () => () => {},
    write: () => {},
    resize: () => {},
    registerInput: () => () => {},
    reportKey: () => {},
    reportTextInput: () => {},
  };
  return { usePaneTerminal: () => port };
});

const syncScrollArea = vi.hoisted(() => vi.fn());
vi.mock("./xtermViewport", () => ({ syncScrollArea }));

const redrawScroll = vi.hoisted(() => {
  const dispose = vi.fn();
  return { dispose, register: vi.fn(() => ({ dispose })) };
});
vi.mock("./redrawScrollBinding", () => ({ registerRedrawScroll: redrawScroll.register }));

import { TerminalPane } from "./TerminalPane";

const runtime = {
  fileOpen: createFileOpenManager(() => [], () => Promise.resolve(), () => {}),
  paneInputFocus: createPaneInputFocusController(),
  clipboard: {
    writeText: () => Promise.resolve(),
    readText: () => Promise.resolve(""),
    readImageTempPath: () => Promise.resolve(null),
  },
  shell: {
    openUrl: () => Promise.resolve(),
    listApplications: () => Promise.resolve([]),
  },
};

let root: Root;
let restoreCanvas: () => void;

beforeEach(() => {
  const drawn: unknown[] = [];
  restoreCanvas = stubCanvasContext((canvas) => recordingContext2d(canvas, drawn));
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return recordingContext2d(this, drawn);
      }
    },
  );
  document.body.innerHTML = "<div id='host'></div>";
  root = createRoot(present(document.getElementById("host"), "the host element"));
});

afterEach(() => {
  act(() => root.unmount());
  restoreCanvas();
  vi.unstubAllGlobals();
  syncScrollArea.mockClear();
  redrawScroll.register.mockClear();
  redrawScroll.dispose.mockClear();
  document.body.innerHTML = "";
});

function render(visible: boolean): HTMLElement {
  act(() =>
    root.render(
      createElement(
        AppRuntimeProvider,
        { runtime },
        createElement(TerminalPane, { paneId: "pane-1", command: "claude", cwd: "/repo", visible }),
      ),
    ),
  );
  return present(document.querySelector<HTMLElement>(".terminal-pane"), "the terminal root");
}

describe("a terminal's markup, on screen and off", () => {
  it("wears the offscreen mark exactly while it is not visible", () => {
    expect(render(false).classList.contains("terminal-pane--offscreen")).toBe(true);
    expect(render(true).classList.contains("terminal-pane--offscreen")).toBe(false);
    expect(render(false).classList.contains("terminal-pane--offscreen")).toBe(true);
  });

  it("puts xterm's own element directly inside the host, the box the fit measures", () => {
    const pane = render(false);
    const host = present(pane.querySelector(".terminal-pane__host"), "the host");
    expect(host.querySelector(":scope > .xterm")).not.toBeNull();
  });
});

/** Give the host the laid-out size happy-dom never computes. */
function sizeHost(pane: HTMLElement, width: number, height: number): void {
  const host = present(pane.querySelector(".terminal-pane__host"), "the host");
  Object.defineProperty(host, "clientWidth", { configurable: true, value: width });
  Object.defineProperty(host, "clientHeight", { configurable: true, value: height });
}

describe("a terminal's scrollbar, after time out of layout", () => {
  it("is re-synced when the terminal comes back on screen", () => {
    sizeHost(render(false), 640, 400);
    syncScrollArea.mockClear();

    render(true);

    expect(syncScrollArea).toHaveBeenCalledOnce();
  });

  it("is left alone while the host comes back at 0px, mid-re-tile", () => {
    sizeHost(render(false), 0, 0);
    syncScrollArea.mockClear();

    render(true);

    expect(syncScrollArea).not.toHaveBeenCalled();
  });

  it("is re-synced by a refit, which a host back from 0px gets with its grid unchanged", async () => {
    sizeHost(render(true), 640, 400);
    syncScrollArea.mockClear();

    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(syncScrollArea).toHaveBeenCalled());
  });
});

describe("a terminal's view, while the agent redraws its history", () => {
  it("is kept on its line for as long as the terminal is mounted", () => {
    render(true);
    expect(redrawScroll.register).toHaveBeenCalledOnce();
    expect(redrawScroll.dispose).not.toHaveBeenCalled();

    act(() => root.unmount());
    root = createRoot(present(document.getElementById("host"), "the host element"));

    expect(redrawScroll.dispose).toHaveBeenCalledOnce();
  });
});
