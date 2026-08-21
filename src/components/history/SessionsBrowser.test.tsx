// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { SearchHit } from "../../ipc/history";
import type { AgentInfo } from "../../domain/agents";
import type { JoinEntry, SessionRecord } from "../../domain/journal";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
import { hitRecord, SessionsBrowser } from "./SessionsBrowser";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const worktreeIpc = vi.hoisted(() => ({
  probeWorktree: vi.fn((_path: string) =>
    Promise.resolve({ exists: true, isWorktree: false, branch: null }),
  ),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);

const CAPABLE_AGENT: AgentInfo = {
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

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  agent: "claude",
  sessionId: "u-1",
  reference: "/store/u-1.jsonl",
  cwd: "/repo/wt",
  title: "auth bug",
  transcriptPath: "/store/u-1.jsonl",
  mtime: 1752900000000,
  snippet: "the [auth] bug",
  ...over,
});

const closed = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    agent: "claude",
    sessionId: "s-1",
    cwd: "/repo",
    boundAt: "2026-07-19T10:00:00.000Z",
    state: "closed",
    endedAt: "2026-07-19T11:00:00.000Z",
    ...over,
  }) as SessionRecord;

const live = (over: Partial<SessionRecord> = {}): SessionRecord =>
  ({
    agent: "claude",
    sessionId: "s-live",
    cwd: "/repo",
    boundAt: "2026-07-19T10:00:00.000Z",
    state: "live",
    paneId: "pane-1",
    ...over,
  }) as SessionRecord;

const blockOf = (
  hits: SearchHit[],
  over: {
    total?: number;
    hasMore?: boolean;
    loadingMore?: boolean;
    firstPagePending?: boolean;
    error?: string | null;
  } = {},
) => ({
  hits,
  total: hits.length,
  hasMore: false,
  loadingMore: false,
  firstPagePending: false,
  error: null,
  loadMore: vi.fn(),
  ...over,
});

const api = (
  hits: SearchHit[],
  over: Partial<SessionsBrowserApi> = {},
  entries: Record<string, JoinEntry> = {},
): SessionsBrowserApi => ({
  top: blockOf([]),
  bottom: blockOf(hits),
  query: "",
  firstPagePending: false,
  scanning: false,
  enrichment: {
    entries: new Map(Object.entries(entries)),
    pending: false,
    declare: vi.fn(),
  },
  search: vi.fn(),
  ensureFresh: vi.fn(),
  transcript: vi.fn(() =>
    Promise.resolve([{ role: "user" as const, text: "hello" }]),
  ),
  ...over,
});

/** Both blocks render ONE row component with ONE markup — a block is not
 * a class anymore. The top block is the rows BEFORE the divider (or all
 * rows when no divider renders); the bottom block, after it. */
