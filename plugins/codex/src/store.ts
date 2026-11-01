/**
 * Where codex keeps its sessions, and how to find one.
 *
 * ONE place, because the same three facts were about to be held in three:
 * the history browser walks this tree, the live tail needs one file out of
 * it, and the backend used to hold a Rust copy of the same path and pattern
 * for its own lookup. The backend's copy is what this replaces — a store's
 * shape is the agent's, and a host that knows it is a host that has to be
 * edited when the agent moves house.
 */
import { readStoreDir, type FsEntry, type PluginFs } from "@keepdeck/plugin-api";

/** What finding a rollout needs from the host: the store's listings. */
export interface StorePorts {
  services: { fs: Pick<PluginFs, "readDir"> };
}

/** codex's store root. Day-partitioned below this: `YYYY/MM/DD/`. */
export const ROOT = "~/.codex/sessions";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The names codex gives a rollout (rollout/src/rollout_file_name.rs):
 * `rollout-<stamp>-<thread>.jsonl`, or `rollout-<stamp>-<thread>_<segment>
 * .jsonl` once a thread has been reverted onto a new segment — and either
 * one followed by `.zst` once codex has compressed it (task-396). The FIRST
 * uuid is the session id, the only way to tie a file to a pane that
 * reported one.
 */
const ROLLOUT_NAME = new RegExp(`^rollout-.*?-(${UUID})(?:_${UUID})?\\.jsonl(\\.zst)?$`);

/** What a rollout's file name says: whose session it is, and whether codex
 * has compressed it — a compressed file is old, never written to again
 * (codex makes it plain before it appends), and not readable as text. */
export interface RolloutName {
  sessionId: string;
  compressed: boolean;
}

/** A rollout's name read, or null for anything else in the store. */
export function rolloutName(name: string): RolloutName | null {
  const match = ROLLOUT_NAME.exec(name);
  return match ? { sessionId: match[1], compressed: match[2] !== undefined } : null;
}

/**
 * Every rollout file in the store, NEWEST FIRST: a partition's files, then
 * its sub-partitions in reverse — the day partitions sort lexically, so
 * reverse reaches today before last month. The one walk over this tree, for
 * the history browser, the live tail's lookup and the boot catch-up alike.
 *
 * The ROOT's refusal is thrown: the history contract reads that as "no store"
 * or "unreadable store" itself. A partition that will not read is reported
 * to `unreadable` (ignored when absent) and skipped. `stop` is asked before
 * each sub-partition, so a search ends as soon as it has its answer.
 *
 * ONE file per segment: while codex is compressing a rollout, or making a
 * compressed one plain again, both can stand side by side for a moment —
 * and codex itself reads the plain one (compression.rs). So does this walk.
 */
export async function walkRollouts(
  ctx: StorePorts,
  visit: {
    file(entry: FsEntry, name: RolloutName): void;
    stop?(): boolean;
    unreadable?(part: string, error?: unknown): void;
  },
): Promise<void> {
  const walk = async (entries: FsEntry[]): Promise<void> => {
    const dirs: FsEntry[] = [];
    const files: { entry: FsEntry; name: RolloutName }[] = [];
    for (const entry of entries) {
      if (entry.kind === "dir") dirs.push(entry);
      else if (entry.kind === "file") {
        const name = rolloutName(entry.name);
        if (name) files.push({ entry, name });
      }
    }
    const plain = new Set(files.filter((file) => !file.name.compressed).map((file) => file.entry.name));
    for (const { entry, name } of files) {
      if (!name.compressed || !plain.has(entry.name.slice(0, -".zst".length))) visit.file(entry, name);
    }
    dirs.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const dir of dirs) {
      if (visit.stop?.()) return;
      const children = await readStoreDir(
        ctx.services.fs,
        dir.path,
        visit.unreadable ?? (() => {}),
      );
      if (children) await walk(children);
    }
  };
  await walk(await ctx.services.fs.readDir(ROOT));
}

/**
 * The rollout a session id names, or null while it is not there yet.
 *
 * NEWEST FIRST, because that is the direction the answer usually lies in and
 * because a resumed session can leave an older file with the same id behind.
 *
 * Absence is ordinary rather than an error. codex writes the rollout when
 * the session's first turn lands, so a pane that has reported its id but not
 * yet worked has no file — and the caller simply asks again later.
 *
 * PLAIN files only: this is the file a live pane is writing, and codex
 * never writes to a compressed one — it makes it plain again first. A
 * session found only compressed is not live yet, and is asked about again.
 */
export async function findRollout(
  ctx: StorePorts,
  sessionId: string,
): Promise<string | null> {
  let found: string | null = null;
  try {
    await walkRollouts(ctx, {
      file: (entry, name) => {
        if (name.sessionId === sessionId && !name.compressed && found === null) found = entry.path;
      },
      stop: () => found !== null,
    });
  } catch {
    return null;
  }
  return found;
}

/**
 * The newest rollouts on disk, newest first — the boot catch-up's candidates.
 *
 * Codex runs outside KeepDeck too, so its own files can know fresher account
 * limits than anything this deck persisted. A just-launched session writes
 * its rollout before any turn, though, so the newest file often carries no
 * limits at all and the real last word is one or two files back — hence a
 * LIST rather than an answer, read in order until one says something.
 * Plain files only: a compressed rollout is a week old at least, and not
 * readable as text.
 */
export async function newestRollouts(
  ctx: StorePorts,
  limit: number,
): Promise<string[]> {
  const found: { path: string; mtime: number }[] = [];
  try {
    await walkRollouts(ctx, {
      file: (entry, name) => {
        if (!name.compressed) found.push({ path: entry.path, mtime: entry.mtime ?? 0 });
      },
      stop: () => found.length >= limit,
    });
  } catch {
    return [];
  }
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((entry) => entry.path);
}
