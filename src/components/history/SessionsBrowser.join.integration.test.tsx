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
    scannedAgents: new Set(["claude", "kimi"]),
    invalidated: new Set<string>(),
  };
  const listeners = new Set<() => void>();
  return {
    set(next: { scanning: boolean; revision: number; scannedAgents?: Set<string> }) {
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
import { SessionsBrowser } from "./SessionsBrowser";

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
function Harness({ rows }: { rows: SessionRecord[] }) {
  const shared = useBrowserSharedSeam();
  const browserApi = useSessionsBrowser(new Set(["/repo"]), shared);
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
  beforeEach(() => {
    ipc.indexSearch.mockReset();
    ipc.indexSearch.mockResolvedValue({ hits: [], total: 0 });
    ipc.indexLookup.mockReset();
    claude.reads.length = 0;
    kimi.reads.length = 0;
    sessionIndex.set({ scanning: false, revision: 1 });
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const mount = (rows: SessionRecord[]) =>
    act(async () => root.render(createElement(Harness, { rows })));

  /** indexLookup answering by key — the ask's order is not this suite's
   * subject. */
  const answerBy: Record<string, IndexLookupAnswer> = {};
  const answerByKey = async (...raw: unknown[]): Promise<IndexLookupAnswer[]> => {
    const keys = raw[0] as { agent: string; sessionId: string }[];
    return keys.map(
      (k) =>
        answerBy[`${k.agent}:${k.sessionId}`] ?? {
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
    expect(row.querySelector(".history__status")?.textContent).toBe("wrong agent");
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