const listRows = (): Element[] => [
  ...document.querySelectorAll(".browser__list > .history__row"),
];
const topRows = (): Element[] => {
  const all = listRows();
  const divider = document.querySelector(".browser__section");
  if (!divider) return all;
  return all.filter(
    (row) => row.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
};
const bottomRows = (): Element[] => {
  const all = listRows();
  const divider = document.querySelector(".browser__section");
  if (!divider) return [];
  return all.filter(
    (row) => !(row.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING),
  );
};
const topRow = (): Element => topRows()[0];

describe("hitRecord", () => {
  it("carries the index's explicit transcript path; a null one stays absent", () => {
    // A handle, not a fabricated journal record: no state/boundAt/endedAt.
    expect(hitRecord(hit())).toEqual({
      agent: "claude",
      sessionId: "u-1",
      cwd: "/repo/wt",
      title: "auth bug",
      transcriptPath: "/store/u-1.jsonl",
    });
    expect(
      "transcriptPath" in
        hitRecord(hit({ agent: "opencode", reference: "ses_1", transcriptPath: null })),
    ).toBe(false);
  });
});

describe("SessionsBrowser", () => {
  let root: Root;
  beforeEach(() => {
    worktreeIpc.probeWorktree.mockClear();
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = (
    a: SessionsBrowserApi,
    rows: SessionRecord[] = [],
    callbacks: { onResume?: unknown; onFork?: unknown } = {},
  ) =>
    act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [CAPABLE_AGENT],
          ready: true,
          rows,
          onResume: (callbacks.onResume as (r: never) => void) ?? vi.fn(),
          onFork: (callbacks.onFork as (r: never) => void) ?? vi.fn(),
        }),
      ),
    );

  it("declares the index need on mount, searches as you type, and hands resume/fork the record", async () => {
    const a = api([hit()]);
    const onResume = vi.fn();
    const onFork = vi.fn();
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [CAPABLE_AGENT],
          ready: true,
          rows: [],
          onResume,
          onFork,
        }),
      ),
    );
    expect(a.ensureFresh).toHaveBeenCalledTimes(1);

    const input = document.querySelector<HTMLInputElement>(".browser__search")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(input),
        "value",
      )!.set!;
      setter.call(input, "auth");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(a.search).toHaveBeenCalledWith("auth");

    const row = document.querySelector(".history__row")!;
    act(() => row.querySelector<HTMLButtonElement>(".history__resume")!.click());
    expect(onResume).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "u-1", cwd: "/repo/wt" }),
    );
    act(() => row.querySelector<HTMLButtonElement>(".history__fork")!.click());
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  it("waits for the catalog before declaring the index need", async () => {
    const a = api([]);
    const props = {
      api: a,
      agents: [CAPABLE_AGENT],
      rows: [],
      onResume: vi.fn(),
      onFork: vi.fn(),
    };
    await act(async () =>
      root.render(createElement(SessionsBrowser, { ...props, ready: false })),
    );
    expect(a.ensureFresh).not.toHaveBeenCalled();

    await act(async () =>
      root.render(createElement(SessionsBrowser, { ...props, ready: true })),
    );
    expect(a.ensureFresh).toHaveBeenCalledTimes(1);
  });

  it("Resume is blocked for a pathless or deleted directory — Fork stays", async () => {
    worktreeIpc.probeWorktree.mockImplementation((path: string) =>
      Promise.resolve({ exists: path !== "/gone", isWorktree: false, branch: null }),
    );
    const a = api([
      hit({ sessionId: "no-dir", cwd: "" }),
      hit({ sessionId: "gone-dir", cwd: "/gone" }),
      hit({ sessionId: "fine", cwd: "/repo/wt" }),
    ]);
    await mount(a);
    await act(async () => {});
    const rows = document.querySelectorAll(".history__row");
    const resumeOf = (row: Element) =>
      row.querySelector<HTMLButtonElement>(".history__resume")!;
    expect(resumeOf(rows[0]).disabled).toBe(true); // cwd ""
    expect(resumeOf(rows[1]).disabled).toBe(true); // deleted dir
    expect(resumeOf(rows[2]).disabled).toBe(false);
    // Forking rescues both blocked rows.
    expect(rows[0].querySelector(".history__fork")).not.toBeNull();
    expect(rows[1].querySelector(".history__fork")).not.toBeNull();
  });

  it("a stale transcript response never renders under a newer row's header", async () => {
    type Page = { role: "user"; text: string }[];
    const resolvers: ((page: Page) => void)[] = [];
    const a = api([hit(), hit({ sessionId: "u-2", title: "second" })]);
    a.transcript = vi.fn(
      () =>
        new Promise<Page>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    await mount(a);
    const opens = document.querySelectorAll<HTMLButtonElement>(".browser__open");
    await act(async () => opens[0].click()); // row A — response delayed
    await act(async () => opens[1].click()); // row B — response delayed
    // A's SLOW response lands after B was opened: it must be dropped.
    await act(async () => resolvers[0]([{ role: "user", text: "A's page" }]));
    expect(document.body.textContent).not.toContain("A's page");
    await act(async () => resolvers[1]([{ role: "user", text: "B's page" }]));
    expect(document.body.textContent).toContain("B's page");
  });

  it("opening a row reads the transcript through the plugin", async () => {
    const a = api([hit()]);
    await mount(a);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    // First transcript page is a viewport fill (50); later pages come in 20s.
    expect(a.transcript).toHaveBeenCalledWith("claude", "/store/u-1.jsonl", 0, 50);
    expect(document.querySelector(".browser__turn--user")?.textContent).toBe("hello");
  });

  it("the WHOLE row opens the transcript; the action buttons stay their own targets", async () => {
    const a = api([hit()]);
    const onResume = vi.fn();
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [CAPABLE_AGENT],
          ready: true,
          rows: [],
          onResume,
          onFork: vi.fn(),
        }),
      ),
    );
    // Resume must NOT bubble into opening the viewer.
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".history__resume")!.click(),
    );
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(a.transcript).not.toHaveBeenCalled();

    // A click on the row itself (not the text button) opens it.
    await act(async () =>
      document.querySelector<HTMLLIElement>(".history__row")!.click(),
    );
    expect(a.transcript).toHaveBeenCalledTimes(1);
  });

  it("the viewer backs out via the git-style drill-back row, labeled with the session", async () => {
    const a = api([hit()]);
    await mount(a);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    const back = document.querySelector<HTMLButtonElement>(".browser__back")!;
    expect(back.textContent).toContain("auth bug");
    await act(async () => back.click());
    expect(document.querySelector(".browser__viewer")).toBeNull();
    expect(document.querySelector(".history__row")).not.toBeNull(); // the list again
  });

  it("hides unsupported actions and does not open stale indexed history", async () => {
    const a = api([hit()]);
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [
            {
              ...CAPABLE_AGENT,
              features: [],
            },
          ],
          ready: true,
          rows: [closed()],
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );

    expect(document.querySelector(".history__resume")).toBeNull();
    expect(document.querySelector(".history__fork")).toBeNull();
    const open = document.querySelector<HTMLButtonElement>(".browser__open")!;
    expect(open.disabled).toBe(true);
    // The HIT row (bottom block, past the divider) stays inert.
    const hitRow = bottomRows()[0];
    await act(async () => (hitRow as HTMLLIElement).click());
    expect(a.transcript).not.toHaveBeenCalled();
    expect(document.querySelector(".browser__viewer")).toBeNull();
  });

  it("shows the paging counter: partial as 'X of N', complete as the plain total", async () => {
    // The GLOBAL block's counter rides the divider; the workspace block's
    // rides the meta area — each from its own response.
    await mount(
      api([hit()], { bottom: blockOf([hit()], { total: 123, hasMore: true }) }),
      [closed({ title: "pinned" })],
    );
    expect(document.querySelector(".browser__section-count")?.textContent).toBe(
      " · 1 of 123",
    );

    await act(async () => root.unmount());
    document.body.innerHTML = "<div id='host2'></div>";
    root = createRoot(document.getElementById("host2")!);
    await mount(
      api([hit()], { bottom: blockOf([hit()], { total: 1 }) }),
      [closed({ title: "pinned" })],
    );
    expect(document.querySelector(".browser__section-count")?.textContent).toBe(
      " · 1",
    );
  });

  // ── Commit-2 guards: the counters count what the block DRAWS ────────

  it("C1-top: the workspace numerator includes journal rows; no 'shown > total' nonsense", async () => {
    // Journal-only composition: 2 records, zero index hits — the counter
    // shows 2 of 2, not "2 of 0", and not nothing.
    await mount(api([]), [closed(), closed({ sessionId: "s-2" })]);
    const count = document.querySelector(".browser__count")?.textContent;
    expect(count).toBe("2");
  });

  it("C1-top twins: the twin is subtracted from the DENOMINATOR, not drawn twice", async () => {
    // Two journal records + the engine's page carrying one twin and one
    // stranger. Drawn: 3 (both journal rows + the stranger). Denominator:
    // 2 journal + engine total 5 − 1 twin = 6. The OLD counter showed
    // "3 of 5" — the raw engine total, journal missing, twin uncounted.
    await mount(
      api([], {
        top: blockOf(
          [hit({ sessionId: "s-1" }), hit({ sessionId: "w-1" })],
          { total: 5 },
        ),
      }),
      [
        closed({ transcriptPath: "/j/s-1" }),
        closed({ sessionId: "s-2" }),
      ],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe(
      "3 of 6",
    );
  });

  it("C1-field overall: the search field's counter sums BOTH blocks — the drawn whole, not the top alone", async () => {
    // Journal 2 (one a twin of a top hit); top loaded 3 (1 twin + 2
    // strangers) with raw total 6; bottom loaded 2, no twins, raw 7.
    // Blocks: top 4 of 7, bottom 2 of 7 — the FIELD must speak of the
    // whole: 6 of 14, the sum of what both blocks draw.
    await mount(
      api([], {
        top: blockOf(
          [hit({ sessionId: "s-1" }), hit({ sessionId: "w-1" }), hit({ sessionId: "w-2" })],
          { total: 6 },
        ),
        bottom: blockOf([hit({ sessionId: "b-1" }), hit({ sessionId: "b-2" })], {
          total: 7,
        }),
      }),
      [closed({ transcriptPath: "/j/s-1" }), closed({ sessionId: "s-2" })],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe(
      "6 of 14",
    );
  });

  it("C1-field empty-top: the top block EMPTY, the bottom alive — the counter still shows", async () => {
    // No journal records, no top hits: the old field condition
    // (top.total > 0) rendered NO number over a fully drawn list. The
    // aggregate does not hide: 2 of 5.
    await mount(
      api([], {
        bottom: blockOf([hit({ sessionId: "b-1" }), hit({ sessionId: "b-2" })], {
          total: 5,
        }),
      }),
      [],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe(
      "2 of 5",
    );
  });

  it("C1-bottom: the global numerator counts DRAWN rows — the loaded twin is neither drawn nor counted", async () => {
    // The bottom engine loaded 2 hits, one of which the journal draws:
    // the counter says 1 of (2−1).
    await mount(
      api([], {
        bottom: blockOf([hit({ sessionId: "g-1" }), hit({ sessionId: "s-1" })], {
          total: 2,
        }),
      }),
      [closed({ transcriptPath: "/j/s-1" })],
    );
    expect(document.querySelector(".browser__section-count")?.textContent).toBe(
      " · 1",
    );
  });

  it("C1-bottom hasMore: both ternary branches draw the adjusted population", async () => {
    // Loaded 2 (one stranger, one twin) of engine total 3, more pages to
    // come: "1 of 2" — numerator the DRAWN stranger, denominator 3 − the
    // loaded twin. The OLD counter said "2 of 3" (the loaded batch size
    // over the raw total). The bare-total branch is the C1-bottom case
    // above.
    await mount(
      api([], {
        bottom: blockOf(
          [hit({ sessionId: "g-1" }), hit({ sessionId: "s-1" })],
          { total: 3, hasMore: true },
        ),
      }),
      [closed({ transcriptPath: "/j/s-1" })],
    );
    expect(document.querySelector(".browser__section-count")?.textContent).toBe(
      " · 1 of 2",
    );
  });

  it("the divider never says 'All sessions · 0' over an empty bottom", async () => {
    // The raw engine total is 1 (the twin); the drawn bottom is empty —
    // the divider's count hides entirely, no " · 0" over nothing.
    await mount(
      api([], {
        bottom: blockOf([hit({ sessionId: "s-1" })], { total: 1 }),
      }),
      [closed({ transcriptPath: "/j/s-1" })],
    );
    expect(document.querySelector(".browser__section")).toBeNull();
  });

  it("pulls the next page while the list is shorter than its viewport — scroll alone can't fire there", async () => {
    const a = api([hit()], { bottom: blockOf([hit()], { total: 123, hasMore: true }) });
    await mount(a);
    // happy-dom's zero-height layout IS the unfilled-viewport case.
    expect(a.bottom.loadMore).toHaveBeenCalled();
  });

  it("an empty transcript reads as empty, not as loading forever", async () => {
    const a = api([hit()]);
    a.transcript = vi.fn(() => Promise.resolve([]));
    await mount(a);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    expect(document.body.textContent).toContain("No transcript content");
    expect(document.querySelector(".browser__spinner")).toBeNull();
  });

  it("a loading page shows a spinner as the list/viewer tail, not an empty stall", async () => {
    const a = api([hit()], {
      bottom: blockOf([hit()], { total: 123, hasMore: true, loadingMore: true }),
    });
    a.transcript = vi.fn(
      () => new Promise<AgentTranscriptEntry[]>(() => {}), // never resolves
    );
    await mount(a);
    expect(
      document.querySelector(".browser__list .browser__more .browser__spinner"),
    ).not.toBeNull();

    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    expect(
      document.querySelector(".browser__viewer-body .browser__spinner"),
    ).not.toBeNull();
  });
});

describe("SessionsBrowser journal section", () => {
  let root: Root;
  beforeEach(() => {
    worktreeIpc.probeWorktree.mockClear();
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = (
    a: SessionsBrowserApi,
    rows: SessionRecord[],
    onResume = vi.fn(),
    onFork = vi.fn(),
  ) => {
    const result = act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [CAPABLE_AGENT],
          ready: true,
          rows,
          onResume,
          onFork,
        }),
      ),
    );
    return { ...result, onResume, onFork };
  };

  it("journal rows pin first, before the hits, with directory and branch chips and state dot", async () => {
    await mount(
      api([hit({ sessionId: "u-9", title: "other session" })]),
      [closed({ title: "auth bug", branch: "kd/ws/1" }), live()],
    );
    const rows = document.querySelectorAll(".history__row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("auth bug");
    // Both chips render on a bound row: the directory (same chip as the
    // hits' rows — one row shape) and the branch after it.
    const chips = rows[0].querySelectorAll(".history__chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe("repo");
    expect(chips[1].textContent).toBe("kd/ws/1");
    expect(rows[0].querySelector(".history__state--live")).toBeNull();
    expect(rows[1].querySelector(".history__state--live")).not.toBeNull();
    expect(rows[2].textContent).toContain("other session");
    // A hit row knows no liveness — the painted dot is absent as a
    // node (the neutral slot holds the place, silently).
    expect(rows[2].querySelector(".history__state")).toBeNull();
    // The divider sits between the pinned rows and the hits, carrying
    // the global block's own counter.
    const divider = document.querySelector(".browser__section");
    expect(divider?.textContent).toContain("All sessions");
  });

  it("a hit already pinned in the journal is not duplicated below", async () => {
    await mount(
      api([
        hit({ sessionId: "s-1" }), // same agent:sessionId as the journal row
        hit({ sessionId: "u-9", title: "other session" }),
      ]),
      [closed({ title: "auth bug" })],
    );
    const rows = document.querySelectorAll(".history__row");
    expect(rows).toHaveLength(2); // journal row + the one non-dup hit
    expect(bottomRows()).toHaveLength(1);
    expect(bottomRows()[0].textContent).toContain("other session");
  });

  it("an active query filters the pinned section client-side; content-only matches survive in the hits", async () => {
    // "auth" matches the journal row's title, so s-1 stays pinned and its
    // hit dedupes; s-2's title does NOT match, so its hit (a content match
    // from the index) must still show below instead of vanishing.
    await mount(
      api(
        [hit({ sessionId: "s-1" }), hit({ sessionId: "s-2", title: "s-2" })],
        { query: "auth" },
      ),
      [closed({ title: "auth bug" }), closed({ sessionId: "s-2", title: "ci" })],
    );
    const journal = topRows();
    expect(journal).toHaveLength(1);
    expect(journal[0].textContent).toContain("auth bug");
    const below = bottomRows();
    expect(below).toHaveLength(1);
    expect(below[0].textContent).toContain("s-2");
  });

  it("the × is gone — a journal row has no way out of the list", async () => {
    // The "forget" glyph promised deletion it never performed (the
    // conversation stayed on disk and in All sessions), and it let the
    // journal of WHAT RAN HERE be edited by hand — silence is the
    // filtering this step forbids. Wrong-owner rows answer with their
    // status instead.
    await mount(api([]), [closed(), closed({ sessionId: "s-2" })]);
    expect(document.querySelector(".history__delete")).toBeNull();
    expect(topRows()).toHaveLength(2);
  });

  it("a live journal row offers no Resume; a gone dir blocks it — Fork stays", async () => {
    worktreeIpc.probeWorktree.mockImplementation((path: string) =>
      Promise.resolve({ exists: path !== "/gone", isWorktree: false, branch: null }),
    );
    const onResume = vi.fn();
    await mount(
      api([]),
      [closed({ title: "auth bug" }), live(), closed({ sessionId: "s-3", cwd: "/gone" })],
      onResume,
    );
    await act(async () => {});
    // Rows by CONTENT, not position: the composite axis owns the order
    // now, and equal time marks may re-seat.
    const byText = (frag: string) =>
      [...document.querySelectorAll(".history__row")].find((r) =>
        r.textContent?.includes(frag),
      )!;
    const resumeOf = (row: Element) =>
      row.querySelector<HTMLButtonElement>(".history__resume");
    expect(resumeOf(byText("auth bug"))?.disabled).toBe(false);
    expect(resumeOf(byText("s-live"))).toBeNull(); // the live row has none
    expect(byText("s-3").querySelector(".history__missing")).not.toBeNull();
    expect(resumeOf(byText("s-3"))?.disabled).toBe(true);
    expect(byText("s-3").querySelector(".history__fork")).not.toBeNull();
    act(() => resumeOf(byText("auth bug"))!.click());
    expect(onResume).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "s-1", state: "closed" }),
    );
  });

  it("a journal row OPENS on its joined read link — the journal path first, the index's reference in its absence", async () => {
    const a = api([], {}, {
      "claude:s-2": { kind: "hit", reference: "/store/s-2", title: "from the index", mtime: 7 },
    });
    await mount(a, [
      closed({ title: "own title", transcriptPath: "/journal/s-1.jsonl" }),
      closed({ sessionId: "s-2" }),
    ]);
    const openButtons = topRows().map(
      (row) => row.querySelector<HTMLButtonElement>(".browser__open")!,
    );
    expect(openButtons).toHaveLength(2);

    await act(async () => openButtons[0].click());
    // A row with its own transcript path reads BY THAT PATH.
    expect(a.transcript).toHaveBeenNthCalledWith(1, "claude", "/journal/s-1.jsonl", 0, 50);

    // A row without one reads by the index's reference.
    await act(async () => openButtons[1].click());
    expect(a.transcript).toHaveBeenNthCalledWith(2, "claude", "/store/s-2", 0, 50);
  });

  it("the journal path wins over the index's link when both exist — the union is not a replacement", async () => {
    const a = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/store/s-1", title: "index title", mtime: 7 },
    });
    await mount(a, [closed({ title: "own", transcriptPath: "/journal/s-1.jsonl" })]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    expect(a.transcript).toHaveBeenCalledExactlyOnceWith(
      "claude",
      "/journal/s-1.jsonl",
      0,
      50,
    );
  });

  it("empty journal and no hits shows the + Agent hint; hits without a journal need no divider", async () => {
    await mount(api([], { scanning: false }), []);
    expect(document.body.textContent).toContain("+ Agent");
    expect(document.querySelector(".browser__section")).toBeNull();

    await act(async () => root.unmount());
    document.body.innerHTML = "<div id='host2'></div>";
    root = createRoot(document.getElementById("host2")!);
    await mount(api([hit()]), []);
    expect(document.querySelectorAll(".browser__open")).toHaveLength(1);
    expect(document.querySelector(".browser__section")).toBeNull();
  });

  it("an active query matching nothing reads as 'No sessions match'", async () => {
    await mount(api([], { query: "zzz" }), [closed({ title: "auth bug" })]);
    expect(document.querySelector(".browser__empty")?.textContent).toBe(
      "No sessions match",
    );
  });

  it("a failed search is named even while journal rows are on screen", async () => {
    // The error row must not hide behind the empty-state gate: that gate
    // also requires the journal to be empty, so a workspace WITH journal
    // rows would show a failed search as a quietly shorter list — the wrong
    // answer with no indication anywhere.
    await mount(
      api([], { bottom: blockOf([], { error: "index unavailable" }), query: "auth" }),
      [closed({ title: "auth bug" })],
    );
    expect(document.body.textContent).toContain("Search failed: index unavailable");
    // The journal section is still there — the failure didn't eat the page.
    expect(document.body.textContent).toContain("auth bug");
    // And the misleading "No sessions match" is not shown alongside it.
    expect(document.body.textContent).not.toContain("No sessions match");
  });
});

