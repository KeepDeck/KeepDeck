import type { Pane, Team, Workspace } from "../../domain/deck";
import type { CommandSource } from "../../domain/commands";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { decodeBoard, encodeBoard, type TaskLanding } from "../../domain/tasks";
import { mintSequence } from "../../domain/tasks/testSupport";
import { decodeFaultText } from "./refusalText";
import type { TasksStorePort } from "./tasksService";

/** A store in memory, with the writes and drops it saw in order. It keeps
 * each board as the JSON a file would hold, read through the codec — so a
 * test can put any bytes "on disk", a broken board included. */
export function fakeStore(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: { workspaceId: string; json: string }[] = [];
  /** Every call that touched the disk, in order. */
  const calls: ("write" | "drop")[] = [];
  let failNext: string | null = null;
  let refusal: string | null = null;
  /** A write whose bytes land at once but whose answer waits. */
  let holdNext: Promise<void> | null = null;
  /** A drop that removes the file at once but whose answer waits. */
  let holdDrop: Promise<void> | null = null;
  const mint = mintSequence("uid-read-");
  /** Each write's change number, every task it carried taking it. */
  const revs = new Map<string, { board: number; tasks: Map<string, TaskLanding> }>();
  const port: TasksStorePort = {
    read: async ({ workspaceId }) => {
      const json = files.get(workspaceId);
      if (json === undefined) return { kind: "none" };
      const decoded = decodeBoard(json, mint);
      return decoded.ok ? { kind: "board", board: decoded.board } : { kind: "unreadable", error: decodeFaultText(decoded.fault) };
    },
    write: async ({ workspaceId, board }) => {
      if (failNext !== null) {
        const why = failNext;
        failNext = null;
        throw new Error(why);
      }
      const json = encodeBoard(board);
      const before = files.get(workspaceId);
      const was = before === undefined ? null : decodeBoard(before, mint);
      const held = revs.get(workspaceId) ?? { board: 0, tasks: new Map<string, TaskLanding>() };
      held.board += 1;
      const rev = held.board;
      for (const task of board.tasks) {
        const old = was?.ok ? was.board.tasks.find((t) => t.uid === task.uid) : undefined;
        if (old && JSON.stringify(old) === JSON.stringify(task)) continue;
        // What was on the file before any write here landed before rev 1.
        const landed = held.tasks.get(task.uid);
        const grown = (prev: readonly number[], length: number) => [...prev, ...new Array<number>(length - prev.length).fill(rev)];
        held.tasks.set(task.uid, {
          created: landed?.created ?? (old ? 0 : rev),
          rev,
          comments: grown(landed?.comments ?? new Array<number>(old?.comments.length ?? 0).fill(0), task.comments.length),
          log: grown(landed?.log ?? new Array<number>(old?.log.length ?? 0).fill(0), task.log.length),
        });
      }
      revs.set(workspaceId, held);
      writes.push({ workspaceId, json });
      calls.push("write");
      files.set(workspaceId, json);
      if (holdNext !== null) {
        const held = holdNext;
        holdNext = null;
        await held;
      }
    },
    drop: async ({ workspaceId }) => {
      calls.push("drop");
      files.delete(workspaceId);
      if (holdDrop !== null) {
        const held = holdDrop;
        holdDrop = null;
        await held;
      }
    },
    writeRefusal: () => refusal,
    // A word match over titles, briefs and comments of the board as written.
    search: async ({ workspaceId, query, limit }) => {
      const json = files.get(workspaceId);
      const decoded = json === undefined ? null : decodeBoard(json, mint);
      if (!decoded?.ok) return [];
      const q = query.toLowerCase();
      return decoded.board.tasks
        .flatMap((t) => [
          ...(`${t.title}\n${t.body}`.toLowerCase().includes(q) ? [{ uid: t.uid, comment: null, snippet: `[${query}]` }] : []),
          ...t.comments.filter((c) => c.body.toLowerCase().includes(q)).map((c) => ({ uid: t.uid, comment: c.n, snippet: `[${query}]` })),
        ])
        .slice(0, limit);
    },
    revisions: (workspaceId) => revs.get(workspaceId) ?? null,
    recovery: () => null,
    restore: async () => {},
  };
  return {
    port,
    files,
    writes,
    calls,
    failNextWrite(why: string) {
      failNext = why;
    },
    /** From now on nothing can be written, for `why` (null: writes again). */
    refuseWrites(why: string | null) {
      refusal = why;
    },
    /** The next write's bytes land, but its answer waits for the release. */
    holdNextWrite(): () => void {
      let release!: () => void;
      holdNext = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    /** The next drop removes the file, but its answer waits for the release. */
    holdNextDrop(): () => void {
      let release!: () => void;
      holdDrop = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

export const pane = (id: string, team?: { teamId: string; role: string }): Pane => ({
  id,
  agentType: "claude",
  ...(team && { team }),
});

export const workspace = (id: string, name: string, panes: Pane[], teams?: Team[]): Workspace =>
  ({
    id,
    instance: createWorkspaceInstance(),
    name,
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
    ...(teams && { teams }),
  }) as Workspace;

export const TEAMS: Team[] = [
  { id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo/.wt/api" } },
  { id: "team-2", name: "web", location: { kind: "attached", cwd: "/repo/.wt/web" } },
];

/** ws-1: team api = pane-1 lead, pane-2 impl-1, pane-3 impl-2; team web =
 * pane-5 lead; pane-7 on no team. ws-2 holds pane-9 alone. */
export function teamedWorkspaces(): Workspace[] {
  return [
    workspace(
      "ws-1",
      "keepdeck",
      [
        pane("pane-1", { teamId: "team-1", role: "lead" }),
        pane("pane-2", { teamId: "team-1", role: "impl-1" }),
        pane("pane-3", { teamId: "team-1", role: "impl-2" }),
        pane("pane-5", { teamId: "team-2", role: "lead" }),
        pane("pane-7"),
      ],
      TEAMS,
    ),
    workspace("ws-2", "site", [pane("pane-9")]),
  ];
}

/** A caller identified as a pane, the way the MCP transport mints it. */
export function from(paneId: string, workspaceId = "ws-1"): CommandSource {
  return { kind: "external", client: "mcp", pane: { id: paneId, workspaceId, label: paneId } };
}

export const ANONYMOUS: CommandSource = { kind: "external", client: "mcp" };
