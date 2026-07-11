import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { registerTerminalLinks } from "./terminalLinks";
import type { PaneHint } from "./PaneHint";

// The kit's linker is INVERTED: the open primitives are injected on the
// target, not imported. A test hands in `vi.fn()`s directly — no ipc module to
// mock, which is the whole point of the inversion.
const opener = {
  openUrl: vi.fn(async (_url: string) => {}),
  openPath: vi.fn(
    async (_path: string): Promise<void | { notice?: string }> => {},
  ),
};

/** Rows of a fake xterm buffer; `wrapped` marks a continuation row. */
type Row = { text: string; wrapped?: boolean };

/** The slice of Terminal the linker touches: provider registry + buffer. */
function stubTerm(rows: Row[], opts: { cols?: number } = {}) {
  let provider: ILinkProvider | undefined;
  const dispose = vi.fn();
  const term = {
    cols: opts.cols,
    registerLinkProvider(p: ILinkProvider) {
      provider = p;
      return { dispose };
    },
    buffer: {
      active: {
        getLine(y: number) {
          const row = rows[y];
          if (!row) return undefined;
          return {
            isWrapped: row.wrapped === true,
            translateToString: (trimRight: boolean) =>
              trimRight ? row.text.replace(/\s+$/, "") : row.text,
          };
        },
      },
    },
  };
  return {
    term: term as unknown as Terminal,
    provider: () => provider!,
    dispose,
  };
}