describe("SessionsBrowser journal join", () => {
  let root: Root;
  beforeEach(() => {
    worktreeIpc.probeWorktree.mockClear();
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = (
    a: SessionsBrowserApi,
    rows: SessionRecord[],
    agents: AgentInfo[] = [CAPABLE_AGENT],
  ) =>
    act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents,
          ready: true,
          rows,
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );

  const chipOf = (row: Element) => row.querySelector(".history__status");

  it("an indexless pathless row does NOT flash 'nothing to read' on the FIRST paint", async () => {
    // The trap: the scan flag starts OFF and the ask goes out only after
    // the first render — deriving one from the other makes every row lie
    // for one frame. Checked synchronously, before any await.
    const a = api([], { scanning: false }, {});
    await mount(a, [closed({ sessionId: "bare" })]);
    const chip = chipOf(topRow());
    expect(chip?.textContent).toBe("Indexing…");
    expect(document.body.textContent).not.toContain("nothing to read");
  });

  it("'indexing' yields to 'nothing to read' only once the scan has settled", async () => {
    await mount(
      api([], { scanning: true }, { "claude:s-1": { kind: "absent" } }),
      [closed()],
    );
    expect(chipOf(topRow())?.textContent).toBe(
      "Indexing…",
    );

    await mount(
      api([], { scanning: false }, { "claude:s-1": { kind: "absent" } }),
      [closed()],
    );
    expect(chipOf(topRow())?.textContent).toBe(
      "nothing to read",
    );
  });

  it("scan ENDED, the last answer still owed: NOT 'nothing to read' — the hit lands and the title paints", async () => {
    // peer-1's review catch: the scan-end publish flips scanning:false
    // and bumps the revision in ONE re-render, so the re-ask is still
    // owed when the row repaints. The absent entry is provisional until
    // the table answers under the CURRENT revision — asserted
    // synchronously, exactly like the first-paint pin, because this is
    // the same class of lie one frame later.
    const owedFrame = api(
      [],
      { scanning: false },
      { "claude:s-1": { kind: "absent" } },
    );
    owedFrame.enrichment = {
      ...owedFrame.enrichment,
      pending: true,
    };
    await mount(owedFrame, [closed({ sessionId: "s-1" })]);
    const row = topRow();
    expect(chipOf(row)?.textContent).toBe("Indexing…");
    expect(document.body.textContent).not.toContain("nothing to read");

    // The revision-bumped re-ask lands a hit: the title paints, the chip
    // goes, the row opens.
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: api(
            [],
            { scanning: false },
            { "claude:s-1": { kind: "hit", reference: "/store/s-1", title: "the late title", mtime: 7 } },
          ),
          agents: [CAPABLE_AGENT],
          ready: true,
          rows: [closed({ sessionId: "s-1" })],
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );
    const landed = topRow();
    expect(landed.textContent).toContain("the late title");
    expect(chipOf(landed)).toBeNull();
    expect(
      landed.querySelector<HTMLButtonElement>(".browser__open"),
    ).not.toBeNull();
  });

  it("a row with nothing to read STAYS in the list — no case removes a row", async () => {
    await mount(
      api([], { scanning: false }, { "claude:s-1": { kind: "absent" } }),
      [closed({ title: "ran here" })],
    );
    const row = topRow();
    expect(row.textContent).toContain("ran here");
    expect(chipOf(row)?.textContent).toBe("nothing to read");
    // Not openable: the name cell renders disabled, and the row carries
    // no open affordance.
    expect(
      row.querySelector<HTMLButtonElement>(".browser__open")!.disabled,
    ).toBe(true);
    await act(async () => (row as HTMLLIElement).click());
  });

  it("the joined title: a nameless row takes the index's, a meaningful own name keeps itself, an agent-label title yields", async () => {
    await mount(
      api([], {}, {
        "claude:nameless": { kind: "hit", reference: "/r/n", title: "from the index", mtime: 7 },
        "claude:named": { kind: "hit", reference: "/r/x", title: "index version", mtime: 7 },
        // The label-equal title IS the "Claude Code" complaint.
        "claude:labelled": { kind: "hit", reference: "/r/l", title: "the real one", mtime: 7 },
      }),
      [
        closed({ sessionId: "nameless" }),
        closed({ sessionId: "named", title: "own meaningful title" }),
        closed({ sessionId: "labelled", title: CAPABLE_AGENT.label }),
      ],
    );
    const rows = topRows();
    expect(rows[0].textContent).toContain("from the index");
    expect(rows[1].textContent).toContain("own meaningful title");
    expect(rows[2].textContent).toContain("the real one");
    expect(rows[2].textContent).not.toContain("Claude Code");
  });

  it("a wrong-owner row is visible, named by what it knows, and NEVER opens or continues", async () => {
    const a = api([], {}, {
      // The three corrupted records: journal says claude, path leads into
      // the kimi store, the id lives under kimi.
      "claude:kimi-9": { kind: "foreign", agents: ["kimi"] },
    });
    const onResume = vi.fn();
    const onFork = vi.fn();
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [CAPABLE_AGENT],
          ready: true,
          rows: [
            closed({
              sessionId: "kimi-9",
              title: "probe",
              transcriptPath: "/.kimi-code/sessions/kimi-9",
            }),
          ],
          onResume,
          onFork,
        }),
      ),
    );
    const row = topRow();
    expect(row.textContent).toContain("probe");
    expect(chipOf(row)?.textContent).toBe("wrong agent");
    expect(
      row.querySelector<HTMLButtonElement>(".browser__open")!.disabled,
    ).toBe(true);
    expect(row.querySelector(".history__resume")).toBeNull();
    expect(row.querySelector(".history__fork")).toBeNull();
    // The kimi path never reaches any plugin: not by row click, and the
    // continuation affordances are gone outright.
    await act(async () => (row as HTMLLIElement).click());
    expect(a.transcript).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
    expect(onFork).not.toHaveBeenCalled();
    // And no way out of the list either — the × is gone for every row,
    // a wrong-owner one included: its answer is the status, not an exit.
  });

  it("a failed first ask is named as itself, and a journal-path row stays readable through it", async () => {
    const a = api([], {}, {
      "claude:pathless": { kind: "error" },
      "claude:withpath": { kind: "error" },
    });
    await mount(a, [
      closed({ sessionId: "pathless" }),
      closed({ sessionId: "withpath", transcriptPath: "/journal/withpath.jsonl" }),
    ]);
    const rows = topRows();
    expect(chipOf(rows[0])?.textContent).toBe("index unreachable");
    expect(chipOf(rows[1])).toBeNull();
    await act(async () =>
      (
        rows[1].querySelector<HTMLButtonElement>(".browser__open")!
      ).click(),
    );
    expect(a.transcript).toHaveBeenCalledExactlyOnceWith(
      "claude",
      "/journal/withpath.jsonl",
      0,
      50,
    );
  });

  it("a landed title paints its OWN row: order and composition never move", async () => {
    // Second row (nameless until the answer lands) enriched, first keeps
    // its own title — the list must stay [first, second] with both rows
    // present; enrichment is paint, not placement.
    await mount(
      api([], {}, { "claude:s-2": { kind: "hit", reference: "/r/2", title: "landed title", mtime: 7 } }),
      [closed({ title: "first" }), closed({ sessionId: "s-2" })],
    );
    const rows = topRows();
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("first");
    expect(rows[1].textContent).toContain("landed title");
    expect(rows[0].textContent).not.toContain("landed title");
  });

  it("two lists over one shared api: answers land per row, each list enriches its own", async () => {
    // The shared-cell regression: hidden lists with other rows used to be
    // the hazard. Here one api feeds two browsers with disjoint journals;
    // the keyed table paints each list's own rows only.
    const shared = api([], {}, {
      "claude:a": { kind: "hit", reference: "/r/a", title: "alpha title", mtime: 7 },
      "codex:b": { kind: "hit", reference: "/r/b", title: "beta title", mtime: 7 },
    });
    const agents: AgentInfo[] = [
      CAPABLE_AGENT,
      { ...CAPABLE_AGENT, id: "codex", label: "Codex" },
    ];
    await act(async () =>
      root.render(
        createElement("div", null, [
          createElement(SessionsBrowser, {
            key: "ws-1",
            api: shared,
            agents,
            ready: true,
            rows: [closed({ sessionId: "a" })],
            onResume: vi.fn(),
            onFork: vi.fn(),
          }),
          createElement(SessionsBrowser, {
            key: "ws-2",
            api: shared,
            agents,
            ready: true,
            rows: [
              closed({ agent: "codex" as never, sessionId: "b", branch: "kd/ws/2" }),
            ],
            onResume: vi.fn(),
            onFork: vi.fn(),
          }),
        ]),
      ),
    );
    // Same key shape as the app: two INDEPENDENT lists in one document.
    const lists = document.querySelectorAll(".browser__list");
    expect(lists).toHaveLength(2);
    expect(lists[0].textContent).toContain("alpha title");
    expect(lists[0].textContent).not.toContain("beta title");
    expect(lists[1].textContent).toContain("beta title");
    expect(lists[1].textContent).not.toContain("alpha title");
  });

  it("a journal record whose index twin has an EMPTY cwd: top shows it, the bottom has NO twin", async () => {
    // Twelve live rows hit exactly this: their index rows carry no cwd,
    // never match any Only-set, and would fall through to Except —
    // doubling a row the top block already shows. The dedup is by
    // journal KEY, wherever the twin's cwd falls (or doesn't).
    const a = api([], {
      top: blockOf([hit({ sessionId: "s-1", cwd: "", reference: "/store/s-1" })]),
      bottom: blockOf([hit({ sessionId: "s-1", cwd: "", reference: "/store/s-1" })]),
    });
    await mount(a, [closed({ sessionId: "s-1", transcriptPath: "/journal/s-1.jsonl" })]);
    const all = listRows();
    expect(all).toHaveLength(1); // once, not twice
    expect(topRows()).toHaveLength(1);
    expect(bottomRows()).toHaveLength(0);
  });

  it("a journal record with its folder OUTSIDE the workspace set: top by binding fact, no twin below", async () => {
    // Guards the rule, not today's data: with the widest factory the
    // folder is usually IN the set by construction — but binding is a
    // recorded FACT, and no directory filter may unseat it.
    const a = api([], {
      top: blockOf([hit({ sessionId: "s-1", cwd: "/foreign" })]),
      bottom: blockOf([hit({ sessionId: "s-1", cwd: "/foreign" })]),
    });
    await mount(a, [closed({ sessionId: "s-1", cwd: "/foreign" })]);
    expect(listRows()).toHaveLength(1);
    expect(topRows()).toHaveLength(1);
    expect(bottomRows()).toHaveLength(0);
  });

  it("the top block is a UNION: a workspace-folder hit the journal lacks rides TOP", async () => {
    const a = api([], {
      top: blockOf([hit({ sessionId: "w-1", title: "folder hit" })]),
      bottom: blockOf([hit({ sessionId: "g-1", title: "global hit" })]),
    });
    await mount(a, [closed({ sessionId: "s-1", transcriptPath: "/journal/s-1.jsonl" })]);
    const top = topRows();
    expect(top).toHaveLength(2); // the bound record AND the folder hit
    expect(top[0].querySelector(".history__state")).not.toBeNull(); // bound first
    expect(top[0].textContent).toContain("s-1"); // nameless → its session id
    expect(top[1].querySelector(".history__state")).toBeNull(); // the hit: no dot node
    expect(top[1].textContent).toContain("folder hit");
    const bottom = bottomRows();
    expect(bottom).toHaveLength(1);
    expect(bottom[0].textContent).toContain("global hit");
  });

  it("the top block stands on ONE axis: conversation time, journal marks for the rest", async () => {
    // An index row NEWER than every journal row sits ABOVE them; a
    // journal row the index knows stands by its CONVERSATION time (the
    // landed mtime), not its binding time; a row the index doesn't know
    // keeps its journal-mark place among them instead of sinking below
    // all index rows.
    const a = api(
      [],
      { top: blockOf([hit({ sessionId: "h", title: "newest hit", mtime: 400_000 })]) },
      {
        "claude:k": { kind: "hit", reference: "/store/k", title: "known", mtime: 300_000 },
      },
    );
    await mount(a, [
      closed({
        sessionId: "k",
        title: "known",
        transcriptPath: "/j/k",
        // An ANCIENT binding — its landed mtime must outweigh it.
        boundAt: new Date(1).toISOString(),
        endedAt: new Date(1).toISOString(),
      }),
      closed({
        sessionId: "u",
        title: "unknown",
        boundAt: new Date(1).toISOString(),
        endedAt: new Date(200_000).toISOString(),
      }),
    ]);
    const names = topRows().map((r) => r.textContent ?? "");
    expect(names[0]).toContain("newest hit");
    expect(names[1]).toContain("known");
    expect(names[2]).toContain("unknown");
  });

  it("enrichment entries set the row's axis place — two static join snapshots, composition untouched", async () => {
    // Two journal rows by their journal marks; then the index answer
    // lands a recent conversation time for the older one — it moves up to
    // its time place. Same rows, same keys: enrichment re-ordered, never
    // composed. Two static join snapshots; this asserts composition/sort
    // semantics, not a landing transition; the latter is characterized
    // in SessionsBrowser.join.integration.test.tsx.
    const rows = [
      closed({ sessionId: "x", endedAt: new Date(100_000).toISOString() }),
      closed({ sessionId: "y", endedAt: new Date(300_000).toISOString() }),
    ];
    await mount(api([], {}, {}), rows);
    let names = topRows().map((r) => r.textContent ?? "");
    expect(names[0]).toContain("y");
    expect(names[1]).toContain("x");

    await mount(
      api([], {}, { "claude:x": { kind: "hit", reference: "/s/x", title: null, mtime: 500_000 } }),
      rows,
    );
    names = topRows().map((r) => r.textContent ?? "");
    expect(names[0]).toContain("x"); // re-seated by its landed time
    expect(names[1]).toContain("y");
    expect(topRows()).toHaveLength(2); // composition unchanged
  });

  it("one session id in two workspaces' journals: both rows get the title and keep their own branch", async () => {
    const shared = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/r/1", title: "the shared truth", mtime: 7 },
    });
    await act(async () =>
      root.render(
        createElement("div", null, [
          createElement(SessionsBrowser, {
            key: "ws-1",
            api: shared,
            agents: [CAPABLE_AGENT],
            ready: true,
            rows: [closed({ branch: "kd/ws/1" })],
            onResume: vi.fn(),
            onFork: vi.fn(),
          }),
          createElement(SessionsBrowser, {
            key: "ws-2",
            api: shared,
            agents: [CAPABLE_AGENT],
            ready: true,
            rows: [closed({ branch: "kd/ws/2" })],
            onResume: vi.fn(),
            onFork: vi.fn(),
          }),
        ]),
      ),
    );
    const rows = topRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).toContain("the shared truth");
    }
    // Directory chip first, the workspace's own branch behind it.
    const chipsOf = (row: Element) =>
      [...row.querySelectorAll(".history__chip")].map((c) => c.textContent);
    expect(chipsOf(rows[0])).toEqual(["repo", "kd/ws/1"]);
    expect(chipsOf(rows[1])).toEqual(["repo", "kd/ws/2"]);
  });

  it("the row declares its keys to the shared table on mount and as the journal grows", async () => {
    const a = api([]);
    await mount(a, [closed(), closed({ sessionId: "s-2" })]);
    expect(a.enrichment.declare).toHaveBeenCalledExactlyOnceWith([
      { agent: "claude", sessionId: "s-1" },
      { agent: "claude", sessionId: "s-2" },
    ]);

    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [CAPABLE_AGENT],
          ready: true,
          rows: [closed(), closed({ sessionId: "s-2" }), closed({ sessionId: "s-3" })],
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );
    expect(a.enrichment.declare).toHaveBeenLastCalledWith([
      { agent: "claude", sessionId: "s-1" },
      { agent: "claude", sessionId: "s-2" },
      { agent: "claude", sessionId: "s-3" },
    ]);
  });

  it("the index gave the link and the READ fell: a status on the row, the list unchanged, never 'nothing to read'", async () => {
    // The read attempt refused. The refusal is named as itself — on the
    // viewer and on the row — and the row keeps its place and its open
    // affordance.
    const a = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/vanished/s-1.jsonl", title: "gone file", mtime: 7 },
    });
    a.transcript = vi.fn(() => Promise.reject(new Error("no such file")));
    await mount(a, [closed({ sessionId: "s-1" })]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    const row = topRow();
    expect(row.textContent).toContain("gone file"); // still there, still titled
    expect(chipOf(row)?.textContent).toBe("read failed");
    expect(document.body.textContent).not.toContain("nothing to read");
    expect(document.querySelector(".browser__viewer")?.textContent).toContain(
      "Read failed: no such file",
    );
  });

  it("the journal link refuses but the index link succeeds: the row OPENS on the second, no failure mark", async () => {
    // The union is a fallback, not a display priority: both links are
    // opaque handles — one can refuse while the other still serves the
    // read. One attempt per source, mark only when both refused.
    const calls: string[] = [];
    const a = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/store/s-1", title: "the index knows", mtime: 7 },
    });
    a.transcript = vi.fn((_agent: string, ref: string) => {
      calls.push(ref);
      return ref === "/journal/dead.jsonl"
        ? Promise.reject(new Error("no such file"))
        : Promise.resolve([{ role: "user" as const, text: "read by the spare link" }]);
    });
    await mount(a, [
      closed({ sessionId: "s-1", transcriptPath: "/journal/dead.jsonl" }),
    ]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    // Tried in union order: journal first, the index link second.
    expect(calls).toEqual(["/journal/dead.jsonl", "/store/s-1"]);
    const row = topRow();
    expect(chipOf(row)).toBeNull(); // no failure mark — a link read
    expect(document.querySelector(".browser__turn--user")?.textContent).toBe(
      "read by the spare link",
    );
  });

  it("all read links refuse: the mark appears, the row stays, both attempts made", async () => {
    const calls: string[] = [];
    const a = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/store/refuses", title: "flaky both ways", mtime: 7 },
    });
    a.transcript = vi.fn((_agent: string, ref: string) => {
      calls.push(ref);
      return Promise.reject(new Error("permission denied"));
    });
    await mount(a, [
      closed({ sessionId: "s-1", transcriptPath: "/journal/refuses.jsonl" }),
    ]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    expect(calls).toEqual(["/journal/refuses.jsonl", "/store/refuses"]);
    const row = topRow();
    expect(row.textContent).toContain("flaky both ways");
    const chip = chipOf(row);
    expect(chip?.textContent).toBe("read failed");
    // The chip's title is EXACTLY the generic observation — no causal
    // story about files; a non-file cause must produce the same text.
    expect(chip?.getAttribute("title")).toBe(
      "Reading this session failed. This is not 'nothing to read': the row stays, and a retry is legitimate.",
    );
    expect(row.textContent).not.toContain("nothing to read");
    expect(document.querySelector(".browser__viewer")?.textContent).toContain(
      "Read failed: permission denied",
    );
  });

  it("a retry after a both-links failure goes through the union again — the mark retires on success", async () => {
    // The mark is a reaction, not a verdict: the row keeps its open
    // affordance and a later click (a retry that now succeeds) reads
    // cleanly and clears the mark.
    let dead = true;
    const a = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/store/s-1", title: "flaky", mtime: 7 },
    });
    a.transcript = vi.fn(() =>
      dead
        ? Promise.reject(new Error("no such file"))
        : Promise.resolve([{ role: "user" as const, text: "back again" }]),
    );
    await mount(a, [closed({ sessionId: "s-1", transcriptPath: "/journal/dead.jsonl" })]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    expect(
      chipOf(topRow())?.textContent ?? "",
    ).toBe("read failed");

    dead = false;
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    expect(chipOf(topRow())).toBeNull();
    expect(document.querySelector(".browser__turn--user")?.textContent).toBe(
      "back again",
    );
  });
});

