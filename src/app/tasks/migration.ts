/**
 * Moving every board from its JSON file into the task database — ONCE,
 * for all boards at once, losing nothing (the user's rule, task-221
 * §07): either every board is read, adapted to the new shape, imported
 * and read back equal, and the database becomes the source; or nothing
 * switches and the files stay the source, with the reason said. There is
 * no state where some boards live in the database and some in files.
 *
 * Adapting is part of the move: a board written before relations, before
 * brief versions, or hand-edited into a non-canonical shape is read by
 * the codec's migrations into the one current shape — no old record kept
 * in its old form. Proof of no loss: the codec refuses anything it does
 * not know at every depth; every task, comment and log entry of the file
 * is counted through; and the imported boards are read back from the
 * database through the same validator and compared whole.
 */
import { decodeBoard, encodeBoard, type TaskBoard } from "../../domain/tasks";
import type { LegacyBoard } from "../../ipc/generated/tasks/LegacyBoard";
import type { MigrationSource } from "../../ipc/generated/tasks/MigrationSource";
import type { StoreStatus } from "../../ipc/generated/tasks/StoreStatus";
import type { StoredBoard } from "../../ipc/generated/tasks/StoredBoard";
import { decodeFaultText } from "./refusalText";
import { boardFromStored, storedFromBoard } from "./storeWire";

/** What the move needs from the store. */
export interface MigrationPort {
  status(): Promise<StoreStatus>;
  legacyBoards(): Promise<LegacyBoard[]>;
  import(boards: StoredBoard[], sources: MigrationSource[]): Promise<void>;
  loadAll(): Promise<StoredBoard[]>;
  /** The database becomes the source. */
  activate(): Promise<void>;
  /** Once it is: every board file left becomes its copy. */
  retireLegacy(): Promise<void>;
  discard(): Promise<void>;
}

export type MigrationOutcome =
  /** The boards live in the database — moved earlier, or just now.
   * `retireError`: the files left could not all become copies this time
   * (asked again at the next enable); nothing of the boards depends on it. */
  | { kind: "active"; moved: readonly MovedBoard[]; retireError: string | null }
  /** Nothing switched: the files are still the source, and why. */
  | { kind: "failed"; reason: string }
  /** The database cannot be used at all (damaged, or a newer build's). */
  | { kind: "unusable"; status: Exclude<StoreStatus, { kind: "ready" }> };

/** One board moved now: from which workspace's file, and whether the
 * workspace is still in the deck (if not, the board is kept unattached). */
export interface MovedBoard {
  workspace: string;
  attached: boolean;
  /** Its file was read in an older or hand-edited shape and adapted. */
  adapted: boolean;
}

export interface MigrationDeps {
  /** The workspaces the deck has now. */
  workspaces: readonly string[];
  mintUid(): string;
}

export async function migrateBoards(port: MigrationPort, deps: MigrationDeps): Promise<MigrationOutcome> {
  const status = await port.status();
  if (status.kind !== "ready") return { kind: "unusable", status };
  if (status.migration === "active") return { kind: "active", moved: [], retireError: await retire(port) };
  // A move cut short (the app closed between import and activation): the
  // files are still the source, so it starts over from them.
  if (status.migration === "pending") await port.discard();

  const files = await port.legacyBoards();
  const read: { file: LegacyBoard; board: TaskBoard; adapted: boolean }[] = [];
  for (const file of files) {
    const decoded = decodeBoard(file.json, deps.mintUid);
    if (!decoded.ok) return { kind: "failed", reason: `${file.workspace}: ${decodeFaultText(decoded.fault)}` };
    const lost = countsLost(file.json, decoded.board);
    if (lost !== null) return { kind: "failed", reason: `${file.workspace}: reading the board lost ${lost}` };
    read.push({ file, board: decoded.board, adapted: decoded.migrated || encodeBoard(decoded.board) !== file.json });
  }

  const known = new Set(deps.workspaces);
  const stored = read.map(({ file, board }) =>
    storedFromBoard(board, { board: deps.mintUid(), workspace: known.has(file.workspace) ? file.workspace : null, rev: 0 }),
  );
  const sources = files.map((file) => ({ workspace: file.workspace, checksum: file.checksum }));
  try {
    await port.import(stored, sources);
  } catch (e: unknown) {
    return { kind: "failed", reason: `importing the boards: ${describe(e)}` };
  }

  // From here a failure throws the import away whole: the files stay the source.
  const abandon = async (reason: string): Promise<MigrationOutcome> => {
    try {
      await port.discard();
    } catch (e: unknown) {
      // Still pending: the next enable throws it away and starts over.
      return { kind: "failed", reason: `${reason}; throwing the import away: ${describe(e)}` };
    }
    return { kind: "failed", reason };
  };
  const back = await port.loadAll();
  for (const [i, { file, board }] of read.entries()) {
    const loaded = back.find((candidate) => candidate.board === stored[i].board);
    if (!loaded) return abandon(`${file.workspace}: the board did not come back from the database`);
    const again = boardFromStored(loaded, deps.mintUid);
    if (!again.ok) return abandon(`${file.workspace}: ${decodeFaultText(again.fault, "the database")}`);
    if (encodeBoard(again.board) !== encodeBoard(board)) return abandon(`${file.workspace}: the board read back from the database differs`);
  }
  if (back.length !== stored.length) return abandon("the database holds boards the move did not write");
  // A file changed while it was being moved: its new bytes would be lost.
  const now = await port.legacyBoards();
  const unchanged =
    now.length === files.length && now.every((file) => sources.some((s) => s.workspace === file.workspace && s.checksum === file.checksum));
  if (!unchanged) return abandon("a board file changed while it was being moved — the move starts over at the next launch");

  try {
    await port.activate();
  } catch (e: unknown) {
    return abandon(`activating the boards in the database: ${describe(e)}`);
  }
  return {
    kind: "active",
    moved: read.map(({ file, adapted }) => ({ workspace: file.workspace, attached: known.has(file.workspace), adapted })),
    retireError: await retire(port),
  };
}

/** Make every board file left a copy; why not, when it could not. */
async function retire(port: MigrationPort): Promise<string | null> {
  try {
    await port.retireLegacy();
    return null;
  } catch (e: unknown) {
    return describe(e);
  }
}

/**
 * What the read let go of, counted against the file itself: its tasks,
 * and each task's comments and log entries (a brief edit's entry becomes
 * a version AND stays a log line, so the count holds). Null when nothing
 * was lost. The codec refuses what it does not know; this catches what
 * it would read and drop.
 */
export function countsLost(json: string, board: TaskBoard): string | null {
  const raw = JSON.parse(json) as { tasks?: { id?: unknown; comments?: unknown[]; log?: unknown[] }[] };
  const tasks = raw.tasks ?? [];
  if (tasks.length !== board.tasks.length) return `tasks (${tasks.length} in the file, ${board.tasks.length} read)`;
  for (const [i, task] of tasks.entries()) {
    const kept = board.tasks[i];
    if ((task.comments?.length ?? 0) !== kept.comments.length) return `comments of ${kept.id}`;
    if ((task.log?.length ?? 0) !== kept.log.length) return `log entries of ${kept.id}`;
  }
  return null;
}

function describe(e: unknown): string {
  if (typeof e === "object" && e !== null && "code" in e) return JSON.stringify(e);
  return e instanceof Error ? e.message : String(e);
}
