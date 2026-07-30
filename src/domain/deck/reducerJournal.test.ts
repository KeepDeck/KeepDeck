import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../workspaceInstance";
import { deckReducer, initialDeckState, type DeckState } from "./reducer";
import { deckState as state, workspace as ws } from "./reducer.testSupport";
import type { Workspace } from "./workspaces";

const AT = "2026-07-19T12:00:00.000Z";
const journalWorkspace = (): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "ws-1",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [
    { id: "pane-1", agentType: "codex", name: "auth bug", yolo: true },
    { id: "pane-2", cwd: "/repo/wt", branch: "kd/ws/2" },
  ],
});

const boundState = (): DeckState =>
  deckReducer(
    state({ workspaces: [journalWorkspace()], activeId: "ws-1" }),
    {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-1",
      session: { id: "s-1", boundAt: AT },
      transcriptPath: "/t/s-1.jsonl",
      at: AT,
    },
  );

const closedRecord = (sessionId: string) => ({
  agent: "claude" as const,
  sessionId,
  cwd: "/repo",
  boundAt: "2026-07-18T00:00:00.000Z",
  state: "closed" as const,
  endedAt: "2026-07-18T01:00:00.000Z",
});

describe("deckReducer journal", () => {
  it("records pane-derived fields when binding", () => {
    const bound = boundState();
    expect(bound.journal.records["ws-1"]).toEqual([
      {
        agent: "codex",
        sessionId: "s-1",
        cwd: "/repo",
        yolo: true,
        transcriptPath: "/t/s-1.jsonl",
        boundAt: AT,
        state: "live",
        paneId: "pane-1",
      },
    ]);
    expect(bound.journal.tail).toHaveLength(1);
  });

  it("uses a worktree pane's own cwd and branch", () => {
    const bound = deckReducer(
      state({ workspaces: [journalWorkspace()], activeId: "ws-1" }),
      {
        type: "setPaneSession",
        wsId: "ws-1",
        paneId: "pane-2",
        session: { id: "s-2", boundAt: AT },
        at: AT,
      },
    );
    expect(bound.journal.records["ws-1"][0]).toMatchObject({
      agent: "claude",
      cwd: "/repo/wt",
      branch: "kd/ws/2",
    });
  });

  it("seals the previous session on rebind and opens the next one", () => {
    const rebound = deckReducer(boundState(), {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-1",
      session: { id: "s-2", boundAt: AT },
      at: AT,
    });
    const records = rebound.journal.records["ws-1"];
    expect(records.find((record) => record.sessionId === "s-1")).toMatchObject({
      state: "closed",
      endedAt: AT,
      title: "auth bug",
    });
    expect(records.find((record) => record.sessionId === "s-2")).toMatchObject({
      state: "live",
      paneId: "pane-1",
    });
    expect(rebound.journal.tail.map((event) => event.e)).toEqual([
      "bound",
      "sealed",
      "bound",
    ]);
  });

  it("seals a journal row when its binding is cleared", () => {
    const cleared = deckReducer(boundState(), {
      type: "setPaneSession",
      wsId: "ws-1",
      paneId: "pane-1",
      session: null,
      at: AT,
    });
    expect(cleared.journal.records["ws-1"][0]).toMatchObject({
      state: "closed",
      endedAt: AT,
    });
  });

  it("seals a bound row on agent close and ignores a never-bound pane", () => {
    const closed = deckReducer(boundState(), {
      type: "closeAgent",
      wsId: "ws-1",
      paneId: "pane-1",
      at: AT,
    });
    expect(closed.journal.records["ws-1"][0]).toMatchObject({
      state: "closed",
      title: "auth bug",
      endedAt: AT,
    });
    const start = state({
      workspaces: [journalWorkspace()],
      activeId: "ws-1",
    });
    expect(
      deckReducer(start, {
        type: "closeAgent",
        wsId: "ws-1",
        paneId: "pane-2",
        at: AT,
      }).journal,
    ).toBe(start.journal);
  });

  it("prunes a workspace journal on close", () => {
    const closed = deckReducer(boundState(), {
      type: "closeWorkspace",
      id: "ws-1",
      at: AT,
    });
    expect(closed.journal.records).toEqual({});
    expect(closed.journal.tail[closed.journal.tail.length - 1]).toMatchObject({
      e: "wsDeleted",
      wsId: "ws-1",
    });
  });

  it("prunes crash-orphaned journal state before reusing an id", () => {
    const closed = deckReducer(boundState(), {
      type: "closeWorkspace",
      id: "ws-1",
      at: AT,
    });
    const stale: DeckState = {
      ...closed,
      journal: boundState().journal,
      workspaces: [],
    };
    const recreated = deckReducer(stale, {
      type: "createWorkspace",
      workspace: journalWorkspace(),
      at: AT,
    });
    expect(recreated.journal.records).toEqual({});
  });

  it("keeps the live journal during deck hydrate", () => {
    const bound = boundState();
    const hydrated = deckReducer(bound, {
      type: "hydrate",
      state: state({
        workspaces: [journalWorkspace()],
        activeId: "ws-1",
      }),
    });
    expect(hydrated.journal).toBe(bound.journal);
  });

  it("hydrates records only for live workspaces restored from disk", () => {
    const restored = deckReducer(boundState(), {
      type: "hydrate",
      state: state({
        workspaces: [journalWorkspace()],
        activeId: "ws-1",
      }),
    });
    const hydrated = deckReducer(restored, {
      type: "hydrateJournal",
      records: {
        "ws-1": [closedRecord("past")],
        "ws-dead": [closedRecord("orphan")],
      },
      at: AT,
    });
    expect(Object.keys(hydrated.journal.records)).toEqual(["ws-1"]);
    expect(
      hydrated.journal.records["ws-1"]
        .map((record) => record.sessionId)
        .sort(),
    ).toEqual(["past", "s-1"]);
  });

  it("keeps another restored workspace's history when one closes first", () => {
    const restored = deckReducer(initialDeckState, {
      type: "hydrate",
      state: state({
        workspaces: [
          journalWorkspace(),
          { ...journalWorkspace(), id: "ws-2", name: "ws-2" },
        ],
        activeId: "ws-1",
      }),
    });
    const closed = deckReducer(restored, {
      type: "closeWorkspace",
      id: "ws-2",
      at: AT,
    });
    const hydrated = deckReducer(closed, {
      type: "hydrateJournal",
      records: { "ws-1": [closedRecord("keep-me")] },
      at: AT,
    });
    expect(
      hydrated.journal.records["ws-1"]?.map((record) => record.sessionId),
    ).toEqual(["keep-me"]);
  });

  it("does not attach dead history to a restored id closed and recreated early", () => {
    const restored = deckReducer(initialDeckState, {
      type: "hydrate",
      state: state({
        workspaces: [journalWorkspace()],
        activeId: "ws-1",
      }),
    });
    const closed = deckReducer(restored, {
      type: "closeWorkspace",
      id: "ws-1",
      at: AT,
    });
    const recreated = deckReducer(closed, {
      type: "createWorkspace",
      workspace: journalWorkspace(),
      at: AT,
    });
    const hydrated = deckReducer(recreated, {
      type: "hydrateJournal",
      records: { "ws-1": [closedRecord("dead-history")] },
      at: AT,
    });
    expect(hydrated.journal.records).toEqual({});
  });

  it("does not attach crash-orphaned history to a workspace created this run", () => {
    const empty = deckReducer(initialDeckState, {
      type: "hydrate",
      state: state({ workspaces: [], activeId: "" }),
    });
    const recreated = deckReducer(empty, {
      type: "createWorkspace",
      workspace: journalWorkspace(),
      at: AT,
    });
    const hydrated = deckReducer(recreated, {
      type: "hydrateJournal",
      records: {
        "ws-1": [
          {
            ...closedRecord("phantom"),
            cwd: "/somewhere/else",
          },
        ],
      },
      at: AT,
    });
    expect(hydrated.journal.records).toEqual({});
    expect(
      hydrated.journal.tail.some(
        (event) => event.e === "wsDeleted" && event.wsId === "ws-1",
      ),
    ).toBe(true);
  });

  it("deletes one record and flushes the journal outbox", () => {
    const bound = boundState();
    const deleted = deckReducer(bound, {
      type: "deleteJournalRecord",
      wsId: "ws-1",
      sessionId: "s-1",
      at: AT,
    });
    expect(deleted.journal.records).toEqual({});
    expect(deleted.journal.tail).toHaveLength(2);
    const flushed = deckReducer(deleted, {
      type: "journalFlushed",
      count: 2,
    });
    expect(flushed.journal.tail).toEqual([]);
    expect(
      deckReducer(flushed, { type: "journalFlushed", count: 0 }),
    ).toBe(flushed);
  });
});