describe("unified row guard — both blocks, one markup", () => {
  let root: Root;
  beforeEach(() => {
    worktreeIpc.probeWorktree.mockClear();
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  /** Two browsers side by side: one fed ONLY by the JOURNAL source, one
   * ONLY by the INDEX source, with values picked so the two rows say the
   * SAME thing. The guard then serializes both rows and demands equality —
   * the test does not know which markup is correct, only that the two
   * blocks' must coincide. */
  const mountTwoSources = (journal: SessionRecord[], hits: SearchHit[]) =>
    act(async () =>
      root.render(
        createElement("div", null, [
          createElement("div", { key: "from-journal" },
            createElement(SessionsBrowser, {
              api: api([]),
              agents: [CAPABLE_AGENT],
              ready: true,
              rows: journal,
              onResume: vi.fn(),
              onFork: vi.fn(),
            }),
          ),
          createElement("div", { key: "from-index" },
            createElement(SessionsBrowser, {
              api: api(hits),
              agents: [CAPABLE_AGENT],
              ready: true,
              rows: [],
              onResume: vi.fn(),
              onFork: vi.fn(),
            }),
          ),
        ]),
      ),
    );

  const rowOf = (hostIndex: number) =>
    document.querySelectorAll(".browser__list > .history__row")[hostIndex]!;

  const mount = (a: SessionsBrowserApi, rows: SessionRecord[]) =>
    act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [CAPABLE_AGENT],
          ready: true,
          rows,
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );

  /** The named skeleton: these cells and their ORDER are the requirement.
   * Extracted per name — glyph, name, folder, time, actions — so the
   * comparison cannot pass on accidental overall equality while a cell
   * moved. */
  const skeletonOf = (row: Element) => ({
    glyph: !!row.querySelector(".history__glyph"),
    name: row.querySelector(".browser__name")?.textContent ?? null,
    folder: row.querySelector(".history__chip")?.textContent ?? null,
    time: row.querySelector(".history__when")?.textContent ?? null,
    actions: [...row.querySelectorAll("button")]
      .filter((b) => !b.className.includes("browser__open"))
      .map((b) => b.textContent),
  });

  /** The slot TREE: the named cells and their ORDER are the requirement
   * — permanent, in every data row, whatever facts the row has — and
   * the metadata band's slots are part of the tree (a nested grid of
   * its own, still named cells). No filtering, no lifting: an absent
   * fact must appear as its EMPTY slot, not as a missing node — a
   * conditional node anywhere in this tree is the regression this
   * guard exists to catch (it was the very defect: missing nodes made
   * every neighbor's cells drift). */
  const slotNameOf = (el: Element): string | { meta: unknown[] } => {
    const c = (el as HTMLElement).classList;
    if (c.contains("history__slot-state")) return "state";
    if (c.contains("history__glyph")) return "glyph";
    if (c.contains("browser__open")) return "name";
    if (c.contains("history__action--resume")) return "resume";
    if (c.contains("history__action--fork")) return "fork";
    if (c.contains("history__meta")) {
      return {
        meta: [...el.children].map((child) => {
          const cc = (child as HTMLElement).classList;
          if (cc.contains("history__cwd")) return "cwd";
          if (cc.contains("history__branch")) return "branch";
          if (cc.contains("history__when")) return "when";
          if (cc.contains("history__issues")) return "issues";
          return "other";
        }),
      };
    }
    return "other";
  };

  const slotsTreeOf = (row: Element): unknown[] =>
    [...row.children].map(slotNameOf);

  const SLOTS_TREE = [
    "state",
    "glyph",
    "name",
    "resume",
    "fork",
    { meta: ["cwd", "branch", "when", "issues"] },
  ];

  it("identical data renders identically through BOTH sources — serialization compared, not eyeballed", async () => {
    // The same session as a journal record and as an index hit: title,
    // directory, read link, time all matched (the hit's mtime IS the
    // record's endedAt epoch). No branch, no snippet — the honest
    // intersection both sources can speak.
    const ENDED = "2026-07-19T11:00:00.000Z";
    const record = closed({
      sessionId: "s-1",
      title: "the same conversation",
      transcriptPath: "/store/s-1.jsonl",
      endedAt: ENDED,
      branch: undefined,
    });
    const asHit = hit({
      sessionId: "s-1",
      title: "the same conversation",
      reference: "/store/s-1.jsonl",
      transcriptPath: "/store/s-1.jsonl",
      cwd: "/repo",
      mtime: Date.parse(ENDED),
      snippet: null,
    });
    // Browser 0 renders the row from the JOURNAL, browser 1 from the
    // INDEX — each sees only its own source.
    await act(async () =>
      root.render(
        createElement("div", null, [
          createElement("div", { key: "j" },
            createElement(SessionsBrowser, {
              api: api([]),
              agents: [CAPABLE_AGENT],
              ready: true,
              rows: [record],
              onResume: vi.fn(),
              onFork: vi.fn(),
            }),
          ),
          createElement("div", { key: "i" },
            createElement(SessionsBrowser, {
              api: api([asHit]),
              agents: [CAPABLE_AGENT],
              ready: true,
              rows: [],
              onResume: vi.fn(),
              onFork: vi.fn(),
            }),
          ),
        ]),
      ),
    );
    const fromJournal = rowOf(0);
    const fromIndex = rowOf(1);
    expect(skeletonOf(fromJournal)).toEqual(skeletonOf(fromIndex));
    // The FULL slot tree, no filtering and no removals: both rows carry
    // the same named slots in the same order, the metadata band nested
    // with its four — the journal row's extra facts live INSIDE their
    // slots as content, never as extra nodes between them.
    expect(slotsTreeOf(fromJournal)).toEqual(SLOTS_TREE);
    expect(slotsTreeOf(fromIndex)).toEqual(SLOTS_TREE);
    // The journal-source fact sits in ITS OWN cell: the state SLOT is
    // present in both rows, the PAINTED DOT is a child node that
    // exists only where liveness is known — an empty slot must never
    // draw the fact it lacks.
    expect(fromJournal.querySelector(".history__slot-state")).not.toBeNull();
    expect(fromIndex.querySelector(".history__slot-state")).not.toBeNull();
    expect(fromJournal.querySelector(".history__state")).not.toBeNull();
    expect(fromIndex.querySelector(".history__state")).toBeNull();
  });

  it("source-only cells are MAY-BE-ABSENT, not different: liveness dot and branch chip", async () => {
    // A bound row with a branch renders the dot and the second chip; a
    // hit row renders NEITHER fact — and both rows still carry the SAME
    // nine slots: the facts live inside their slots, the slots never
    // leave. The read link is matched on both sides so openability
    // itself does not diverge.
    const ENDED = "2026-07-19T11:00:00.000Z";
    await mountTwoSources(
      [
        closed({
          title: "t",
          branch: "kd/ws/1",
          endedAt: ENDED,
          transcriptPath: "/store/u-1.jsonl",
        }),
      ],
      [
        hit({
          sessionId: "s-1",
          title: "t",
          mtime: Date.parse(ENDED),
          cwd: "/repo",
          reference: "/store/u-1.jsonl",
          transcriptPath: "/store/u-1.jsonl",
          snippet: null,
        }),
      ],
    );
    const fromJournal = rowOf(0);
    const fromIndex = rowOf(1);
    // The dot exists only where liveness is known — as a CHILD of the
    // neutral state slot, which itself exists in both rows.
    expect(fromJournal.querySelector(".history__state")).not.toBeNull();
    expect(fromIndex.querySelector(".history__state")).toBeNull();
    // The branch chip exists only where a branch was recorded — and it
    // is the SECOND chip, the directory chip stays first.
    const journalChips = fromJournal.querySelectorAll(".history__chip");
    const indexChips = fromIndex.querySelectorAll(".history__chip");
    expect(journalChips).toHaveLength(2);
    expect(indexChips).toHaveLength(1);
    expect(journalChips[0].textContent).toBe(indexChips[0].textContent);
    // The folder chip's label carries the name in an EXPLICIT bidi
    // isolation — the clip side is the stylesheet's rtl, the name's
    // direction is never guessed.
    const folderLabel = journalChips[0].querySelector(".chip__label")!;
    const bdi = folderLabel.querySelector("bdi[dir='ltr']");
    expect(bdi?.textContent).toBe("repo");
    // The ORDER guard, independent of any block: both rows' slot trees
    // equal the same named shape — not merely each other.
    expect(slotsTreeOf(fromJournal)).toEqual(SLOTS_TREE);
    expect(slotsTreeOf(fromIndex)).toEqual(SLOTS_TREE);
  });

  it("two NAMELESS hits stay distinguishable — the session id, not a wall of agent labels", async () => {
    // The fallback must DISTINGUISH in BOTH blocks: the agent is already
    // the glyph, and a label fallback makes neighbors twins — the wall of
    // identical rows this whole work began with. The session id is ugly
    // but unique; the label fallback is gone from both sources' chains.
    await mount(
      api([hit({ sessionId: "zz-1", title: null }), hit({ sessionId: "zz-2", title: null })]),
      [closed({ sessionId: "zz-9", title: undefined })],
    );
    // No journal rows? There IS one — the top block's nameless record
    // shows its id too, not the agent label.
    const top = topRows();
    expect(top).toHaveLength(1);
    expect(top[0].textContent).toContain("zz-9");
    // The divider renders (a journal row exists); the hit rows below it.
    const rows = listRows();
    expect(rows).toHaveLength(3);
    const hitRows = rows.filter((r) =>
      r.textContent?.includes("zz-"),
    );
    expect(hitRows).toHaveLength(3);
    expect(rows[0].textContent).toContain("zz-9");
    expect(rows[1].textContent).toContain("zz-1");
    expect(rows[2].textContent).toContain("zz-2");
    expect(rows[0].textContent).not.toContain(CAPABLE_AGENT.label);
  });

  it("an EMPTY cwd is absence, not disappearance: no 'dir gone' chip, Resume blocked with its own words", async () => {
    await mount(api([hit({ sessionId: "no-dir", cwd: "" })]), []);
    const row = listRows()[0];
    expect(row.querySelector(".history__missing")).toBeNull();
    const resume = row.querySelector<HTMLButtonElement>(".history__resume")!;
    expect(resume.disabled).toBe(true);
    expect(resume.title).toBe("The session has no recorded directory");
    // The chip appears only for a NONEMPTY path that is gone.
    await act(async () => root.unmount());
    document.body.innerHTML = "<div id='host2'></div>";
    root = createRoot(document.getElementById("host2")!);
    worktreeIpc.probeWorktree.mockImplementation((path: string) =>
      Promise.resolve({ exists: path !== "/gone", isWorktree: false, branch: null }),
    );
    await mount(api([hit({ sessionId: "gone-dir", cwd: "/gone" })]), []);
    const goneRow = listRows()[0];
    expect(goneRow.querySelector(".history__missing")?.textContent).toBe("dir gone");
    expect(
      goneRow.querySelector<HTMLButtonElement>(".history__resume")!.disabled,
    ).toBe(true);
  });

  it("GREEN-THROUGH: an INDEX row at a resume-capable agent KEEPS its Resume button", async () => {
    // The union-narrowing trap: the natural-looking rewrite of the Resume
    // gate ("bound and not live") would silently strip the button from
    // EVERY index row — the bottom block's rows, which are exactly the
    // sessions Resume exists for. An index row has no liveness fact AT
    // ALL; absence of the fact is not aliveness. This guard is green
    // before AND after by design — its job is to keep the regression
    // out, and the mutation check (narrowed condition, one run) is its
    // proof of teeth.
    await mount(
      api([hit({ sessionId: "global-1", title: "from the index", cwd: "/repo" })]),
      [],
    );
    const row = listRows()[0];
    const resume = row.querySelector<HTMLButtonElement>(".history__resume");
    expect(resume).not.toBeNull();
    expect(resume!.disabled).toBe(false);
    expect(resume!.title).toBe("Resume in /repo");
  });
});
