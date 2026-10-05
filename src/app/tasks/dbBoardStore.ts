/**
 * The task board's store PORT over the task database — the one owner of
 * how a board the service decided reaches the disk.
 *
 * Per board it holds what the database CONFIRMED: the board, its id and
 * its rev. A write sends the change from the confirmed board to the one
 * asked for (`storeDiff`) as one request with its own id. Only an answer
 * moves the confirmed board, so a write that failed is carried by the next.
 * A request whose answer was lost is sent again, the same request, before
 * anything else: the database answers "already applied" instead of
 * applying it twice (review task-262/263).
 *
 * At enable the boards move from their files into the database, all at
 * once (`migrateBoards`). If that cannot happen, or the database cannot be
 * used, the boards are read but nothing is written: the reason is the
 * port's `writeRefusal`, and the service refuses every change with it.
 */
import { EMPTY_BOARD, decodeBoard, type TaskBoard } from "../../domain/tasks";
import type { Applied } from "../../ipc/generated/tasks/Applied";
import type { ChangeSet } from "../../ipc/generated/tasks/ChangeSet";
import type { StoreError } from "../../ipc/generated/tasks/StoreError";
import type { StoredBoard } from "../../ipc/generated/tasks/StoredBoard";
import { migrateBoards, type MigrationOutcome, type MigrationPort } from "./migration";
import { BOARD_NOT_OPEN, decodeFaultText, migrationRefusalText, storeErrorText } from "./refusalText";
import { boardChange } from "./storeDiff";
import { boardFromStored } from "./storeWire";
import type { BoardRead, TasksStorePort } from "./tasksService";

/** What this owner needs from the Rust store. */
export interface TaskDatabasePort extends MigrationPort {
  enable(): Promise<void>;
  disable(): Promise<void>;
  load(workspace: string): Promise<StoredBoard | null>;
  apply(change: ChangeSet): Promise<Applied>;
  drop(workspace: string): Promise<void>;
}

export interface DbBoardStoreDeps {
  db: TaskDatabasePort;
  /** The workspaces the deck has now — which boards the move attaches. */
  workspaces(): readonly string[];
  mintUid(): string;
  isStoreError(value: unknown): value is StoreError;
  /** Hears how the move went, once per enable. */
  onMigration?(outcome: MigrationOutcome): void;
}

/** A board as the database last confirmed it. */
interface Confirmed {
  board: string;
  rev: number;
  held: TaskBoard;
  /** A request sent whose answer never came: sent again before any other. */
  pending: { change: ChangeSet; target: TaskBoard } | null;
}

export type DbBoardStore = TasksStorePort & { enable(): Promise<void>; disable(): Promise<void> };

export function createDbBoardStore(deps: DbBoardStoreDeps): DbBoardStore {
  const confirmed = new Map<string, Confirmed>();
  /** Why nothing can be written; null when writes go to the database. */
  let readOnly: string | null = BOARD_NOT_OPEN;
  /** The boards read from their files, when they could not move. */
  let fallback: Map<string, BoardRead> | null = null;

  const accept = (place: Confirmed, applied: Applied, target: TaskBoard) => {
    const rev = applied.revs.find((r) => r.board === place.board)?.rev;
    if (rev === undefined) throw new Error(`the database answered without board ${place.board}`);
    place.rev = rev;
    place.held = target;
    place.pending = null;
  };

  /** Read a board's confirmed state from the database again. */
  const reread = async (workspace: string, place: Confirmed) => {
    const stored = await deps.db.load(workspace);
    if (stored === null) return;
    const read = boardFromStored(stored, deps.mintUid);
    if (!read.ok) throw new Error(decodeFaultText(read.fault, "the database"));
    place.board = stored.board;
    place.rev = stored.rev;
    place.held = read.board;
  };

  /** Send one request; a coded refusal means it was NOT applied, anything
   * else (the answer lost on the way) leaves it pending. */
  const send = async (workspace: string, place: Confirmed, change: ChangeSet, target: TaskBoard) => {
    place.pending = { change, target };
    let applied: Applied;
    try {
      applied = await deps.db.apply(change);
    } catch (e: unknown) {
      if (!deps.isStoreError(e)) throw e;
      place.pending = null;
      if (e.code === "corrupt" || e.code === "schemaTooNew") readOnly = storeErrorText(e);
      // Computed against a state the database no longer holds: read it
      // again, and the next write is computed against what is there.
      if (e.code === "conflict" || e.code === "constraint") await reread(workspace, place);
      throw new Error(storeErrorText(e));
    }
    accept(place, applied, target);
  };

  return {
    async enable() {
      await deps.db.enable();
      confirmed.clear();
      fallback = null;
      const outcome = await migrateBoards(deps.db, { workspaces: deps.workspaces(), mintUid: deps.mintUid });
      deps.onMigration?.(outcome);
      if (outcome.kind === "active") {
        readOnly = null;
        return;
      }
      readOnly = migrationRefusalText(outcome);
      if (outcome.kind === "failed") {
        // Still the source: read, never written.
        fallback = new Map();
        for (const file of await deps.db.legacyBoards()) {
          const decoded = decodeBoard(file.json, deps.mintUid);
          fallback.set(
            file.workspace,
            decoded.ok ? { kind: "board", board: decoded.board } : { kind: "unreadable", error: decodeFaultText(decoded.fault) },
          );
        }
      }
    },
    async disable() {
      confirmed.clear();
      fallback = null;
      readOnly = BOARD_NOT_OPEN;
      await deps.db.disable();
    },
    async read({ workspaceId }) {
      if (fallback !== null) return fallback.get(workspaceId) ?? { kind: "none" };
      if (readOnly !== null) return { kind: "unreadable", error: readOnly };
      const stored = await deps.db.load(workspaceId);
      if (stored === null) {
        confirmed.delete(workspaceId);
        return { kind: "none" };
      }
      const read = boardFromStored(stored, deps.mintUid);
      if (!read.ok) return { kind: "unreadable", error: decodeFaultText(read.fault, "the database") };
      confirmed.set(workspaceId, { board: stored.board, rev: stored.rev, held: read.board, pending: null });
      return { kind: "board", board: read.board };
    },
    async write({ workspaceId, board }) {
      if (readOnly !== null) throw new Error(readOnly);
      let place = confirmed.get(workspaceId);
      if (!place) {
        // The workspace's first write: a board of its own, new to the database.
        place = { board: deps.mintUid(), rev: 0, held: EMPTY_BOARD, pending: null };
        confirmed.set(workspaceId, place);
      }
      if (place.pending) await send(workspaceId, place, place.pending.change, place.pending.target);
      const change = boardChange(place.held, board, { board: place.board, workspace: workspaceId, rev: place.rev });
      if (change === null) return;
      await send(workspaceId, place, { requestId: deps.mintUid(), boards: [change] }, board);
    },
    async drop({ workspaceId }) {
      confirmed.delete(workspaceId);
      await deps.db.drop(workspaceId);
    },
    writeRefusal: () => readOnly,
  };
}