/** The host anchors hint coordinates and carries the ⌘-mousedown listener. */
const host = {
  getBoundingClientRect: () => ({ left: 10, top: 20 }),
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as HTMLElement;

/** A host that captures its listeners so a test can fire a ⌘-mousedown. */
function captureHost() {
  const handlers: Record<string, EventListener[]> = {};
  const el = {
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    addEventListener: (type: string, fn: EventListener) => {
      (handlers[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => {
      handlers[type] = (handlers[type] ?? []).filter((f) => f !== fn);
    },
  };
  return {
    host: el as unknown as HTMLElement,
    fire: (type: string, ev: Partial<MouseEvent>) =>
      (handlers[type] ?? []).forEach((f) => f(ev as MouseEvent)),
    count: (type: string) => (handlers[type] ?? []).length,
  };
}

/** A term stub with measurable grid geometry so cellFromEvent resolves a cell.
 *  Cells are 10px wide × 20px tall; the screen sits at the viewport origin. */
function stubTermWithGrid(
  rows: Row[],
  grid: { cols: number; rows: number; viewportY?: number },
) {
  const base = stubTerm(rows, { cols: grid.cols });
  const screen = {
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: grid.cols * 10,
      height: grid.rows * 20,
    }),
  };
  Object.assign(base.term as object, {
    rows: grid.rows,
    element: { querySelector: () => screen },
  });
  (base.term as { buffer: { active: { viewportY: number } } }).buffer.active.viewportY =
    grid.viewportY ?? 0;
  return base;
}

/** A left-edge ⌘-mousedown over the cell whose 1-based column is `col`, row 1. */
const metaDownAtCol = (col: number): Partial<MouseEvent> => ({
  metaKey: true,
  clientX: (col - 1) * 10, // left pixel of the cell — the easy-to-miss edge
  clientY: 0,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

function linksAt(provider: ILinkProvider, lineNumber: number) {
  let out: ILink[] | undefined;
  provider.provideLinks(lineNumber, (links) => {
    out = links;
  });
  return out;
}

const click = (over: Partial<MouseEvent> = {}) =>
  ({ metaKey: false, clientX: 110, clientY: 220, ...over }) as MouseEvent;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("registerTerminalLinks", () => {
  let showHint: ReturnType<typeof vi.fn<(hint: PaneHint) => void>>;
  const target = (cwd: string | null) => ({ cwd, showHint, ...opener });

  beforeEach(() => {
    vi.clearAllMocks();
    showHint = vi.fn();
  });

  it("detects a URL and hands xterm its buffer range", () => {
    const { term, provider } = stubTerm([
      { text: "  Local: http://localhost:5173/ ready" },
    ]);
    registerTerminalLinks(term, host, target(null));

    const links = linksAt(provider(), 1);
    expect(links).toHaveLength(1);
    expect(links![0].text).toBe("http://localhost:5173/");
    expect(links![0].range).toEqual({
      start: { x: 10, y: 1 },
      end: { x: 31, y: 1 },
    });
  });

  it("reports a line without links as undefined", () => {
    const { term, provider } = stubTerm([{ text: "plain text, no links" }]);
    registerTerminalLinks(term, host, target(null));

    expect(linksAt(provider(), 1)).toBeUndefined();
  });

  it("joins wrapped rows into one link, from either row", () => {
    const { term, provider } = stubTerm([
      { text: "ready at http://localhost:51" },
      { text: "73/", wrapped: true },
    ]);
    registerTerminalLinks(term, host, target(null));

    for (const lineNumber of [1, 2]) {
      const links = linksAt(provider(), lineNumber);
      expect(links).toHaveLength(1);
      expect(links![0].text).toBe("http://localhost:5173/");
      expect(links![0].range).toEqual({
        start: { x: 10, y: 1 },
        end: { x: 3, y: 2 },
      });
    }
  });

  it("joins an application hard-wrapped path into one link, from any of its rows", () => {
    // The child app wrapped the path to cols=10 itself: real newlines, a
    // 2-space hanging indent, full non-final rows (no `wrapped` flag).
    const { term, provider } = stubTerm(
      [
        { text: "/aa/bb/ccc" },
        { text: "  dd/ee/ff" },
        { text: "  gg.ts" },
      ],
      { cols: 10 },
    );
    registerTerminalLinks(term, host, target("/wt"));

    for (const lineNumber of [1, 2, 3]) {
      const links = linksAt(provider(), lineNumber);
      expect(links).toHaveLength(1);
      expect(links![0].text).toBe("/aa/bb/cccdd/ee/ffgg.ts");
      // Range spans the head row's "/" to the tail row's ".ts", indent undone.
      expect(links![0].range).toEqual({
        start: { x: 1, y: 1 },
        end: { x: 7, y: 3 },
      });
    }
  });

  it("answers a plain click with the ⌘ affordance instead of opening", () => {
    const { term, provider } = stubTerm([{ text: "http://localhost:5173/" }]);
    registerTerminalLinks(term, host, target(null));

    linksAt(provider(), 1)![0].activate(click({ metaKey: false }), "");
    expect(showHint).toHaveBeenCalledWith({
      text: "⌘-click to open",
      // Click point translated to host-local coordinates.
      x: 100,
      y: 200,
    });
    expect(opener.openUrl).not.toHaveBeenCalled();
    expect(opener.openPath).not.toHaveBeenCalled();
  });

  it("opens a URL on ⌘-click", () => {
    const { term, provider } = stubTerm([{ text: "http://localhost:5173/" }]);
    registerTerminalLinks(term, host, target(null));

    linksAt(provider(), 1)![0].activate(click({ metaKey: true }), "");
    expect(opener.openUrl).toHaveBeenCalledWith("http://localhost:5173/");
    expect(showHint).not.toHaveBeenCalled();
  });

  it("resolves a relative path against the surface's cwd on ⌘-click", () => {
    const { term, provider } = stubTerm([{ text: "error at src/main.ts:12" }]);
    registerTerminalLinks(term, host, target("/wt/b"));

    linksAt(provider(), 1)![0].activate(click({ metaKey: true }), "");
    expect(opener.openPath).toHaveBeenCalledWith("/wt/b/src/main.ts");
  });

  it("surfaces a failed open next to the click", async () => {
    opener.openUrl.mockRejectedValueOnce("boom");
    const { term, provider } = stubTerm([{ text: "http://localhost:5173/" }]);
    registerTerminalLinks(term, host, target(null));

    linksAt(provider(), 1)![0].activate(click({ metaKey: true }), "");
    await flush();
    expect(showHint).toHaveBeenCalledWith({
      text: "Couldn't open http://localhost:5173/",
      x: 100,
      y: 200,
    });
  });

  it("shows an opener's notice at the click; a silent resolution shows nothing", async () => {
    // A resolution can carry a notice — e.g. the host's file-open chain saying
    // it fell back to the system opener after an in-app handler declined.
    opener.openPath.mockResolvedValueOnce({ notice: "Opened externally" });
    const { term, provider } = stubTerm([{ text: "see /wt/a/readme.md now" }]);
    registerTerminalLinks(term, host, target(null));

    linksAt(provider(), 1)![0].activate(click({ metaKey: true }), "");
    await flush();
    expect(showHint).toHaveBeenCalledWith({
      text: "Opened externally",
      x: 100,
      y: 200,
    });

    showHint.mockClear();
    opener.openPath.mockResolvedValueOnce(undefined);
    linksAt(provider(), 1)![0].activate(click({ metaKey: true }), "");
    await flush();
    expect(showHint).not.toHaveBeenCalled();
  });

  it("passes xterm's provider disposable through", () => {
    const { term, dispose } = stubTerm([{ text: "" }]);
    registerTerminalLinks(term, host, target(null)).dispose();
    expect(dispose).toHaveBeenCalled();
  });
});

describe("registerTerminalLinks — arming-independent ⌘-click", () => {
  let showHint: ReturnType<typeof vi.fn<(hint: PaneHint) => void>>;
  const target = (cwd: string | null) => ({ cwd, showHint, ...opener });
  const row = [{ text: "  Local: http://localhost:5173/ ready" }]; // link at cols 10..31

  beforeEach(() => {
    vi.clearAllMocks();
    showHint = vi.fn();
  });

  it("opens a link on ⌘-mousedown with no prior hover to arm it", () => {
    const { term } = stubTermWithGrid(row, { cols: 40, rows: 1 });
    const { host, fire } = captureHost();
    registerTerminalLinks(term, host, target(null));

    // Fire straight at a link cell — no provideLinks/hover ran first, which is
    // exactly the streaming-pane case xterm's own activate can't handle.
    fire("mousedown", {
      metaKey: true,
      clientX: 140, // col 15, inside the URL
      clientY: 0,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(opener.openUrl).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("opens from the link's left-edge cell that floor-mapping would miss", () => {
    const { term } = stubTermWithGrid(row, { cols: 40, rows: 1 });
    const { host, fire } = captureHost();
    registerTerminalLinks(term, host, target(null));

    // col 9 is one cell left of the link (starts at col 10) — the miss the pad
    // is there to forgive.
    fire("mousedown", metaDownAtCol(9));
    expect(opener.openUrl).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("ignores a plain (non-⌘) mousedown — selection is left alone", () => {
    const { term } = stubTermWithGrid(row, { cols: 40, rows: 1 });
    const { host, fire } = captureHost();
    registerTerminalLinks(term, host, target(null));

    fire("mousedown", { metaKey: false, clientX: 140, clientY: 0 });
    expect(opener.openUrl).not.toHaveBeenCalled();
  });

  it("does nothing on a ⌘-mousedown that isn't over a link", () => {
    const { term } = stubTermWithGrid(row, { cols: 40, rows: 1 });
    const { host, fire } = captureHost();
    registerTerminalLinks(term, host, target(null));

    fire("mousedown", metaDownAtCol(2)); // over the "  Local:" prefix
    expect(opener.openUrl).not.toHaveBeenCalled();
  });

  it("suppresses xterm's own activate for a gesture it already handled", () => {
    const { term, provider } = stubTermWithGrid(row, { cols: 40, rows: 1 });
    const { host, fire } = captureHost();
    registerTerminalLinks(term, host, target(null));

    fire("mousedown", metaDownAtCol(15));
    expect(opener.openUrl).toHaveBeenCalledTimes(1);
    // xterm's mouseup would call the same link's activate — it must not re-open.
    linksAt(provider(), 1)![0].activate(click({ metaKey: true }), "");
    expect(opener.openUrl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the provider's activate when the grid can't be measured", () => {
    // No .xterm-screen geometry (plain stubTerm) → cellFromEvent yields null.
    const { term, provider } = stubTerm(row, { cols: 40 });
    const { host, fire } = captureHost();
    registerTerminalLinks(term, host, target(null));

    fire("mousedown", metaDownAtCol(15));
    expect(opener.openUrl).not.toHaveBeenCalled(); // raw handler no-ops…
    linksAt(provider(), 1)![0].activate(click({ metaKey: true }), "");
    expect(opener.openUrl).toHaveBeenCalledWith("http://localhost:5173/"); // …provider still works
  });

  it("removes its mousedown listener on dispose", () => {
    const { term } = stubTermWithGrid(row, { cols: 40, rows: 1 });
    const { host, count } = captureHost();
    const links = registerTerminalLinks(term, host, target(null));
    expect(count("mousedown")).toBe(1);
    links.dispose();
    expect(count("mousedown")).toBe(0);
  });
});
