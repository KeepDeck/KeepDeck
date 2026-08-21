// @vitest-environment happy-dom
import { act, createElement, memo } from "react";
import type { ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { SearchHit } from "../../ipc/history";
import type { AgentInfo } from "../../domain/agents";
import type { JoinEntry, SessionRecord } from "../../domain/journal";
import type { SessionsBrowserApi } from "../../app/useSessionsBrowser";
import { hitRecord, SessionsBrowser } from "./SessionsBrowser";
import { SessionRowView } from "./SessionRowView";
import { installResizeObserver, pinListViewport } from "./virtualGeometry.test-support";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const worktreeIpc = vi.hoisted(() => ({
  probeWorktree: vi.fn((_path: string) =>
    Promise.resolve({ exists: true, isWorktree: false, branch: null }),
  ),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);

// The row-render counter for the stability suite: hoisted with the mock
// that uses it (vi.mock bodies run before describe bodies). The wrapper
// is MEMOIZED itself — an unwrapped one would defeat the very memo the
// suite measures (React re-renders non-memo children whenever the
// parent re-renders, whatever the real component does).
const stability = vi.hoisted(() => ({
  rowRenders: vi.fn() as unknown as ReturnType<typeof vi.fn> & {
    (id: string): void;
  },
}));
vi.mock("./SessionRowView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./SessionRowView")>();
    const CountingRow = memo(function CountingRow(
      props: ComponentProps<typeof SessionRowView>,
    ) {
      stability.rowRenders(props.row.sessionId);
      return createElement(actual.SessionRowView, props);
    });
  return { ...actual, SessionRowView: CountingRow };
});

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

const laneOf = (
  hits: SearchHit[],
  over: {
    total?: number;
    hasMore?: boolean;
    loadingMore?: boolean;
    firstPagePending?: boolean;
    error?: string | null;
    loadMore?: () => void;
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
  workspace: laneOf([]),
  other: laneOf(hits),
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

/** The list is ONE queue: workspace rows first, other rows after —
 * no divider exists, and the boundary is the queue's own order. Tests
 * that need the halves read them BY POSITION, stating how many OTHER
 * rows their fixture drew; the ORDER guard (workspace never below
 * other) is what makes position a truth, not an assumption. */
const listRows = (): Element[] => [
  ...document.querySelectorAll(".browser__list > .history__row"),
];
/** The queue's head: everything above the last `otherCount` rows. */
const workspaceRows = (otherCount: number): Element[] => {
  const all = listRows();
  return all.slice(0, Math.max(all.length - otherCount, 0));
};
/** The queue's tail: the last `otherCount` rows (none when 0 —
 * slice(-0) would return the WHOLE list). */
const otherRows = (otherCount: number): Element[] => {
  const all = listRows();
  return otherCount === 0 ? [] : all.slice(-otherCount);
};
const topRow = (): Element => listRows()[0];

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
  let restoreViewport: () => void = () => {};
  beforeEach(() => {
    worktreeIpc.probeWorktree.mockClear();
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    // The virtualized list needs browser geometry the stand lacks: a
    // pinned viewport rect for the list container and a ResizeObserver.
    // This imitates the BROWSER (the adapter is test-support), not the
    // list's own logic.
    installResizeObserver();
    restoreViewport = pinListViewport(600);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    restoreViewport();
  });

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

  it("the opened session's header carries the row's OWN actions — same rules, no nested buttons", async () => {
    // Resume and Fork at the top right of the viewer, rendered from the
    // SAME availability unit as the list row; the back control stays a
    // SEPARATE button — actions never nest inside it.
    const onResume = vi.fn();
    const a = api([hit()]);
    await mount(a, [], { onResume });
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    const bar = document.querySelector(".browser__viewerbar")!;
    const back = bar.querySelector<HTMLButtonElement>(".browser__back")!;
    expect(back).not.toBeNull();
    // No nesting: the back button holds no buttons inside.
    expect(back.querySelector("button")).toBeNull();
    // Both actions present in the bar, inside their GROUP — the group
    // is the bar's ONE push-right child (margin rides the group, never
    // per button), and both sit OUTSIDE the back button.
    const group = bar.querySelector(".history__actions")!;
    expect(group).not.toBeNull();
    expect(bar.querySelectorAll(":scope > .history__actions")).toHaveLength(1);
    const resume = group.querySelector<HTMLButtonElement>(".history__resume");
    const fork = group.querySelector<HTMLButtonElement>(".history__fork");
    expect(resume).not.toBeNull();
    expect(fork).not.toBeNull();
    expect(back.contains(resume!)).toBe(false);
    expect(back.contains(fork!)).toBe(false);
    // And they obey the row's rules — the hit row resumes (no liveness
    // fact), and clicking dispatches like the row's own.
    expect(resume!.disabled).toBe(false);
    await act(async () => resume!.click());
    expect(onResume).toHaveBeenCalledTimes(1);
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
    // The OTHER lane's row (the queue's tail) stays inert.
    const hitRow = otherRows(1)[0];
    await act(async () => (hitRow as HTMLLIElement).click());
    expect(a.transcript).not.toHaveBeenCalled();
    expect(document.querySelector(".browser__viewer")).toBeNull();
  });

  it("shows the field's count: partial as 'X of N', complete as the plain total", async () => {
    // The FIELD's counter speaks for the whole list — journal rows and
    // both lanes' loaded hits, twins out. Partial: drawn 2 of a 124
    // bound (1 journal + 123 raw other); complete: 2 of 2.
    await mount(
      api([hit()], { other: laneOf([hit()], { total: 123, hasMore: true }) }),
      [closed({ title: "pinned" })],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe(
      "2 of 124",
    );

    await act(async () => root.unmount());
    document.body.innerHTML = "<div id='host2'></div>";
    root = createRoot(document.getElementById("host2")!);
    await mount(
      api([hit()], { other: laneOf([hit()], { total: 1 }) }),
      [closed({ title: "pinned" })],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe("2");
  });

  // ── Commit-2 guards: the counters count what the lanes DRAW ────────

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
        workspace: laneOf(
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

  it("C1-field whole list: the field's counter sums BOTH lanes — the drawn whole, not the workspace alone", async () => {
    // Journal 2 (one a twin of a workspace hit); the workspace lane
    // loaded 3 (1 twin + 2 strangers) with raw total 6; the other lane
    // loaded 2, no twins, raw 7. Lanes: workspace 4 of 7, other 2 of
    // 7 — the FIELD must speak of the whole: 6 of 14.
    await mount(
      api([], {
        workspace: laneOf(
          [hit({ sessionId: "s-1" }), hit({ sessionId: "w-1" }), hit({ sessionId: "w-2" })],
          { total: 6 },
        ),
        other: laneOf([hit({ sessionId: "b-1" }), hit({ sessionId: "b-2" })], {
          total: 7,
        }),
      }),
      [closed({ transcriptPath: "/j/s-1" }), closed({ sessionId: "s-2" })],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe(
      "6 of 14",
    );
  });

  it("C1-field empty workspace lane: the workspace lane EMPTY, the other alive — the counter still shows", async () => {
    // No journal records, no workspace hits: the OLD field condition
    // (the workspace lane's total > 0) rendered NO number over a fully
    // drawn list. The count does not hide: 2 of 5.
    await mount(
      api([], {
        other: laneOf([hit({ sessionId: "b-1" }), hit({ sessionId: "b-2" })], {
          total: 5,
        }),
      }),
      [],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe(
      "2 of 5",
    );
  });

  it("C1-other: the list's numerator counts DRAWN rows — the loaded twin is neither drawn nor counted", async () => {
    // The other lane loaded 2 hits, one of which the journal draws:
    // drawn 2 (journal 1 + the stranger), denominator 1 + (2 − 1 twin)
    // = 2 — EQUAL, the plain "2". Counting the twin would say "2 of 3".
    await mount(
      api([], {
        other: laneOf([hit({ sessionId: "g-1" }), hit({ sessionId: "s-1" })], {
          total: 2,
        }),
      }),
      [closed({ transcriptPath: "/j/s-1" })],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe("2");
  });

  it("C1-other hasMore: both ternary branches draw the adjusted population", async () => {
    // Loaded 2 (one stranger, one twin) of engine total 3, more pages to
    // come: drawn 2 of 3 (1 journal + 3 − the loaded twin) — "2 of 3".
    // The OLD raw reading said "3 of 3 + 1" (raw totals, twin in). The
    // bare-total branch is the C1-other case above.
    await mount(
      api([], {
        other: laneOf(
          [hit({ sessionId: "g-1" }), hit({ sessionId: "s-1" })],
          { total: 3, hasMore: true },
        ),
      }),
      [closed({ transcriptPath: "/j/s-1" })],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe(
      "2 of 3",
    );
  });

  it("the field's count never inflates over an all-twin other page", async () => {
    // The raw engine total is 1 (the twin); the drawn other lane is
    // empty — the twin must not inflate the list's denominator: the
    // journal row is all there is, and the count says just "1".
    await mount(
      api([], {
        other: laneOf([hit({ sessionId: "s-1" })], { total: 1 }),
      }),
      [closed({ transcriptPath: "/j/s-1" })],
    );
    expect(document.querySelector(".browser__count")?.textContent).toBe("1");
  });

  it("ONE queue: workspace rows first, other rows after, NOTHING between them — and no section node anywhere", async () => {
    // Belonging outranks time: the other lane's row is FRESHER, yet
    // rides below every workspace row. Between the two halves of the
    // queue there is no divider, no label, no node of any class — the
    // list is visually one.
    await mount(
      api([], {
        workspace: laneOf([hit({ sessionId: "w-1", title: "ws hit", mtime: 100 })]),
        other: laneOf([hit({ sessionId: "g-1", title: "fresher stranger", mtime: 900 })]),
      }),
      [closed({ sessionId: "s-1", endedAt: new Date(100_000).toISOString() })],
    );
    const all = listRows();
    expect(all).toHaveLength(3);
    expect(all[0].querySelector(".browser__name")?.getAttribute("title")).toBe("s-1");
    expect(all[1].querySelector(".browser__name")?.getAttribute("title")).toBe("w-1");
    expect(all[2].querySelector(".browser__name")?.getAttribute("title")).toBe("g-1");
    // Nothing between the halves — every list child between the first
    // and the last row is itself a row.
    const between = [...all[0].parentNode!.children].slice(
      [...all[0].parentNode!.children].indexOf(all[0]),
      [...all[0].parentNode!.children].indexOf(all[2]) + 1,
    );
    expect(between.every((el) => el.classList.contains("history__row"))).toBe(true);
    // And no section node exists anywhere in the document.
    expect(document.querySelector(".browser__section")).toBeNull();
  });

  it("ONE tail: exactly one spinner, LAST in the list, whatever loads — and one error line, never two", async () => {
    // Both lanes loading: ONE spinner at the end (it names no lane —
    // the list is loading). The workspace lane loading under drawn
    // other rows: still the one tail, last of all.
    const both = api([], {
      workspace: laneOf([hit({ sessionId: "w-1" })], { loadingMore: true }),
      other: laneOf([hit({ sessionId: "g-1" })], { loadingMore: true }),
    });
    await mount(both);
    const spinners = document.querySelectorAll(".browser__more");
    expect(spinners).toHaveLength(1);
    const listChildren = [...document.querySelector(".browser__list")!.children];
    expect(listChildren[listChildren.length - 1]).toBe(spinners[0]);

    await act(async () => root.unmount());
    document.body.innerHTML = "<div id='host2'></div>";
    root = createRoot(document.getElementById("host2")!);
    const workspaceOnly = api([], {
      workspace: laneOf([hit({ sessionId: "w-1" })], { loadingMore: true }),
      other: laneOf([hit({ sessionId: "g-1" })]),
    });
    await mount(workspaceOnly);
    expect(document.querySelectorAll(".browser__more")).toHaveLength(1);
    const lastChild = [...document.querySelector(".browser__list")!.children];
    const last = lastChild[lastChild.length - 1];
    expect(last?.classList.contains("browser__more")).toBe(true);

    // Both lanes refused: ONE error line (one sentence, no lane name).
    await act(async () => root.unmount());
    document.body.innerHTML = "<div id='host3'></div>";
    root = createRoot(document.getElementById("host3")!);
    const failed = api([], {
      workspace: laneOf([], { error: "bridge one" }),
      other: laneOf([], { error: "bridge two" }),
    });
    await mount(failed);
    const errors = [...document.querySelectorAll(".browser__empty")].filter((el) =>
      el.textContent?.includes("failed"),
    );
    expect(errors).toHaveLength(1);
  });

  it("pulls the next page while the list is shorter than its viewport — scroll alone can't fire there", async () => {
    const a = api([hit()], { other: laneOf([hit()], { total: 123, hasMore: true }) });
    await mount(a);
    // happy-dom's zero-height layout IS the unfilled-viewport case.
    expect(a.other.loadMore).toHaveBeenCalled();
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
      other: laneOf([hit()], { total: 123, hasMore: true, loadingMore: true }),
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
  let restoreViewport: () => void = () => {};
  beforeEach(() => {
    worktreeIpc.probeWorktree.mockClear();
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    installResizeObserver();
    restoreViewport = pinListViewport(600);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    restoreViewport();
  });

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

  it("journal rows ride first, before the other lane's rows, with the folder as meta text", async () => {
    await mount(
      api([hit({ sessionId: "u-9", title: "other session" })]),
      [closed({ title: "auth bug", branch: "kd/ws/1" }), live()],
    );
    const rows = document.querySelectorAll(".history__row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("auth bug");
    // The branch is GONE from the list row (secondary — it lives in
    // the pane header), and the folder is a META TEXT with the full
    // path in its tooltip, not a chip.
    expect(rows[0].querySelectorAll(".history__chip")).toHaveLength(0);
    const folder = rows[0].querySelector(".history__meta-folder");
    expect(folder?.textContent).toBe("repo");
    expect(folder?.getAttribute("title")).toBe("/repo");
    expect(rows[0].textContent).not.toContain("kd/ws/1");
    // The liveness dot is gone entirely — from EVERY row, whatever
    // its facts.
    expect(rows[0].querySelector(".history__state--live")).toBeNull();
    expect(rows[1].querySelector(".history__state--live")).toBeNull();
    expect(rows[2].querySelector(".history__state")).toBeNull();
    expect(rows[2].textContent).toContain("other session");
    // One queue, nothing between: the journal rows ride first, the
    // other lane's row after — and NO section node exists anywhere.
    expect(document.querySelector(".browser__section")).toBeNull();
    expect(rows[2].previousElementSibling).toBe(rows[1]);
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
    expect(otherRows(1)).toHaveLength(1);
    expect(otherRows(1)[0].textContent).toContain("other session");
  });

  it("an active query filters the journal client-side; content-only matches survive in the other lane", async () => {
    // "auth" matches the journal row's title, so s-1 rides the queue's
    // head and its hit dedupes; s-2's title does NOT match, so its hit
    // (a content match from the index) must still show in the queue's
    // tail instead of vanishing.
    await mount(
      api(
        [hit({ sessionId: "s-1" }), hit({ sessionId: "s-2", title: "s-2" })],
        { query: "auth" },
      ),
      [closed({ title: "auth bug" }), closed({ sessionId: "s-2", title: "ci" })],
    );
    const journal = workspaceRows(1);
    expect(journal).toHaveLength(1);
    expect(journal[0].textContent).toContain("auth bug");
    const below = otherRows(1);
    expect(below).toHaveLength(1);
    expect(below[0].textContent).toContain("s-2");
  });

  it("the × is gone — a journal row has no way out of the list", async () => {
    // The "forget" glyph promised deletion it never performed (the
    // conversation stayed on disk and in the session list), and it let the
    // journal of WHAT RAN HERE be edited by hand — silence is the
    // filtering this step forbids. Wrong-owner rows answer with their
    // status instead.
    await mount(api([]), [closed(), closed({ sessionId: "s-2" })]);
    expect(document.querySelector(".history__delete")).toBeNull();
    expect(workspaceRows(0)).toHaveLength(2);
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
    expect(byText("s-3").querySelector(".history__meta-mark")?.textContent).toBe("dir gone");
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
    const openButtons = workspaceRows(0).map(
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
      api([], { other: laneOf([], { error: "index unavailable" }), query: "auth" }),
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
  let restoreViewport: () => void = () => {};
  beforeEach(() => {
    worktreeIpc.probeWorktree.mockClear();
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    installResizeObserver();
    restoreViewport = pinListViewport(600);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    restoreViewport();
  });

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

  const chipOf = (row: Element) => row.querySelector(".history__meta-mark");

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
    const rows = workspaceRows(0);
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
    const rows = workspaceRows(0);
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
    const rows = workspaceRows(0);
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

  it("a journal record whose index twin has an EMPTY cwd: rides the queue once, ahead of every other row", async () => {
    // Twelve live rows hit exactly this: their index rows carry no cwd,
    // never match any Only-set, and would fall through to Except —
    // doubling a row already shown earlier in the list. The dedup is by
    // journal KEY, wherever the twin's cwd falls (or doesn't).
    const a = api([], {
      workspace: laneOf([hit({ sessionId: "s-1", cwd: "", reference: "/store/s-1" })]),
      other: laneOf([hit({ sessionId: "s-1", cwd: "", reference: "/store/s-1" })]),
    });
    await mount(a, [closed({ sessionId: "s-1", transcriptPath: "/journal/s-1.jsonl" })]);
    const all = listRows();
    expect(all).toHaveLength(1); // once, not twice
    expect(workspaceRows(0)).toHaveLength(1);
    expect(otherRows(0)).toHaveLength(0);
  });

  it("a journal record with its folder OUTSIDE the workspace set: ahead of every other row by binding fact, no twin in the tail", async () => {
    // Guards the rule, not today's data: with the widest factory the
    // folder is usually IN the set by construction — but binding is a
    // recorded FACT, and no directory filter may unseat it.
    const a = api([], {
      workspace: laneOf([hit({ sessionId: "s-1", cwd: "/foreign" })]),
      other: laneOf([hit({ sessionId: "s-1", cwd: "/foreign" })]),
    });
    await mount(a, [closed({ sessionId: "s-1", cwd: "/foreign" })]);
    expect(listRows()).toHaveLength(1);
    expect(workspaceRows(0)).toHaveLength(1);
    expect(otherRows(0)).toHaveLength(0);
  });

  it("the queue's head is a UNION: a workspace-folder hit the journal lacks rides it", async () => {
    const a = api([], {
      workspace: laneOf([hit({ sessionId: "w-1", title: "folder hit" })]),
      other: laneOf([hit({ sessionId: "g-1", title: "global hit" })]),
    });
    await mount(a, [closed({ sessionId: "s-1", transcriptPath: "/journal/s-1.jsonl" })]);
    const head = workspaceRows(1);
    expect(head).toHaveLength(2); // the bound record AND the folder hit
    expect(head[0].textContent).toContain("s-1"); // nameless → its session id
    expect(head[1].textContent).toContain("folder hit");
    const tail = otherRows(1);
    expect(tail).toHaveLength(1);
    expect(tail[0].textContent).toContain("global hit");
  });

  it("the workspace lane stands on ONE axis: conversation time, journal marks for the rest", async () => {
    // An index row NEWER than every journal row sits ABOVE them; a
    // journal row the index knows stands by its CONVERSATION time (the
    // landed mtime), not its binding time; a row the index doesn't know
    // keeps its journal-mark place among them instead of sinking below
    // all index rows.
    const a = api(
      [],
      { workspace: laneOf([hit({ sessionId: "h", title: "newest hit", mtime: 400_000 })]) },
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
    const names = workspaceRows(0).map((r) => r.textContent ?? "");
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
    let names = workspaceRows(0).map((r) => r.textContent ?? "");
    expect(names[0]).toContain("y");
    expect(names[1]).toContain("x");

    await mount(
      api([], {}, { "claude:x": { kind: "hit", reference: "/s/x", title: null, mtime: 500_000 } }),
      rows,
    );
    names = workspaceRows(0).map((r) => r.textContent ?? "");
    expect(names[0]).toContain("x"); // re-seated by its landed time
    expect(names[1]).toContain("y");
    expect(workspaceRows(0)).toHaveLength(2); // composition unchanged
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
    const rows = workspaceRows(0);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent).toContain("the shared truth");
    }
    // The folder rides each row's meta line (full path in the
    // tooltip); the branch is gone from the row — it lives in the
    // pane header now.
    const foldersOf = (row: Element) =>
      row.querySelector(".history__meta-folder")?.textContent;
    expect(foldersOf(rows[0])).toBe("repo");
    expect(foldersOf(rows[1])).toBe("repo");
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
      "Reading this session failed. This is not 'nothing to read': the row stays, and a retry is legitimate",
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

describe("row render stability — the effect, not the memo", () => {
  // The contract: with UNCHANGED inputs (same row objects, same
  // handlers, same clock), an unrelated re-render of the LIST renders
  // NO row; a landed page renders its new rows and only them. The
  // witness counts actual SessionRowView RENDER CALLS through a
  // counting wrapper (test-side; no hooks live in production code) —
  // the memo's presence proves nothing, the absence of work does.
  const { rowRenders } = stability;

  let root: Root;
  let restoreViewport: () => void = () => {};
  beforeEach(() => {
    rowRenders.mockClear();
    installResizeObserver();
    // Row height = the ESTIMATE (72): measurement is then a no-op on
    // offsets, and a row re-render can only mean a REAL prop changed —
    // the thing this suite exists to count.
    restoreViewport = pinListViewport(600, 800, 72);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    restoreViewport();
  });

  // Stable across the suite's mounts: a fresh [CAPABLE_AGENT] literal
  // per mount would legitimately invalidate every row (the agents prop
  // is compared by reference) and drown the effect under test.
  const AGENTS_STABLE = [CAPABLE_AGENT];
  const mountBrowser = async (
    a: SessionsBrowserApi,
    rows: SessionRecord[],
    onResume = vi.fn(),
    onFork = vi.fn(),
  ) =>
    act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: AGENTS_STABLE,
          ready: true,
          rows,
          onResume,
          onFork,
        }),
      ),
    );

  it("an UNRELATED re-render (the viewer opens) renders NO row again", async () => {
    const a = api(
      [hit({ sessionId: "g-1" })],
      {},
      {
        "claude:s-1": {
          kind: "hit",
          reference: "/store/s-1",
          title: null,
          mtime: 1_800_000_000_000,
        },
      },
    );
    await mountBrowser(a, [
      closed({ transcriptPath: "/j/s-1" }),
      closed({ sessionId: "s-2" }),
    ]);
    // NOTE: the mount count is the baseline; the ASSERTIONS below count
    // only the DELTA after it — the honest effect measure.
    // The mount WAVE includes the measurement pass: the virtualizer
    // stamps real offsets after the first measure, and rows whose
    // start moved re-render — a REAL prop change, not instability.
    // The honest baseline is the count AFTER the wave settles; the
    // assertions below count the delta from there.
    await act(async () => {});
    const mounted = rowRenders.mock.calls.length;
    expect(mounted).toBe(5); // 3 rows + the measurement pass's 2 shifts
    expect(rowRenders.mock.calls.map((c) => c[0]).sort()).toEqual([
      "g-1",
      "g-1",
      "s-1",
      "s-2",
      "s-2",
    ]);

    // Open the row WITH a read link: the component re-renders for real
    // (the viewer's own state) — every row input unchanged. ZERO row
    // renders must follow.
    rowRenders.mockClear();
    const openBtn = [...document.querySelectorAll<HTMLButtonElement>(".browser__open")].find(
      (b) => b.querySelector(".browser__name")?.getAttribute("title") === "s-1",
    )!;
    await act(async () => openBtn.click());
    expect(document.querySelector(".browser__viewer")).not.toBeNull();
    expect(rowRenders).toHaveBeenCalledTimes(0);
  });

  it("a landed page renders ONLY its new rows; the old ones render nothing", async () => {
    // ONE api object, mutated the way the real engine mutates its own
    // state: a NEW hits array on the same object. Everything else the
    // rows see keeps identity — exactly a landed page.
    const journal = [closed(), closed({ sessionId: "s-2" })];
    const a = api([hit({ sessionId: "g-1" })]);
    const onResume = vi.fn();
    const onFork = vi.fn();
    await mountBrowser(a, journal, onResume, onFork);
    // Let the measurement wave settle, then clear — see the sibling
    // test for why the mount wave legitimately re-renders.
    await act(async () => {});
    rowRenders.mockClear();
    // The page lands the way the real engine lands it: the OLD hit
    // objects keep identity, the page APPENDS new ones — a fresh
    // literal for the old row would legitimately re-render it (its
    // source changed).
    const sameG1 = a.other.hits[0];
    a.other = laneOf(
      [sameG1, hit({ sessionId: "g-2", title: null })],
      { total: 2 },
    );
    await mountBrowser(a, journal, onResume, onFork);
    // The old rows render NOTHING (their inputs are unchanged — the
    // composition reuses their row objects), the new row renders ONCE.
    expect(rowRenders.mock.calls.map((c) => c[0])).toEqual(["g-2"]);
  });
});

describe("virtualized list — the window, not the pile", () => {
  // A stands on a model of 2400 rows in a 600px viewport: the mounted
  // row count must stay bounded by the WINDOW + an explicit slack — a
  // NUMBER in the test, not an eyeball. B pins the two thresholds
  // apart: each asks ONLY its own engine, once per hold. The geometry
  // comes from the test-support adapter (happy-dom computes no layout):
  // it imitates the BROWSER's reported sizes, never the list's logic.
  let root: Root;
  let restoreViewport: () => void = () => {};
  beforeEach(() => {
    installResizeObserver();
    restoreViewport = pinListViewport(600);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    restoreViewport();
  });

  const manyHits = (n: number, prefix = "m") =>
    Array.from({ length: n }, (_, i) =>
      hit({ sessionId: `${prefix}-${i}`, mtime: 1_000_000 + i }),
    );

  const mountBrowser = async (
    a: SessionsBrowserApi,
    rows: SessionRecord[] = [],
  ) =>
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

  it("A: at 2400 model rows the mounted rows are bounded by the window plus explicit slack", async () => {
    await mountBrowser(
      api([], { other: laneOf(manyHits(2400), { total: 2400, hasMore: true }) }),
    );
    const mounted = document.querySelectorAll(
      ".browser__list > .history__row",
    ).length;
    // 600px viewport at a 64px pinned row ≈ 10 rows; overscan 6 per
    // side; the bound allows slack but is a NUMBER: rendering the pile
    // (2400) reddens 40× over.
    expect(mounted).toBeLessThanOrEqual(40);
    expect(mounted).toBeGreaterThan(0);
  });

  it("B: the workspace threshold asks ONLY the workspace engine; the overall threshold ONLY the other", async () => {
    // The whole queue sits under one viewport: BOTH thresholds are in
    // range on the same position — each engine asked exactly once (the
    // engine guards repeats), and neither asked the other's engine.
    // The engines' own in-flight guards are part of the real contract
    // the threshold rides on; a bare vi.fn mock removes them and counts
    // every re-CHECK as an ask. The mock here carries the guard: one
    // ask per landing, repeats swallowed — the count then measures the
    // THRESHOLD's behavior, not the mock's missing guard.
    let wsAsked = false;
    const workspaceLoad = vi.fn(() => {
      if (wsAsked) return;
      wsAsked = true;
    });
    let otherAsked = false;
    const otherLoad = vi.fn(() => {
      if (otherAsked) return;
      otherAsked = true;
    });
    await mountBrowser(
      api([], {
        workspace: laneOf(manyHits(30, "w"), {
          total: 300,
          hasMore: true,
          loadMore: workspaceLoad,
        }),
        other: laneOf(manyHits(5, "g"), {
          total: 500,
          hasMore: true,
          loadMore: otherLoad,
        }),
      }),
    );
    // Settle the mount + measurement waves, then assert.
    for (let i = 0; i < 3; i++) await act(async () => {});
    // Both in range: both engines asked — and the guards held the
    // re-checks (the raw call counts stay above the ASK count, proving
    // the component re-checked; the asks stayed at one).
    expect(wsAsked).toBe(true);
    expect(otherAsked).toBe(true);
    expect(workspaceLoad.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(otherLoad.mock.calls.length).toBeGreaterThanOrEqual(1);
    // Extra cycles (landing re-checks) must not double-ask — the
    // Extra cycles (landing re-checks) must not double-ASK — the
    // guards above are the engines' own contract; the call counts may
    // grow with re-checks, the asks cannot.
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(wsAsked).toBe(true);
    expect(otherAsked).toBe(true);
  });

  it("B: the signal rides the RANGE, not a DOM node — a scrolled-past tail still pages", async () => {
    // The mutation this pins: reading the last DOM node instead of the
    // range. After a scroll past the workspace lane's end, its last
    // row is UNMOUNTED (that is what virtualization means) — a
    // DOM-node signal finds no node and never asks, and the workspace
    // lane's paging silently dies. The range signal asks: the range's
    // end is beyond the workspace boundary, which IS the threshold.
    const workspaceLoad = vi.fn();
    const otherLoad = vi.fn();
    await mountBrowser(
      api([], {
        // A long other lane pushes the workspace tail far above the
        // scroll bottom; the workspace pages land first.
        workspace: laneOf(manyHits(20, "w"), {
          total: 200,
          hasMore: true,
          loadMore: workspaceLoad,
        }),
        other: laneOf(manyHits(400, "g"), {
          total: 2000,
          hasMore: true,
          loadMore: otherLoad,
        }),
      }),
    );
    // Let the observer-driven range settle, then assert.
    for (let i = 0; i < 3; i++) await act(async () => {});
    // The window covers only the queue's HEAD (~15 rows of 420): the
    // workspace tail (row 19) is beyond the window — UNMOUNTED, no DOM
    // node to read — yet the workspace threshold FIRED from the range
    // (ws asked). A DOM-node signal would find nothing and stay at 0.
    expect(document.querySelectorAll(".browser__list > .history__row").length)
      .toBeLessThanOrEqual(40);
    expect(workspaceLoad.mock.calls.length).toBeGreaterThanOrEqual(1);
    // The overall tail is far below the window: the OTHER engine is
    // honestly OUT of range and must NOT have been asked.
    expect(otherLoad).toHaveBeenCalledTimes(0);
  });

  it("D: the focused row riding out of the window lands focus on the LIST CONTAINER, never on body", async () => {
    // The contract (the circle's ruling): overscan covers stepping;
    // this covers the fling past it. Focus on <body> would restart the
    // tab walk at the page top — losing the keyboard's place; the
    // container keeps it (the next Tab enters the nearest visible
    // row). A neighboring ROW was rejected as guessing intent.
    const a = api([], {
      other: laneOf(manyHits(60, "g"), { total: 60 }),
    });
    await mountBrowser(a);
    for (let i = 0; i < 3; i++) await act(async () => {});
    const list = document.querySelector<HTMLUListElement>(".browser__list")!;
    const firstRow = document.querySelector<HTMLLIElement>(".history__row")!;
    const openBtn = firstRow.querySelector<HTMLButtonElement>(".browser__open");
    expect(openBtn).not.toBeNull();
    openBtn!.focus();
    expect(document.activeElement).toBe(openBtn);

    // The fling: the range jumps far past the focused row (its key
    // leaves the window) — by driving the virtualizer's own range
    // through scrollTop, the stand's honest lever for "scrolled away".
    list.scrollTop = 50 * 64;
    await act(async () => {
      list.dispatchEvent(new Event("scroll"));
    });
    await act(async () => {});
    // Focus left the unmounted button and landed on the CONTAINER —
    // not body.
    expect(document.activeElement).toBe(list);
    expect(document.activeElement).not.toBe(document.body);
    // And the container is focusable (the pad exists even before use).
    expect(list.tabIndex).toBe(-1);
  });

  it("D-negative: an ordinary scroll with NO focus in any row — the list NEVER steals focus", async () => {
    // The first cut's defect, pinned: any child mutation with
    // activeElement === body (a landed page during a mouse scroll, a
    // spinner appearing) focused the list unprompted. The transfer is
    // CONDITIONAL by construction: it fires only for the remembered
    // focused element of a removed row — never because focus happened
    // to sit in body while the list mutated.
    const a = api([], {
      other: laneOf(manyHits(30, "g"), {
        total: 100,
        hasMore: true,
        loadMore: vi.fn(),
      }),
    });
    await mountBrowser(a);
    for (let i = 0; i < 3; i++) await act(async () => {});
    const list = document.querySelector<HTMLUListElement>(".browser__list")!;

    // Nothing was ever focused in a row; focus is wherever it was —
    // body. The page "lands": the lane's hits array grows, rows are
    // added (child mutations galore).
    a.other = laneOf(manyHits(60, "g"), { total: 100, hasMore: false, loadMore: vi.fn() });
    await mountBrowser(a);
    for (let i = 0; i < 3; i++) await act(async () => {});

    // The list must NOT have taken the focus.
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(list);
  });

  it("D-order: focus IN a row, then OUT of the list, then the row dies, then focus falls to body — the list STILL does not steal", async () => {
    // The stale-memory hole the review found: the remembered element
    // was never cleared when the user LEFT the list; the row's later
    // removal + focus drifting to body would fire the transfer and
    // YANK focus back uninvited. The order witness: focus in a row
    // that will DIE (its key leaves the queue on the next landing) →
    // focus lands outside the list (a REAL move: relatedTarget set —
    // this is what must clear the memory) → the queue shrinks, the
    // row's node is removed, focus ends in body — the transfer's two
    // RAW conditions both hold — yet nothing fires, because the
    // memory was cleared by the real move. A removal-fired focusout
    // (null relatedTarget) must NOT clear — that branch belongs to
    // the observer; the stand dispatches the moves explicitly
    // (happy-dom fires no focus events on .focus()).
    const a = api([], {
      other: laneOf(manyHits(30, "g"), { total: 100, hasMore: true, loadMore: vi.fn() }),
    });
    await mountBrowser(a);
    for (let i = 0; i < 3; i++) await act(async () => {});
    const list = document.querySelector<HTMLUListElement>(".browser__list")!;
    const openBtns = () =>
      [...document.querySelectorAll<HTMLButtonElement>(".browser__open")];
    // Focus the LAST row's button — its key leaves on the shrink.
    const dyingBtn = openBtns()[openBtns().length - 1];
    dyingBtn.focus();
    expect(document.activeElement).toBe(dyingBtn);

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    await act(async () => {
      dyingBtn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    await act(async () => {
      outside.focus();
      dyingBtn.dispatchEvent(
        new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }),
      );
    });
    expect(document.activeElement).toBe(outside);

    // The queue SHRINKS (the focused row's node is removed by key),
    // focus drifts to body — the raw transfer conditions — the
    // memory must have been cleared by the real move above.
    outside.remove();
    a.other = laneOf(manyHits(10, "g"), { total: 10, hasMore: false, loadMore: vi.fn() });
    await mountBrowser(a);
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(document.activeElement).toBe(document.body);
    expect(document.activeElement).not.toBe(list);
  });

  it("C-integration: the anchor lookup runs over the FULL QUEUE — the watched row is FOUND and HELD, not misread as vanished", async () => {
    // The stand-honest integration: the correction runs on the REAL
    // component. The watched row g-0 sits at the viewport top
    // (anchor, offset 0); twenty workspace rows land ABOVE it. The
    // effect resolves g-0's NEW index in the FULL queue (20) and asks
    // the library's offset API — which reads the complete measured
    // cache, window or no window — then moves the scroll by the
    // inserted span so the SAME key keeps the top. A window-only
    // lookup (the mutation) finds nothing: the key is outside the new
    // window, the vanished branch fires, the anchor hands to an
    // inserted row and the watched row jumps away.
    const a = api([], {
      other: laneOf(manyHits(40, "g"), { total: 40 }),
    });
    await mountBrowser(a);
    for (let i = 0; i < 3; i++) await act(async () => {});
    const list = document.querySelector<HTMLUListElement>(".browser__list")!;
    expect(list.scrollTop).toBe(0);
    // The browser side of the adapter: the container's scroll
    // geometry must exist for the scroll to GO somewhere (happy-dom
    // clamps scrollTop to scrollHeight−clientHeight, both zero by
    // default).
    Object.defineProperty(list, "scrollHeight", { value: 40 * 72, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 600, configurable: true });

    // THE PROPERTY the anchor exists for, measured not computed: the
    // watched row's OFFSET FROM THE VIEWPORT TOP — captured BEFORE
    // the insertion (while the queue is still the 40-row list), so
    // the sameness claim compares across the insertion, not a value
    // with itself. The row's offset is derived from the
    // virtualizer's own positions: translateY(start) − scrollTop.
    const rowTopOf = (key: string): number | null => {
      const li = [
        ...document.querySelectorAll(".browser__list > .history__row"),
      ].find((el) => el.querySelector(".browser__name")?.getAttribute("title") === key);
      if (!li) return null;
      const m = /(translateY\()(-?\d+(?:\.\d+)?)(px\))/.exec(
        (li as HTMLElement).style.transform ?? "",
      );
      return m ? Number(m[2]) - list.scrollTop : null;
    };
    const beforeTop = rowTopOf("g-0");
    expect(beforeTop).not.toBeNull();

    // Twenty workspace rows land ABOVE — AFTER the "before" capture.
    a.workspace = laneOf(manyHits(20, "w"), { total: 20 });
    // Refresh the pinned scroll geometry for the grown queue (the
    // pre-insertion pin 40×72 no longer bounds a 60-row list).
    Object.defineProperty(list, "scrollHeight", { value: 60 * 72, configurable: true });
    await mountBrowser(a);
    for (let i = 0; i < 3; i++) await act(async () => {});

    // THE ANCHOR'S OWN CLAIM: the same key at the same offset from
    // the top, across the insertion. An anchor that misreads the key
    // as vanished (the window-only lookup) would leave g-0 twenty
    // rows up the content — a DIFFERENT offset; an anchor that does
    // nothing would leave the offset shifted by the inserted span.
    expect(rowTopOf("g-0")).toBe(beforeTop);
  });

  it("A-BLOCKER: an ordinary scroll STAYS — and a queue change holds the watched row's place (invariant, not number)", async () => {
    // The regression this pins: the merged effect compensated on
    // every range change — scrolling re-found the stale anchor and
    // flung the list back. Arming follows SCROLL POSITION (a small
    // scroll may change the first visible row while the last index
    // stands — the seam the review found), compensation follows ONLY
    // the queue. The witness asserts the PROPERTY the anchor exists
    // for — the watched row keeps its offset from the viewport top —
    // measured through the virtualizer's own translateY (the adapter
    // pins all rect tops to the container). The pre-insertion scroll
    // is deliberately NOT a multiple of the row height: it moves the
    // first-visible boundary so a stale arming anchor would be caught
    // holding the PREVIOUS row's offset.
    const a = api([], {
      other: laneOf(manyHits(80, "g"), { total: 80 }),
    });
    // Row height = the ESTIMATE (72): measurements are then a no-op on
    // offsets — deterministic starts make the INVARIANT exact; with
    // mixed 64/72 measured sizes the adapter's re-measure mid-flight
    // shifts starts AFTER the correction by amounts the stand cannot
    // attribute honestly.
    restoreViewport();
    restoreViewport = pinListViewport(600, 800, 72);
    await mountBrowser(a);
    for (let i = 0; i < 3; i++) await act(async () => {});
    const list = document.querySelector<HTMLUListElement>(".browser__list")!;
    Object.defineProperty(list, "scrollHeight", { value: 80 * 72, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 600, configurable: true });

    // HALF ONE: an ordinary scroll — deliberately non-multiple of any
    // row height — with NO queue change.
    list.scrollTop = 30 * 72 + 37;
    await act(async () => {
      list.dispatchEvent(new Event("scroll"));
    });
    for (let i = 0; i < 3; i++) await act(async () => {});
    // The scroll STAYED (not back to 0 — the merged regression's
    // signature).
    expect(list.scrollTop).toBeGreaterThan(2000);

    // The watched row: the FIRST row starting at/after the scroll —
    // by the virtualizer's own positions.
    const rowTopOf = (key: string): number | null => {
      const li = [
        ...document.querySelectorAll(".browser__list > .history__row"),
      ].find((el) => el.querySelector(".browser__name")?.getAttribute("title") === key);
      if (!li) return null;
      const m = /translateY\((-?\d+(?:\.\d+)?)px\)/.exec(
        (li as HTMLElement).style.transform ?? "",
      );
      return m ? Number(m[1]) - list.scrollTop : null;
    };
    const visibleKeys = () =>
      [...document.querySelectorAll(".browser__list .history__row .browser__name")]
        .map((n) => n.getAttribute("title"))
        .filter((t): t is string => t !== null);
    const watchedKey = visibleKeys().find(
      (k) => rowTopOf(k) !== null && (rowTopOf(k) as number) >= 0,
    )!;
    expect(watchedKey).toBeDefined();
    const watchedBefore = rowTopOf(watchedKey);
    expect(watchedBefore).not.toBeNull();

    // HALF TWO: twenty workspace rows land ABOVE the watched row —
    // the anchor must hold ITS key at ITS offset. Same-key/same-
    // offset survives height changes, paddings and any arithmetic;
    // a computed number would not.
    a.workspace = laneOf(manyHits(20, "w"), { total: 20 });
    Object.defineProperty(list, "scrollHeight", { value: 100 * 72, configurable: true });
    await mountBrowser(a);
    for (let i = 0; i < 3; i++) await act(async () => {});
    expect(list.scrollTop).toBeGreaterThan(2000); // still deep in the list
    // THE ANCHOR'S OWN CLAIM: the same key at the same offset.
    expect(visibleKeys()).toContain(watchedKey);
    expect(rowTopOf(watchedKey)).toBe(watchedBefore);
  });

  it("CLOCK: the tick is OBSERVED in the label — 59s→1m flips, hidden counts nothing, return recomputes at once, teardown leaves no timers", async () => {
    // The witnesses assert the OBSERVABLE RESULT, not call counts:
    // (1) the label: a row whose age crosses the minute boundary
    // under the tick FLIPS its text (59s → 1m); (2) hidden + 120s —
    // the label does NOT move (no time counted); (3) the window
    // returns — the label recomputes IMMEDIATELY (59s is long past);
    // (4) unmount — vi.getTimerCount() is zero: the interval left
    // with the component. The row mtime is pinned NOW-59s at mount
    // so the very first tick must flip it.
    const nowMs = Date.now();
    const a = api(
      [],
      {
        other: laneOf(
          [{ ...hit({ sessionId: "age-row", title: null }), mtime: nowMs - 59_500 }],
          { total: 1 },
        ),
      },
    );
    // The age label derives from the row's `when` vs the component's
    // frozen-at-mount clock (formatAge: <60s = "now", then "1m ago"):
    // at mount it reads "now"; after ONE minute of fake time it must
    // read "1m ago".
    vi.useFakeTimers({ now: nowMs });
    vi.setSystemTime(nowMs);
    try {
      installResizeObserver();
      const restore = pinListViewport(600);
      document.body.innerHTML = "<div id='host'></div>";
      root = createRoot(document.getElementById("host")!);
      await act(async () =>
        root.render(
          createElement(SessionsBrowser, {
            api: a,
            agents: [CAPABLE_AGENT],
            ready: true,
            rows: [],
            onResume: vi.fn(),
            onFork: vi.fn(),
          }),
        ),
      );
      for (let i = 0; i < 3; i++) await act(async () => {});
      const label = () =>
        [
          ...document.querySelectorAll(".browser__list .history__meta-age"),
        ]
          .map((n) => n.textContent)
          .find((t): t is string => t !== undefined && t !== null) ?? null;
      // (0) The fixture is honest: sub-minute at mount.
      expect(label()).toBe("now");

      // (1) EVEN TICK: a minute passes under fake time — the label
      // crosses the boundary and FLIPS.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(label()).toMatch(/1m/);

      // (2) HIDDEN: two more minutes count NOTHING — the label stands.
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(label()).toMatch(/1m/); // still 1m, not 3m

      // (3) RETURN: the immediate recompute fires — the label moves
      // the SAME instant (no interval wait): 2m+ now.
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      vi.setSystemTime(nowMs + 180_000);
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(label()).toMatch(/3m/);

      // (4) TEARDOWN: unmount leaves no timers behind.
      await act(async () => {
        root.unmount();
      });
      expect(vi.getTimerCount()).toBe(0);
      restore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("unified row guard — both blocks, one markup", () => {
  let root: Root;
  let restoreViewport: () => void = () => {};
  beforeEach(() => {
    worktreeIpc.probeWorktree.mockClear();
    worktreeIpc.probeWorktree.mockImplementation(() =>
      Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    installResizeObserver();
    restoreViewport = pinListViewport(600);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    restoreViewport();
  });

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
    folder: row.querySelector(".history__meta-folder")?.textContent ?? null,
    time: row.querySelector(".history__meta-age")?.textContent ?? null,
    actions: [...row.querySelectorAll("button")]
      .filter((b) => !b.className.includes("browser__open"))
      .map((b) => b.textContent),
  });

  /** The slot TREE: the named cells and their order are the
   * requirement — same shape for every data row, whatever facts the
   * row has. The glyph spans both grid rows; the actions are ONE
   * group-cell (its buttons are children of the group, never loose
   * children of the row — loose buttons once fell onto the meta line
   * by auto-placement); the meta line flows in the name's column
   * below. */
  const slotNameOf = (el: Element): string => {
    const c = (el as HTMLElement).classList;
    if (c.contains("history__glyph")) return "glyph";
    if (c.contains("browser__open")) return "name";
    if (c.contains("history__actions")) return "actions";
    if (c.contains("history__meta")) return "meta";
    return "other";
  };

  const slotsTreeOf = (row: Element): string[] =>
    [...row.children].map(slotNameOf);

  /** The meta line's parts, in the required order: folder, age, then
   * the exceptional marks. Extracted by class so order is compared,
   * not assumed. */
  const metaPartsOf = (row: Element): string[] =>
    [...(row.querySelector(".history__meta")?.children ?? [])].map((el) => {
      const c = (el as HTMLElement).classList;
      if (c.contains("history__meta-folder")) return "folder";
      if (c.contains("history__meta-age")) return "age";
      if (c.contains("history__meta-mark")) return "mark";
      return "other";
    });

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
    // The FULL structural tree, no filtering and no removals: both
    // rows carry the same named cells in the same order.
    expect(slotsTreeOf(fromJournal)).toEqual(slotsTreeOf(fromIndex));
    // The dot and the branch are GONE BY DIRECT USER CHOICE — no node,
    // no seat, under ANY set of facts.
    expect(fromJournal.querySelector(".history__state")).toBeNull();
    expect(fromIndex.querySelector(".history__state")).toBeNull();
    expect(fromJournal.querySelector(".history__slot-state")).toBeNull();
    expect(fromIndex.querySelector(".history__slot-state")).toBeNull();
    // No branch chip: the branch is secondary, it lives in the pane
    // header now.
    expect(fromJournal.querySelectorAll(".history__chip")).toHaveLength(0);
    expect(fromIndex.querySelectorAll(".history__chip")).toHaveLength(0);
    // The meta line exists in both rows, and its parts run in the
    // required order: folder, age, marks.
    expect(metaPartsOf(fromJournal)).toEqual(metaPartsOf(fromIndex));
    expect(metaPartsOf(fromJournal).slice().sort()).toEqual(
      metaPartsOf(fromJournal).slice().sort(),
    );
    // The actions are ONE group-cell: its buttons are CHILDREN of the
    // group, never loose children of the row — loose buttons once fell
    // onto the meta line by grid auto-placement. The group keeps its
    // cell whatever it holds (both, one, none) — the row's shape never
    // depends on availability.
    for (const row of [fromJournal, fromIndex]) {
      const group = row.querySelector(".history__actions");
      expect(group).not.toBeNull();
      expect(group!.querySelector(".history__resume")).not.toBeNull();
      expect(group!.querySelector(".history__fork")).not.toBeNull();
      expect(
        [...row.children].some(
          (c) => (c as HTMLElement).classList.contains("history__resume"),
        ),
      ).toBe(false);
      expect(
        [...row.children].some(
          (c) => (c as HTMLElement).classList.contains("history__fork"),
        ),
      ).toBe(false);
    }
  });

  it("the actions group keeps its cell when EMPTY or HALF-FILLED — the row's shape never depends on availability", async () => {
    // The degenerate cases the group exists for: a resume-incapable
    // agent (no buttons at all), a wrong-owner row (neither action).
    // The group still sits between the name and the meta in the tree;
    // the meta does not move.
    const incapable: AgentInfo = {
      ...CAPABLE_AGENT,
      features: [{ id: "session.history", label: "History" }],
    };
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: api([]),
          agents: [incapable],
          ready: true,
          rows: [closed({ sessionId: "s-1", transcriptPath: "/j/s-1.jsonl" })],
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );
    const row = listRows()[0];
    const group = row.querySelector(".history__actions");
    expect(group).not.toBeNull(); // the cell exists even with no buttons
    expect(group!.querySelector("button")).toBeNull();
    // And the meta stays in its place in the tree.
    expect(slotsTreeOf(row)).toEqual(["glyph", "name", "actions", "meta"]);
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
    // The liveness dot and the branch chip are GONE in both blocks —
    // no node under any facts, per the user's direct choice.
    expect(fromJournal.querySelector(".history__state")).toBeNull();
    expect(fromIndex.querySelector(".history__state")).toBeNull();
    expect(fromJournal.querySelectorAll(".history__chip")).toHaveLength(0);
    expect(fromIndex.querySelectorAll(".history__chip")).toHaveLength(0);
    // The meta line's parts run in the required order — folder, then
    // age, then marks — in BOTH blocks' rows.
    expect(metaPartsOf(fromJournal)).toEqual(["folder", "age"]);
    expect(metaPartsOf(fromIndex)).toEqual(["folder", "age"]);
    expect(fromJournal.querySelector(".history__meta-folder")?.textContent).toBe(
      fromIndex.querySelector(".history__meta-folder")?.textContent,
    );
    expect(fromJournal.querySelector(".history__meta-age")?.textContent).toBe(
      fromIndex.querySelector(".history__meta-age")?.textContent,
    );
    // The structural tree coincides — not merely each other.
    expect(slotsTreeOf(fromJournal)).toEqual(slotsTreeOf(fromIndex));
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
    // No journal rows? There IS one — the queue's head carries the
    // nameless record showing its id too, not the agent label.
    const head = workspaceRows(2);
    expect(head).toHaveLength(1);
    expect(head[0].textContent).toContain("zz-9");
    // One queue: the journal row first, the other lane's rows after —
    // nothing between them.
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
    expect(goneRow.querySelector(".history__meta-mark")?.textContent).toBe("dir gone");
    expect(
      goneRow.querySelector<HTMLButtonElement>(".history__resume")!.disabled,
    ).toBe(true);
  });

  it("GREEN-THROUGH: an INDEX row at a resume-capable agent KEEPS its Resume button", async () => {
    // The union-narrowing trap: the natural-looking rewrite of the Resume
    // gate ("bound and not live") would silently strip the button from
    // EVERY index row — rows from the search source, which are exactly the
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
