import type { TaskBoard } from "../../domain/tasks";

/** A board as the surface reads it while the application loads and saves. */
export type BoardState =
  | { kind: "loading" }
  | {
      kind: "ready";
      board: TaskBoard;
      /** Why the board on disk lags the one here — the last write's
       * failure, verbatim — or null while disk and memory agree. The
       * board retries on its own; this is how a surface says so. */
      unsaved: string | null;
    }
  /** The file did not decode; its words, verbatim. Read-only until fixed. */
  | { kind: "unreadable"; error: string };

/** A database the person recovers: damaged, or gone though earlier data
 * of it is still there — with the backups that pass the check, newest
 * first (ms since the epoch). */
export interface Recovery {
  kind: "damaged" | "missing";
  backups: readonly number[];
}

/** What takes an unusable database's place: a backup, or — with none to
 * restore — an empty database. */
export type RestoreChoice = { kind: "backup"; at: number } | { kind: "empty" };
