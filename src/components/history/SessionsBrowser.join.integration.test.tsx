// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import type { IndexLookupAnswer, SearchPage } from "../../ipc/history";
import type { AgentInfo } from "../../domain/agents";
import type { SessionRecord } from "../../domain/journal";
import { claudeHistory } from "../../../plugins/claude/src/history";
import { kimiHistory } from "../../../plugins/kimi/src/history";

// The seams this suite must NOT double: the browser hook chain
// (useSessionsBrowser → useJournalEnrichment → the join in the component),
// the transcript dispatch by agent id, and the two REAL agent plugins.
// Doubles stop at the boundaries the app itself stops at: the ipc invoke
// layer, the runtime context, and the plugins' own fs.
const ipc = vi.hoisted(() => ({
  indexSearch: vi.fn<(...args: unknown[]) => Promise<SearchPage>>(),
  indexLookup: vi.fn<(...args: unknown[]) => Promise<IndexLookupAnswer[]>>(),
}));
vi.mock("../../ipc/history", () => ({
  indexSearch: ipc.indexSearch,
  indexLookup: ipc.indexLookup,
}));
vi.mock("../../ipc/log", () => ({
  describeError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const worktreeIpc = vi.hoisted(() => ({
  probeWorktree: vi.fn((_path: string) =>
    Promise.resolve({ exists: true, isWorktree: false, branch: null }),
  ),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);

/** REAL plugin histories over recording fs doubles — the pair the
 * corrupted records straddle. Every readFile is remembered; that record
 * is what the wrong-owner case stands or falls on. */
function recordingCtx(files: Record<string, string>): {
  ctx: PluginContext;
  reads: string[];
} {
  const reads: string[] = [];
  const ctx = {
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    services: {
      fs: {
        readFile: async (path: string) => {
          reads.push(path);
          return {
            path,
            text: files[path] ?? null,
            isBinary: false,
            size: 0,
            truncated: false,
          };
        },
        readDir: async () => [],
      },
    },
  } as unknown as PluginContext;
  return { ctx, reads };
}

const CLAUDE_USER_TURN = (text: string) =>
  JSON.stringify({
    type: "user",
    cwd: "/repo",
    message: { role: "user", content: text },
  });
const KIMI_USER_TURN = (text: string) =>
  JSON.stringify({
    type: "context.append_message",
    message: { role: "user", content: [{ type: "text", text }] },
  });

const KIMI_WIRE = "/km/wd_1/session_kimi-9/agents/main/wire.jsonl";
const CLAUDE_JOURNAL_ONLY = "/cl/p/-repo/journal-only.jsonl";
const CLAUDE_INDEX_ONLY = "/cl/p/-repo/index-only.jsonl";

const claude = recordingCtx({
  [CLAUDE_JOURNAL_ONLY]: CLAUDE_USER_TURN("read by the real claude plugin, by its journal path"),
  [CLAUDE_INDEX_ONLY]: CLAUDE_USER_TURN("read by the real claude plugin, by the index link"),
});
const kimi = recordingCtx({
  [KIMI_WIRE]: KIMI_USER_TURN("kimi's own conversation"),
});

const sessionIndex = vi.hoisted(() => {
  let snapshot = {
    scanning: false,
    revision: 1,
    invalidated: new Set<string>(),
  };
  const listeners = new Set<() => void>();
  return {
    set(next: { scanning: boolean; revision: number; invalidated?: Set<string> }) {
      snapshot = { ...snapshot, ...next };
      for (const listener of [...listeners]) listener();
    },
    sessionIndex: {
      ensureFresh: vi.fn(),
      snapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
});

vi.mock("../../app/runtimeContext", () => ({
  useAppRuntime: () => ({
    plugins: {
      pluginRegistries: {
        agents: {
          list: () => [
            { entry: { id: "claude", history: claudeHistory(claude.ctx) } },
            { entry: { id: "kimi", history: kimiHistory(kimi.ctx) } },
          ],
        },
      },
    },
    sessionIndex: sessionIndex.sessionIndex,
  }),
}));

import {
  useBrowserSharedSeam,
  useSessionsBrowser,
} from "../../app/useSessionsBrowser";
import { rowKeyOf } from "../../domain/journal/sessionRow";
import { SessionsBrowser } from "./SessionsBrowser";
import { installResizeObserver, pinListViewport } from "./virtualGeometry.test-support";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const AGENTS: AgentInfo[] = [
  {
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
  },
  {
    id: "kimi",
    label: "Kimi Code",
    command: "kimi",
    features: [{ id: "session.history", label: "History" }],
    installed: true,
    path: null,
  },
];

const record = (over: Partial<SessionRecord>): SessionRecord =>
  ({
    agent: "claude",
    sessionId: "s-1",
    cwd: "/repo",
    boundAt: "2026-07-19T10:00:00.000Z",
    state: "closed",
    endedAt: "2026-07-19T11:00:00.000Z",
    ...over,
  }) as SessionRecord;

/** The component the app actually renders: the REAL shared seam (keyed
 * enrichment over the runtime fake, real transcript dispatch through the
 * real plugin registries) plus the per-browser engines — one owner, so a
 * tree change never hands the browser a dead hook's api. */
/** Identity-stable scope for the harness: the scope-change effect keys on
 * the set's identity, so an inline `new Set` per render would read as a
 * scope change on every render (the reset loop this test once wrote). */
const HARNESS_DIRS: ReadonlySet<string> = new Set(["/repo"]);

function Harness({ rows }: { rows: SessionRecord[] }) {
  const shared = useBrowserSharedSeam();
  const browserApi = useSessionsBrowser(HARNESS_DIRS, shared);
  return createElement(SessionsBrowser, {
    api: browserApi,
    agents: AGENTS,
    ready: true,
    rows,
    onResume: vi.fn(),
    onFork: vi.fn(),
  });
}

describe("SessionsBrowser journal join × real plugin pair", () => {
  let root: Root;
  let restoreViewport: () => void = () => {};
  beforeEach(() => {
    ipc.indexSearch.mockReset();
    ipc.indexSearch.mockResolvedValue({ hits: [], total: 0 });
    ipc.indexLookup.mockReset();
    claude.reads.length = 0;
    kimi.reads.length = 0;
    sessionIndex.set({ scanning: false, revision: 1 });
    installResizeObserver();
    restoreViewport = pinListViewport(600);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    restoreViewport();
  });

  const mount = (rows: SessionRecord[]) =>
    act(async () => root.render(createElement(Harness, { rows })));

  /** indexLookup answering by key — the ask's order is not this suite's
   * subject. */
  const answerBy: Record<string, IndexLookupAnswer> = {};
  const answerByKey = async (...raw: unknown[]): Promise<IndexLookupAnswer[]> => {
    const keys = raw[0] as { agent: string; sessionId: string }[];
    return keys.map(
      (k) =>
        answerBy[rowKeyOf(k)] ?? {
          agent: k.agent,
          sessionId: k.sessionId,
          status: "absent",
        },
    );
  };

  it("the corrupted record: the kimi path NEVER reaches either real plugin — no open, no continuation", async () => {
    ipc.indexLookup.mockImplementation(answerByKey);
    // The journal claims claude; the transcript path leads into kimi's
    // store; the index holds the id under kimi.
    answerBy["claude:kimi-9"] = {
      agent: "claude",
      sessionId: "kimi-9",
      status: "foreign",
      agents: ["kimi"],
    };
    await mount([
      record({
        sessionId: "kimi-9",
        title: "the corrupted record",
        transcriptPath: KIMI_WIRE,
      }),
    ]);
    // The enrichment ask fired through the real chain.
    expect(ipc.indexLookup).toHaveBeenCalledExactlyOnceWith([
      { agent: "claude", sessionId: "kimi-9" },
    ]);

    const row = document.querySelector(".history__row")!;
    expect(row.textContent).toContain("the corrupted record");
    expect(row.querySelector(".history__meta-mark")?.textContent).toBe("wrong agent");
    expect(
      row.querySelector<HTMLButtonElement>(".browser__open")!.disabled,
    ).toBe(true);
    expect(row.querySelector(".history__resume")).toBeNull();
    expect(row.querySelector(".history__fork")).toBeNull();

    await act(async () => (row as HTMLLIElement).click());
    expect(document.querySelector(".browser__viewer")).toBeNull();
    // THE assertion this suite exists for: neither real plugin's fs was
    // asked for the kimi path — the union of read links stayed closed.
    expect(claude.reads).toEqual([]);
    expect(kimi.reads).toEqual([]);
  });

  it("a journal-path-only row reads through the REAL claude plugin", async () => {
    ipc.indexLookup.mockImplementation(answerByKey);
    answerBy["claude:s-j"] = {
      agent: "claude",
      sessionId: "s-j",
      status: "absent",
    }; // the index does not know it
    await mount([
      record({ sessionId: "s-j", title: "journal only", transcriptPath: CLAUDE_JOURNAL_ONLY }),
    ]);

    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    expect(claude.reads).toEqual([CLAUDE_JOURNAL_ONLY]); // the journal's path, via the real plugin
    expect(kimi.reads).toEqual([]);
    expect(document.querySelector(".browser__turn--user")?.textContent).toContain(
      "by its journal path",
    );
  });

  it("an index-link-only row reads through the REAL claude plugin too", async () => {
    ipc.indexLookup.mockImplementation(answerByKey);
    answerBy["claude:s-i"] = {
      agent: "claude",
      sessionId: "s-i",
      status: "hit",
      reference: CLAUDE_INDEX_ONLY,
      title: "named by the index",
      mtime: 5,
    };
    await mount([record({ sessionId: "s-i" })]);

    await act(async () =>
      document.querySelector<HTMLButtonElement>(".browser__open")!.click(),
    );
    expect(claude.reads).toEqual([CLAUDE_INDEX_ONLY]); // the index's link, via the real plugin
    expect(document.querySelector(".browser__turn--user")?.textContent).toContain(
      "by the index link",
    );
    // The index's title painted the row.
    expect(document.querySelector(".history__row")?.textContent).toContain(
      "named by the index",
    );
  });
});

// ── E7 characterization: the late-landing transition, made observable ──
// The behavior E7 is about was NEVER observed: the unit named
// "a late enrichment answer RE-SEATS its row" substitutes two static
// tables and never asks or lands anything. This describe runs the REAL
// chain — Harness → useBrowserSharedSeam → useSessionsBrowser →
// SessionsBrowser — with a CONTROLLABLE deferred indexLookup, and
// witnesses the committed DOM order plus the raw seam state on both
// sides of the landing, on ONE mounted tree.
describe("SessionsBrowser late-landing transition (E7 characterization)", () => {
  // indicator/firstPagePending are ‹none›/‹false› THROUGHOUT THIS
  // FIXTURE — the search double answers instantly-empty, so the
  // search-vs-enrichment race is NOT EXERCISED here; these fields
  // assert fixture stillness, not product behavior.
  let root: Root;
  let askLog: Array<Array<{ agent: string; sessionId: string }>> = [];
  let pendingResolvers: Array<(answers: IndexLookupAnswer[]) => void> = [];
  let restoreViewport: () => void = () => {};

  beforeEach(() => {
    ipc.indexSearch.mockReset();
    ipc.indexSearch.mockResolvedValue({ hits: [], total: 0 });
    ipc.indexLookup.mockReset();
    askLog = [];
    pendingResolvers = [];
    ipc.indexLookup.mockImplementation((...raw: unknown[]) => {
      askLog.push(raw[0] as Array<{ agent: string; sessionId: string }>);
      return new Promise<IndexLookupAnswer[]>((res) => {
        pendingResolvers.push(res);
      });
    });
    sessionIndex.set({ scanning: false, revision: 1, invalidated: new Set() });
    installResizeObserver();
    restoreViewport = pinListViewport(600);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => {
    act(() => root.unmount());
    restoreViewport();
  });

  /** The raw-state Probe: renders the seam's OWN numbers next to the
   * browser, reading the SAME api object the browser renders from.
   * The visible-indicator formula mirrors the component's stated
   * priority (search pending wins over ambient indexing). */
  function Probe({ api }: { api: ReturnType<typeof useSessionsBrowser> }) {
    const indicator = api.firstPagePending
      ? "Searching"
      : api.scanning
        ? "Indexing"
        : "none";
    return createElement("div", {
      "data-probe": "seam",
      "data-indicator": indicator,
      "data-scanning": String(api.scanning),
      "data-first-page-pending": String(api.firstPagePending),
      "data-workspace-hits": String(api.workspace.hits.length),
      "data-other-hits": String(api.other.hits.length),
    });
  }

  /** One tree, one render: the browser and the probe over the SAME
   * api. The captured element is reused verbatim for the empty
   * re-render (form 5). */
  function LandingHarness({ rows }: { rows: SessionRecord[] }) {
    const shared = useBrowserSharedSeam();
    const api = useSessionsBrowser(HARNESS_DIRS, shared);
    return createElement(
      "div",
      null,
      createElement(SessionsBrowser, {
        api,
        agents: AGENTS,
        ready: true,
        rows,
        onResume: vi.fn(),
        onFork: vi.fn(),
      }),
      createElement(Probe, { api }),
    );
  }

  /** The committed-DOM snapshot: the two journal rows' order (by the
   * name cell's session-id title) and the probe tuple. */
  const snapshot = () => {
    const order = [...document.querySelectorAll(".history__row")]
      .filter((r) => r.querySelector(".browser__name"))
      .map((r) => r.querySelector(".browser__name")!.getAttribute("title"));
    const p = document.querySelector<HTMLElement>("[data-probe]")!;
    return {
      order,
      indicator: p.dataset.indicator,
      scanning: p.dataset.scanning,
      firstPagePending: p.dataset.firstPagePending,
      workspaceHits: p.dataset.workspaceHits,
      otherHits: p.dataset.otherHits,
    };
  };

  // No ties: y's journal mark 300_000, x's 100_000; the late hit for x
  // carries mtime 500_000 — before landing y leads, after landing x
  // leads, on marks alone, with no equal timestamps anywhere.
  const ROW_X = record({
    sessionId: "x",
    title: "x-row",
    transcriptPath: CLAUDE_JOURNAL_ONLY,
    endedAt: new Date(100_000).toISOString(),
  });
  const ROW_Y = record({
    sessionId: "y",
    title: "y-row",
    transcriptPath: CLAUDE_JOURNAL_ONLY,
    endedAt: new Date(300_000).toISOString(),
  });
  const ROWS = [ROW_X, ROW_Y];
  const hitX = (mtime: number): IndexLookupAnswer => ({
    agent: "claude",
    sessionId: "x",
    status: "hit",
    reference: CLAUDE_INDEX_ONLY,
    title: "x by index",
    mtime,
  });

  it("the landed answer re-seats the row in one mounted list — committed DOM order, before and after the late hit", async () => {
    // This test observes the DOM transition, not visual perception —
    // the frame may never paint.
    await act(async () => root.render(createElement(LandingHarness, { rows: ROWS })));

    // The real chain asked, by key, exactly the declared rows — one
    // batched ask, nothing landed yet, no second ask.
    expect(askLog).toEqual([
      [
        { agent: "claude", sessionId: "x" },
        { agent: "claude", sessionId: "y" },
      ],
    ]);
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1);

    // BEFORE the landing: journal marks alone — y leads.
    const before = snapshot();
    expect(before.order).toEqual(["y", "x"]);
    expect(before).toEqual({
      order: ["y", "x"],
      indicator: "none",
      scanning: "false",
      firstPagePending: "false",
      workspaceHits: "0",
      otherHits: "0",
    });

    // The late answer lands on the SAME mounted tree.
    await act(async () =>
      pendingResolvers[0]([hitX(500_000), { agent: "claude", sessionId: "y", status: "absent" }]),
    );

    // AFTER the landing: x re-seated by its index mtime; the SAME two
    // rows, same keys, nothing else appeared.
    const after = snapshot();
    expect(after.order).toEqual(["x", "y"]);
    expect([...after.order].sort()).toEqual(["x", "y"]);
    expect(after).toEqual({
      order: ["x", "y"],
      indicator: "none",
      scanning: "false",
      firstPagePending: "false",
      workspaceHits: "0",
      otherHits: "0",
    });

    // The after-state survives an empty re-render (same props, same
    // rows reference): the landing is not a transient frame.
    await act(async () => root.render(createElement(LandingHarness, { rows: ROWS })));
    expect(snapshot().order).toEqual(["x", "y"]);
    // The hit is stable: no re-ask was triggered by the re-render.
    expect(ipc.indexLookup).toHaveBeenCalledTimes(1);
  });

  it("an invalidated hit is purged and re-asked — the row falls back to its journal mark until the new answer lands", async () => {
    await act(async () => root.render(createElement(LandingHarness, { rows: ROWS })));

    // First landing: BOTH keys are hits (y's mtime stays below x's, so
    // x leads) — y becomes a STABLE hit, which is what makes the later
    // re-ask exactly-for-x.
    await act(async () =>
      pendingResolvers[0]([
        hitX(500_000),
        {
          agent: "claude",
          sessionId: "y",
          status: "hit",
          reference: CLAUDE_INDEX_ONLY,
          title: "y by index",
          mtime: 250_000,
        },
      ]),
    );
    expect(snapshot().order).toEqual(["x", "y"]);

    // A real snapshot update carries the NEW invalidated set (the key
    // the last scan pruned) with the revision bump — the real chain
    // purges x's cached hit and re-asks for it.
    await act(async () => {
      sessionIndex.set({
        scanning: false,
        revision: 2,
        invalidated: new Set(["claude:x"]),
      });
    });

    // The re-ask is EXACTLY for the purged key — y's hit never re-asks.
    expect(askLog[1]).toEqual([{ agent: "claude", sessionId: "x" }]);

    // The purged row fell back to its journal mark (100_000) while y
    // keeps its landed one (250_000): y leads again, mid-flight.
    const mid = snapshot();
    expect(mid.order).toEqual(["y", "x"]);
    expect(mid).toEqual({
      order: ["y", "x"],
      indicator: "none",
      scanning: "false",
      firstPagePending: "false",
      workspaceHits: "0",
      otherHits: "0",
    });

    // The second landing re-seats x — in the SAME DOM.
    await act(async () => pendingResolvers[1]([hitX(500_000)]));
    const after = snapshot();
    expect(after.order).toEqual(["x", "y"]);
    expect([...after.order].sort()).toEqual(["x", "y"]);
  });

  it("a forced scan×search race keeps the busy slot on Searching — not Indexing — while the row re-seats", async () => {
    // This test observes the DOM transition, not visual perception —
    // the frame may never paint. The race is CREATED by this fixture
    // (scanning forced on, both page-zero searches deferred), not
    // observed in the wild; no frequency, no duration is claimed.
    // indicator/firstPagePending here DO assert product behavior —
    // unlike the two strata above, the race IS exercised.
    sessionIndex.set({ scanning: true, revision: 1, invalidated: new Set() });
    const searchResolvers: Array<(page: SearchPage) => void> = [];
    ipc.indexSearch.mockReset();
    ipc.indexSearch.mockImplementation(
      () => new Promise<SearchPage>((res) => searchResolvers.push(res)),
    );

    await act(async () => root.render(createElement(LandingHarness, { rows: ROWS })));

    // The lookup is deferred, both page-zero searches hang, the scan
    // flag is ON: the ONE busy slot must name the SEARCH, and the row
    // order is journal marks alone — y first.
    const before = snapshot();
    expect(before).toEqual({
      order: ["y", "x"],
      indicator: "Searching",
      scanning: "true",
      firstPagePending: "true",
      workspaceHits: "0",
      otherHits: "0",
    });
    // The slot does NOT say Indexing while scanning is true — the
    // conflict §07's second condition lives on, made observable.
    expect(document.body.textContent).not.toContain("Indexing…");

    // The late hit lands UNDER THE SAME RACE: the row re-seats while
    // the slot still says Searching.
    await act(async () =>
      pendingResolvers[0]([hitX(500_000), { agent: "claude", sessionId: "y", status: "absent" }]),
    );
    const after = snapshot();
    expect(after).toEqual({
      order: ["x", "y"],
      indicator: "Searching",
      scanning: "true",
      firstPagePending: "true",
      workspaceHits: "0",
      otherHits: "0",
    });
    expect(document.body.textContent).not.toContain("Indexing…");

    // Clean finish: release both deferred page-zero searches.
    await act(async () => {
      for (const res of searchResolvers) res({ hits: [], total: 0 });
    });
  });
});
