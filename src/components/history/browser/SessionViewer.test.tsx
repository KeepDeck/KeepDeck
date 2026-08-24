// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { AgentInfo } from "../../../domain/agents";
import type { SessionsBrowserApi } from "../../../app/useSessionsBrowser";
import type { UnifiedSessionRow } from "../../../domain/journal";
import { SessionViewer, type ViewerTarget } from "./SessionViewer";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const AGENT: AgentInfo = {
  id: "claude",
  label: "Claude Code",
  command: "claude",
  features: [
    { id: "session.resume", label: "Resume" },
    { id: "session.fork", label: "Fork" },
    { id: "session.history", label: "History" },
  ],
  installed: true,
  path: null,
};

const SHOWN = "/journal/shown.jsonl";
const SPARE = "/index/spare";

const row = (sessionId = "s-1"): UnifiedSessionRow => ({
  kind: "index",
  agent: "claude",
  sessionId,
  cwd: "/repo",
  title: "session title",
  read: { reference: SHOWN },
  readLinks: [SHOWN],
  when: 1,
  snippet: null,
  handle: {
    agent: "claude",
    sessionId,
    cwd: "/repo",
    title: "session title",
    transcriptPath: SHOWN,
  },
});

const target = (over: Partial<ViewerTarget> = {}): ViewerTarget => ({
  agent: "claude",
  sessionId: "s-1",
  reference: SHOWN,
  title: "session title",
  fallbacks: [SHOWN],
  tried: 0,
  row: row(),
  ...over,
});

const entry = (text: string): AgentTranscriptEntry => ({
  role: "user",
  text,
});

const settle = async () => {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
};

const renderViewer = async ({
  root,
  target: viewTarget,
  transcript,
  viewSeq,
  readFailed,
  onClose = vi.fn(),
}: {
  root: Root;
  target: ViewerTarget;
  transcript: SessionsBrowserApi["transcript"];
  viewSeq: { current: number };
  readFailed: ReturnType<typeof vi.fn>;
  onClose?: ReturnType<typeof vi.fn>;
}) => {
  await act(async () => {
    root.render(
      createElement(SessionViewer, {
        target: viewTarget,
        api: { transcript },
        agents: [AGENT],
        presence: new Map(),
        readFailed,
        viewSeq,
        onClose,
        onResume: vi.fn(),
        onFork: vi.fn(),
      }),
    );
    await Promise.resolve();
  });
};

const setViewerGeometry = (
  body: Element,
  geometry: { scrollHeight: number; scrollTop: number; clientHeight: number },
) => {
  Object.defineProperties(body, {
    scrollHeight: { configurable: true, value: geometry.scrollHeight },
    scrollTop: { configurable: true, value: geometry.scrollTop, writable: true },
    clientHeight: { configurable: true, value: geometry.clientHeight },
  });
};

