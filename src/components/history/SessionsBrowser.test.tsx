// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { SearchHit } from "../../ipc/history";
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
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  it("scans on mount, searches as you type, and hands resume/fork the record", async () => {
    const a = api([hit()]);
    const onResume = vi.fn();
    const onFork = vi.fn();
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, { api: a, agents: [], ready: true, onResume, onFork }),
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
    const props = { api: a, agents: [], onResume: vi.fn(), onFork: vi.fn() };
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
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [],
          ready: true,
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );
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
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [],
          ready: true,
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );
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
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [],
          ready: true,
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    // First transcript page is a viewport fill (50); later pages come in 20s.
    expect(a.transcript).toHaveBeenCalledWith("claude", "/store/u-1.jsonl", 0, 50);
    expect(document.querySelector(".browser__turn--user")?.textContent).toBe("hello");
  });

  const mount = (a: SessionsBrowserApi) =>
    act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [],
          ready: true,
          onResume: vi.fn(),
          onFork: vi.fn(),
        }),
      ),
    );

  it("the WHOLE row opens the transcript; the action buttons stay their own targets", async () => {
    const a = api([hit()]);
    const onResume = vi.fn();
    await act(async () =>
      root.render(
        createElement(SessionsBrowser, {
          api: a,
          agents: [],
          ready: true,
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