describe("deckReducer journal claims on addAgentPane", () => {
  it("claims a live record for a pane that arrives with a session", () => {
    const added = deckReducer(
      state({ workspaces: [ws("ws-1", [])], activeId: "ws-1" }),
      {
        type: "addAgentPane",
        id: "ws-1",
        pane: {
          id: "pane-9",
          agentType: "kimi",
          cwd: "/repo/wt",
          branch: "kd/x/9",
          session: { id: "s-res", boundAt: AT },
        },
      },
    );
    expect(added.journal.records["ws-1"][0]).toMatchObject({
      agent: "kimi",
      sessionId: "s-res",
      cwd: "/repo/wt",
      branch: "kd/x/9",
      state: "live",
      paneId: "pane-9",
    });
  });

  it("preserves frozen metadata when reclaiming a sealed record", () => {
    const start = state({
      workspaces: [ws("ws-1", [])],
      activeId: "ws-1",
      journal: {
        records: {
          "ws-1": [
            {
              agent: "kimi",
              sessionId: "s-res",
              cwd: "/repo/wt",
              title: "polish pass",
              transcriptPath: "/t/s-res",
              boundAt: "2026-07-18T00:00:00.000Z",
              state: "closed",
              endedAt: "2026-07-18T01:00:00.000Z",
            },
          ],
        },
        tail: [],
      },
    });
    const added = deckReducer(start, {
      type: "addAgentPane",
      id: "ws-1",
      pane: {
        id: "pane-9",
        agentType: "kimi",
        cwd: "/repo/wt",
        session: { id: "s-res", boundAt: AT },
      },
    });
    expect(added.journal.records["ws-1"][0]).toMatchObject({
      state: "live",
      title: "polish pass",
      transcriptPath: "/t/s-res",
      boundAt: AT,
    });
  });

  it("leaves the journal untouched for a pane without a session", () => {
    const start = state({
      workspaces: [ws("ws-1", [])],
      activeId: "ws-1",
    });
    const added = deckReducer(start, {
      type: "addAgentPane",
      id: "ws-1",
      pane: { id: "pane-9", agentType: "claude" },
    });
    expect(added.journal).toBe(start.journal);
  });
});
