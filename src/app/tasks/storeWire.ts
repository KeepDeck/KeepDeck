/**
 * The task database's wire shape ↔ the domain's board.
 *
 * Coming in, a stored board is UNTRUSTED — another build, a restore, a
 * damaged file may have written it — so it is put in the board's stored
 * shape and read by the ONE validator (`decodeBoardValue`), exactly as a
 * file is. Going out, a board is written in the store's shape. The wire
 * types are generated from the Rust structs (`src/ipc/generated/tasks`);
 * this is the one place that maps them.
 */
import {
  decodeBoardValue,
  type DecodeResult,
  type TaskBoard,
} from "../../domain/tasks";
import type { StoredBoard } from "../../ipc/generated/tasks/StoredBoard";

/** A stored board as the domain's — or why it is not one. */
export function boardFromStored(
  stored: StoredBoard,
  mintUid: () => string,
): DecodeResult {
  // A log is stored by place: an entry out of place is a broken log,
  // refused like any field that does not fit.
  for (const [index, task] of stored.tasks.entries()) {
    const misplaced = task.log.findIndex((entry, i) => entry.seq !== i);
    if (misplaced >= 0) {
      return {
        ok: false,
        fault: {
          kind: "bad-task",
          index,
          id: task.key,
          field: `log[${misplaced}] (out of place)`,
        },
      };
    }
  }
  const raw = {
    nextId: stored.nextId,
    tasks: stored.tasks.map((task) => ({
      uid: task.uid,
      id: task.key,
      teamId: task.teamId,
      title: task.title,
      body: task.body,
      bodyV: task.bodyV,
      briefs: task.briefs.map((brief) => ({ v: brief.v, body: brief.body })),
      status: task.status,
      priority: task.priority,
      assignee: task.assignee,
      author: task.author,
      artifacts: task.artifacts,
      labels: task.labels,
      comments: task.comments.map((comment) => ({
        n: comment.n,
        at: comment.at,
        from: comment.author,
        body: comment.body,
      })),
      log: task.log.map((entry) => ({
        at: entry.at,
        from: entry.author,
        field: entry.field,
        was: entry.was,
        now: entry.now,
      })),
      created: task.created,
      updated: task.updated,
    })),
    relations: stored.relations.map((relation) => ({
      kind: relation.kind,
      from: relation.from,
      to: relation.to,
      at: relation.at,
      by: relation.by,
    })),
  };
  return decodeBoardValue(raw, mintUid);
}

/** Where a board lives in the store: its own id, its workspace, its rev. */
export interface StoredPlace {
  board: string;
  workspace: string | null;
  rev: number;
}

/** A board in the store's shape — what a migration imports and a restore
 * from memory writes. */
export function storedFromBoard(
  board: TaskBoard,
  place: StoredPlace,
): StoredBoard {
  return {
    board: place.board,
    workspace: place.workspace,
    nextId: board.nextId,
    rev: place.rev,
    tasks: board.tasks.map((task) => ({
      uid: task.uid,
      key: task.id,
      oldKeys: [],
      teamId: task.teamId,
      title: task.title,
      body: task.body,
      bodyV: task.bodyV,
      status: task.status,
      priority: task.priority,
      assignee: task.assignee,
      author: task.author,
      created: task.created,
      updated: task.updated,
      rev: place.rev,
      labels: [...task.labels],
      artifacts: [...task.artifacts],
      comments: task.comments.map((comment) => ({
        n: comment.n,
        at: comment.at,
        author: comment.from,
        body: comment.body,
      })),
      log: task.log.map((entry, seq) => ({
        seq,
        at: entry.at,
        author: entry.from,
        field: entry.field,
        was: entry.was,
        now: entry.now,
      })),
      briefs: task.briefs.map((brief) => ({ v: brief.v, body: brief.body })),
    })),
    relations: board.relations.map((relation) => ({
      kind: relation.kind,
      from: relation.from,
      to: relation.to,
      at: relation.at,
      by: relation.by,
    })),
  };
}
