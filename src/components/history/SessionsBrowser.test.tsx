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
    // A hit row knows no liveness — no dot cell at all, honestly.
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
    const rows = document.querySelectorAll(".history__row");
    const resumeOf = (row: Element) =>
      row.querySelector<HTMLButtonElement>(".history__resume");
    expect(resumeOf(rows[0])?.disabled).toBe(false);
    expect(resumeOf(rows[1])).toBeNull(); // the live row has none
    expect(rows[2].querySelector(".history__missing")).not.toBeNull();
    expect(resumeOf(rows[2])?.disabled).toBe(true);
    expect(rows[2].querySelector(".history__fork")).not.toBeNull();
    act(() => resumeOf(rows[0])!.click());
    expect(onResume).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: "s-1", state: "closed" }),
    );
  });

  it("a journal row OPENS on its joined read link — the journal path first, the index's reference in its absence", async () => {
    const a = api([], {}, {
      "claude:s-2": { kind: "hit", reference: "/store/s-2", title: "from the index" },
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
      "claude:s-1": { kind: "hit", reference: "/store/s-1", title: "index title" },
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
    expect(chip?.textContent).toBe("indexing…");
    expect(document.body.textContent).not.toContain("nothing to read");
  });

  it("'indexing' yields to 'nothing to read' only once the scan has settled", async () => {
    await mount(
      api([], { scanning: true }, { "claude:s-1": { kind: "absent" } }),
      [closed()],
    );
    expect(chipOf(topRow())?.textContent).toBe(
      "indexing…",
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
    expect(chipOf(row)?.textContent).toBe("indexing…");
    expect(document.body.textContent).not.toContain("nothing to read");

    // The revision-bumped re-ask lands a hit: the title paints, the chip
    // goes, the row opens.
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: api(
            [],
            { scanning: false },
            { "claude:s-1": { kind: "hit", reference: "/store/s-1", title: "the late title" } },
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
        "claude:nameless": { kind: "hit", reference: "/r/n", title: "from the index" },
        "claude:named": { kind: "hit", reference: "/r/x", title: "index version" },
        // The label-equal title IS the "Claude Code" complaint.
        "claude:labelled": { kind: "hit", reference: "/r/l", title: "the real one" },
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
      api([], {}, { "claude:s-2": { kind: "hit", reference: "/r/2", title: "landed title" } }),
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
      "claude:a": { kind: "hit", reference: "/r/a", title: "alpha title" },
      "codex:b": { kind: "hit", reference: "/r/b", title: "beta title" },
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
    expect(top[1].querySelector(".history__state")).toBeNull(); // the hit
    expect(top[1].textContent).toContain("folder hit");
    const bottom = bottomRows();
    expect(bottom).toHaveLength(1);
    expect(bottom[0].textContent).toContain("global hit");
  });

  it("one session id in two workspaces' journals: both rows get the title and keep their own branch", async () => {
    const shared = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/r/1", title: "the shared truth" },
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
    // The transcript file vanished between the scan that indexed it and
    // the open. The refusal is named as itself — on the viewer and on the
    // row — and the row keeps its place and its open affordance.
    const a = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/vanished/s-1.jsonl", title: "gone file" },
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

  it("the journal path is DEAD but the index link lives: the row OPENS on the second, no failure mark", async () => {
    // The union is a fallback, not a display priority: a journal path is a
    // record of the past, the index link reflects the last scan — a moved
    // file can leave the second live. One attempt per source, mark only
    // when both refused.
    const calls: string[] = [];
    const a = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/store/s-1", title: "the index knows" },
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

  it("BOTH links dead: the mark appears, the row stays, both attempts made", async () => {
    const calls: string[] = [];
    const a = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/store/dead-too", title: "both dead" },
    });
    a.transcript = vi.fn((_agent: string, ref: string) => {
      calls.push(ref);
      return Promise.reject(new Error("no such file"));
    });
    await mount(a, [
      closed({ sessionId: "s-1", transcriptPath: "/journal/dead.jsonl" }),
    ]);
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    expect(calls).toEqual(["/journal/dead.jsonl", "/store/dead-too"]);
    const row = topRow();
    expect(row.textContent).toContain("both dead");
    expect(chipOf(row)?.textContent).toBe("read failed");
    expect(document.querySelector(".browser__viewer")?.textContent).toContain(
      "Read failed: no such file",
    );
  });

  it("a retry after a both-links failure goes through the union again — the mark retires on success", async () => {
    // The mark is a reaction, not a verdict: the row keeps its open
    // affordance and a later click (the file came back, or the scan
    // fixed the link) reads cleanly and clears the mark.
    let dead = true;
    const a = api([], {}, {
      "claude:s-1": { kind: "hit", reference: "/store/s-1", title: "flaky" },
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

  /** The skeleton's ORDER as the direct children carry it — independent
   * of both blocks, so a wrong reordering cannot pass as "equally wrong
   * in both". Independent queries above cannot see order; this does. */
  const orderOf = (row: Element) =>
    [...row.children].map((el) => {
      const c = (el as HTMLElement).classList;
      if (c.contains("history__state")) return "state";
      if (c.contains("history__glyph")) return "glyph";
      if (c.contains("browser__open")) return "name";
      if (c.contains("history__chip")) return "chip";
      if (c.contains("history__when")) return "when";
      if (c.contains("history__missing") || c.contains("history__status"))
        return "statuschip";
      if (c.contains("history__resume")) return "resume";
      if (c.contains("history__fork")) return "fork";
      return "other";
    });

  /** The canonical skeleton sequence with the may-be-absent cells removed
   * (state, status chips) and the branch chip folded (a hit has no
   * branch, a bound row has one chip MORE). */
  const canonicalOf = (row: Element): string[] => {
    const order = orderOf(row).filter((m) => m !== "state" && m !== "statuschip");
    // Drop the LAST chip (the branch) when two render — cwd stays first.
    if (order.filter((m) => m === "chip").length > 1) {
      order.splice(order.lastIndexOf("chip"), 1);
    }
    return order;
  };

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
    // And the FULL serialization with the may-be-absent cells lifted (the
    // closed journal row renders its liveness dot; a hit cannot) — any
    // OTHER markup divergence between the blocks fails here, whatever its
    // name. The lift itself is audited by the next test.
    const lift = (row: Element) => {
      const clone = row.cloneNode(true) as Element;
      clone.querySelectorAll(".history__state").forEach((n) => n.remove());
      return clone;
    };
    expect(lift(fromJournal).outerHTML).toBe(lift(fromIndex).outerHTML);
  });

  it("source-only cells are MAY-BE-ABSENT, not different: liveness dot and branch chip", async () => {
    // A bound row with a branch renders the dot and the second chip; a
    // hit row renders NEITHER — and without them the skeleton is the same
    // one the identity guard compared. The read link is matched on both
    // sides so openability itself does not diverge.
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
    // The dot exists only where liveness is known.
    expect(fromJournal.querySelector(".history__state")).not.toBeNull();
    expect(fromIndex.querySelector(".history__state")).toBeNull();
    // The branch chip exists only where a branch was recorded — and it is
    // the SECOND chip, the directory chip stays first.
    const journalChips = fromJournal.querySelectorAll(".history__chip");
    const indexChips = fromIndex.querySelectorAll(".history__chip");
    expect(journalChips).toHaveLength(2);
    expect(indexChips).toHaveLength(1);
    expect(journalChips[0].textContent).toBe(indexChips[0].textContent);
    // The ORDER guard, independent of any block: both rows' canonical
    // sequences equal the same named order — glyph, name, chips, time,
    // actions — not merely each other.
    const CANONICAL = ["glyph", "name", "chip", "when", "resume", "fork"];
    expect(canonicalOf(fromJournal)).toEqual(CANONICAL);
    expect(canonicalOf(fromIndex)).toEqual(CANONICAL);
    // With the may-be-absent cells lifted out, the skeletons coincide.
    const lift = (row: Element) => {
      const clone = row.cloneNode(true) as Element;
      clone.querySelectorAll(".history__state").forEach((n) => n.remove());
      const chips = clone.querySelectorAll(".history__chip");
      if (chips.length > 1) chips[chips.length - 1].remove();
      return clone;
    };
    expect(lift(fromJournal).outerHTML).toBe(lift(fromIndex).outerHTML);
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
});
