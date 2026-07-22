// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { SearchHit } from "../../ipc/history";
import type { SessionRecord } from "../../domain/journal";
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

const api = (
  hits: SearchHit[],
  over: Partial<SessionsBrowserApi> = {},
): SessionsBrowserApi => ({
  hits,
  total: hits.length,
  hasMore: false,
  loadingMore: false,
  query: "",
  scanning: false,
  search: vi.fn(),
  loadMore: vi.fn(),
  scan: vi.fn(),
  transcript: vi.fn(() =>
    Promise.resolve([{ role: "user" as const, text: "hello" }]),
  ),
  ...over,
});

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
    callbacks: { onDelete?: unknown; onResume?: unknown; onFork?: unknown } = {},
  ) =>
    act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [],
          ready: true,
          rows,
          onDelete: (callbacks.onDelete as (id: string) => void) ?? vi.fn(),
          onResume: (callbacks.onResume as (r: never) => void) ?? vi.fn(),
          onFork: (callbacks.onFork as (r: never) => void) ?? vi.fn(),
        }),
      ),
    );

  it("scans on mount, searches as you type, and hands resume/fork the record", async () => {
    const a = api([hit()]);
    const onResume = vi.fn();
    const onFork = vi.fn();
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [],
          ready: true,
          rows: [],
          onDelete: vi.fn(),
          onResume,
          onFork,
        }),
      ),
    );
    expect(a.scan).toHaveBeenCalledTimes(1);

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

  it("waits for plugin activation before scanning — an empty registry must not count as scanned", async () => {
    const a = api([]);
    const props = {
      api: a,
      agents: [],
      rows: [],
      onDelete: vi.fn(),
      onResume: vi.fn(),
      onFork: vi.fn(),
    };
    await act(async () =>
      root.render(createElement(SessionsBrowser, { ...props, ready: false })),
    );
    expect(a.scan).not.toHaveBeenCalled();

    await act(async () =>
      root.render(createElement(SessionsBrowser, { ...props, ready: true })),
    );
    expect(a.scan).toHaveBeenCalledTimes(1);
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
          agents: [],
          ready: true,
          rows: [],
          onDelete: vi.fn(),
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

  it("shows the paging counter: partial as 'X of N', complete as the plain total", async () => {
    await mount(api([hit()], { total: 123, hasMore: true }));
    expect(document.querySelector(".browser__count")?.textContent).toBe("1 of 123");

    await mount(api([hit()], { total: 1 }));
    expect(document.querySelector(".browser__count")?.textContent).toBe("1");
  });

  it("pulls the next page while the list is shorter than its viewport — scroll alone can't fire there", async () => {
    const a = api([hit()], { total: 123, hasMore: true });
    await mount(a);
    // happy-dom's zero-height layout IS the unfilled-viewport case.
    expect(a.loadMore).toHaveBeenCalled();
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
    const a = api([hit()], { total: 123, hasMore: true, loadingMore: true });
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
    onDelete = vi.fn(),
    onResume = vi.fn(),
    onFork = vi.fn(),
  ) => {
    const result = act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [],
          ready: true,
          rows,
          onDelete,
          onResume,
          onFork,
        }),
      ),
    );
    return { ...result, onDelete, onResume, onFork };
  };

  it("journal rows pin first, before the hits, with branch chip and state dot", async () => {
    await mount(
      api([hit({ sessionId: "u-9", title: "other session" })]),
      [closed({ title: "auth bug", branch: "kd/ws/1" }), live()],
    );
    const rows = document.querySelectorAll(".history__row");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("auth bug");
    expect(rows[0].querySelector(".history__chip")?.textContent).toBe("kd/ws/1");
    expect(rows[0].querySelector(".history__state--live")).toBeNull();
    expect(rows[1].querySelector(".history__state--live")).not.toBeNull();
    expect(rows[2].textContent).toContain("other session");
    // The divider sits between the pinned rows and the hits.
    const divider = document.querySelector(".browser__section");
    expect(divider?.textContent).toBe("All sessions");
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
    expect(document.querySelectorAll(".browser__open")).toHaveLength(1);
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
    const journal = document.querySelectorAll(".browser__journal");
    expect(journal).toHaveLength(1);
    expect(journal[0].textContent).toContain("auth bug");
    const opens = document.querySelectorAll(".browser__open");
    expect(opens).toHaveLength(1);
    expect(opens[0].textContent).toContain("s-2");
  });

  it("the × forgets exactly that journal session", async () => {
    const onDelete = vi.fn();
    await mount(api([]), [closed(), closed({ sessionId: "s-2" })], onDelete);
    const buttons = document.querySelectorAll<HTMLButtonElement>(".history__delete");
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());
    expect(onDelete).toHaveBeenCalledExactlyOnceWith("s-2");
  });

  it("a live journal row offers no Resume; a gone dir blocks it — Fork stays", async () => {
    worktreeIpc.probeWorktree.mockImplementation((path: string) =>
      Promise.resolve({ exists: path !== "/gone", isWorktree: false, branch: null }),
    );
    const onResume = vi.fn();
    await mount(
      api([]),
      [closed({ title: "auth bug" }), live(), closed({ sessionId: "s-3", cwd: "/gone" })],
      vi.fn(),
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

  it("journal rows don't open the transcript viewer — they have no store reference", async () => {
    const a = api([]);
    await mount(a, [closed({ title: "auth bug" })]);
    await act(async () =>
      document.querySelector<HTMLLIElement>(".browser__journal")!.click(),
    );
    expect(a.transcript).not.toHaveBeenCalled();
    expect(document.querySelector(".browser__viewer")).toBeNull();
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
});