describe("SessionViewer", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("names a read refusal as itself and leaves retry to the parent", async () => {
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(() =>
      Promise.reject(new Error("no such file")),
    );
    const readFailed = vi.fn();
    const viewSeq = { current: 0 };

    await renderViewer({ root, target: target(), transcript, viewSeq, readFailed });
    await settle();
    expect(document.querySelector(".browser__empty")?.textContent).toBe(
      "Read failed: no such file",
    );
    expect(document.body.textContent).not.toContain("nothing to read");
    const lastUpdate = readFailed.mock.calls[readFailed.mock.calls.length - 1]?.[0] as (
      current: ReadonlySet<string>,
    ) => ReadonlySet<string>;
    expect(lastUpdate(new Set())).toEqual(new Set([SHOWN]));
  });

  it("drops a stale page when the view sequence advances to a newer header", async () => {
    const resolvers = new Map<
      string,
      (page: { entries: AgentTranscriptEntry[] }) => void
    >();
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(
      (_agent, reference) =>
        new Promise((resolve) => {
          resolvers.set(reference, resolve);
        }),
    );
    const readFailed = vi.fn();
    const viewSeq = { current: 0 };
    const first = target({ reference: "/first", title: "first header" });
    const second = target({
      sessionId: "s-2",
      reference: "/second",
      title: "second header",
      row: row("s-2"),
    });

    await renderViewer({ root, target: first, transcript, viewSeq, readFailed });
    viewSeq.current += 1;
    await renderViewer({
      root,
      target: second,
      transcript,
      viewSeq,
      readFailed,
    });

    await act(async () => {
      resolvers.get("/first")!({ entries: [entry("stale first page")] });
    });
    expect(document.body.textContent).toContain("second header");
    expect(document.body.textContent).not.toContain("stale first page");

    await act(async () => {
      resolvers.get("/second")!({ entries: [entry("current second page")] });
    });
    expect(document.body.textContent).toContain("current second page");
  });

  it("tries the shown link first, falls through to the spare, and marks the row only after the last refusal", async () => {
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(
      (_agent, reference) =>
        reference === SHOWN
          ? Promise.reject(new Error("journal gone"))
          : Promise.resolve({ entries: [entry("spare page")] }),
    );
    const readFailed = vi.fn();
    const viewSeq = { current: 0 };

    await renderViewer({
      root,
      target: target({ fallbacks: [SHOWN, SPARE] }),
      transcript,
      viewSeq,
      readFailed,
    });
    await settle();

    expect(transcript.mock.calls.map((call) => call[1])).toEqual([SHOWN, SPARE]);
    expect(document.querySelector(".browser__turn--user")?.textContent).toBe(
      "spare page",
    );
    expect(document.body.textContent).not.toContain("Read failed");
  });

  it("names the final fallback refusal and marks every link as the row failure", async () => {
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(() =>
      Promise.reject(new Error("permission denied")),
    );
    const readFailed = vi.fn();
    const viewSeq = { current: 0 };

    await renderViewer({
      root,
      target: target({ fallbacks: [SHOWN, SPARE] }),
      transcript,
      viewSeq,
      readFailed,
    });
    await settle();

    expect(document.querySelector(".browser__empty")?.textContent).toBe(
      "Read failed: permission denied",
    );
    const lastUpdate = readFailed.mock.calls[readFailed.mock.calls.length - 1]?.[0] as (
      current: ReadonlySet<string>,
    ) => ReadonlySet<string>;
    expect(lastUpdate(new Set())).toEqual(new Set([SHOWN, SPARE]));
  });

  it("fills while shorter than the viewport, then requests the next page in twenties", async () => {
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(
      (_agent, _reference, from) =>
        from === 0
          ? Promise.resolve({
              entries: Array.from({ length: 50 }, (_, i) => entry(`turn ${i}`)),
            })
          : Promise.resolve({ entries: [] }),
    );
    const readFailed = vi.fn();
    const viewSeq = { current: 0 };

    await renderViewer({ root, target: target(), transcript, viewSeq, readFailed });
    await settle();

    expect(transcript.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [0, 50],
      [50, 20],
    ]);
  });

  it("requests the next page near the end of the viewport", async () => {
    let resolveFirst!: (page: { entries: AgentTranscriptEntry[] }) => void;
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(
      (_agent, _reference, from) =>
        from === 0
          ? new Promise((resolve) => {
              resolveFirst = resolve;
            })
          : Promise.resolve({ entries: [] }),
    );
    const readFailed = vi.fn();
    const viewSeq = { current: 0 };

    await renderViewer({ root, target: target(), transcript, viewSeq, readFailed });
    const body = document.querySelector(".browser__viewer-body")!;
    setViewerGeometry(body, { scrollHeight: 1000, scrollTop: 700, clientHeight: 200 });
    await act(async () => {
      resolveFirst({
        entries: Array.from({ length: 50 }, (_, i) => entry(`turn ${i}`)),
      });
      await Promise.resolve();
    });
    await settle();

    expect(transcript).toHaveBeenNthCalledWith(2, "claude", SHOWN, 50, 20);
  });

  it("back navigation is one browser step", async () => {
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(() =>
      Promise.resolve({ entries: [entry("page")] }),
    );
    const readFailed = vi.fn();
    const onClose = vi.fn();
    const viewSeq = { current: 0 };

    await renderViewer({
      root,
      target: target(),
      transcript,
      viewSeq,
      readFailed,
      onClose,
    });
    await settle();
    const back = document.querySelector<HTMLButtonElement>(".browser__back")!;
    expect(back).not.toBeNull();
    await act(async () => back.click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says what the reading fell short by instead of carrying it silently", async () => {
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(() =>
      Promise.resolve({
        entries: [entry("first turn")],
        shortfall: [{ kind: "bytes" as const, size: 10259690, readBytes: 8388608 }],
      }),
    );

    await renderViewer({
      root,
      target: target(),
      transcript,
      viewSeq: { current: 0 },
      readFailed: vi.fn(),
    });
    await settle();

    expect(document.body.textContent).toContain(
      "Partly shown — read 8388608 of 10259690",
    );
  });

  it("does not let emptiness answer for a reading that fell short", async () => {
    // The failure this replaces was the worst the stage could produce: a capped
    // read that parsed to nothing rendered as "No transcript content" — not
    // "less", but "nothing" — over a conversation of ten megabytes.
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(() =>
      Promise.resolve({
        entries: [],
        shortfall: [{ kind: "bytes" as const, size: 10259690, readBytes: 8388608 }],
      }),
    );

    await renderViewer({
      root,
      target: target(),
      transcript,
      viewSeq: { current: 0 },
      readFailed: vi.fn(),
    });
    await settle();

    expect(document.body.textContent).toContain(
      "Read cut short — nothing could be shown",
    );
    expect(document.body.textContent).not.toContain("No transcript content");
  });

  it("restarts a fresh link from the beginning rather than splicing onto the old one's pages", async () => {
    // Reachable only since the walk stopped being page-zero-only. The union is
    // two RECORDED strings for one session, and nothing guarantees they name a
    // byte-identical file: handing the spare an offset the first link earned
    // would stitch two readings into a conversation that never happened. An
    // invention is worse than a loss, so the fresh link starts at zero.
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(
      (_agent, reference, offset) => {
        if (reference === SHOWN) {
          return offset === 0
            ? Promise.resolve({
                entries: Array.from({ length: 50 }, (_, at) => entry(`shown ${at}`)),
              })
            : Promise.reject(new Error("journal vanished mid-scroll"));
        }
        return Promise.resolve({ entries: [entry("spare from the top")] });
      },
    );

    await renderViewer({
      root,
      target: target({ fallbacks: [SHOWN, SPARE] }),
      transcript,
      viewSeq: { current: 0 },
      readFailed: vi.fn(),
    });
    await settle();
    await settle();

    const spareAsks = transcript.mock.calls
      .filter((call) => call[1] === SPARE)
      .map((call) => call[2]);
    expect(spareAsks).toEqual([0]);
    // The old link's pages are gone, not stitched to the new link's.
    expect(document.body.textContent).toContain("spare from the top");
    expect(document.body.textContent).not.toContain("shown 0");
  });

  it("keeps paging on the link that answered, not the one that refused", async () => {
    // The union's fall-through used to live only in a recursive argument, so
    // the next page asked the dead link again and condemned every handle of
    // the row — including the one reading a second earlier. Silent while
    // nothing was said about it; once the viewer says "the rest did not
    // arrive", the same bug becomes a spoken untruth.
    // A full first page keeps the filler asking; the short second one ends the
    // walk, so the test observes exactly one follow-up.
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, at) => entry(`turn ${from + at}`));
    const transcript = vi.fn<SessionsBrowserApi["transcript"]>(
      (_agent, reference, offset) =>
        reference === SHOWN
          ? Promise.reject(new Error("journal gone"))
          : Promise.resolve({ entries: page(offset, offset === 0 ? 50 : 3) }),
    );

    await renderViewer({
      root,
      target: target({ fallbacks: [SHOWN, SPARE] }),
      transcript,
      viewSeq: { current: 0 },
      readFailed: vi.fn(),
    });
    await settle();
    await settle();

    const asked = transcript.mock.calls.map((call) => [call[1], call[2]]);
    // The dead link is asked once, at the top of the walk, and never again.
    expect(asked.filter(([reference]) => reference === SHOWN)).toHaveLength(1);
    expect(asked).toContainEqual([SPARE, 50]);
    expect(document.body.textContent).not.toContain("did not arrive");
  });
});
