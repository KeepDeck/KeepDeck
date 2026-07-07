import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { registerTerminalLinks } from "./terminalLinks";
import type { PaneHint } from "./PaneHint";

// The kit's linker is INVERTED: the open primitives are injected on the
// target, not imported. A test hands in `vi.fn()`s directly — no ipc module to
// mock, which is the whole point of the inversion.
const opener = {
  openUrl: vi.fn(async (_url: string) => {}),
  openPath: vi.fn(async (_path: string) => {}),
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

/** The host only anchors hint coordinates. */
const host = {
  getBoundingClientRect: () => ({ left: 10, top: 20 }),
} as unknown as HTMLElement;

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

  it("passes xterm's provider disposable through", () => {
    const { term, dispose } = stubTerm([{ text: "" }]);
    registerTerminalLinks(term, host, target(null)).dispose();
    expect(dispose).toHaveBeenCalled();
  });
});
