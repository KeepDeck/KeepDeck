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

/** `rollout-<stamp>-<uuid>.jsonl` — the uuid is the session id, which is the
 * only way to tie a file to a pane that reported one. */
export const FILE_UUID = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/;

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
 */
export async function walkRollouts(
  ctx: StorePorts,
  visit: {
    file(entry: FsEntry, sessionId: string): void;
    stop?(): boolean;
    unreadable?(part: string, error?: unknown): void;
  },
): Promise<void> {
  const walk = async (entries: FsEntry[]): Promise<void> => {
    const dirs: FsEntry[] = [];
    for (const entry of entries) {
      if (entry.kind === "dir") dirs.push(entry);
      else if (entry.kind === "file") {
        const sessionId = FILE_UUID.exec(entry.name)?.[1];
        if (sessionId) visit.file(entry, sessionId);
      }
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
 */
export async function findRollout(
  ctx: StorePorts,
  sessionId: string,
): Promise<string | null> {
  let found: string | null = null;
  try {
    await walkRollouts(ctx, {
      file: (entry, id) => {
        if (id === sessionId && found === null) found = entry.path;
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
 */
export async function newestRollouts(
  ctx: StorePorts,
  limit: number,
): Promise<string[]> {
  const found: { path: string; mtime: number }[] = [];
  try {
    await walkRollouts(ctx, {
      file: (entry) => found.push({ path: entry.path, mtime: entry.mtime ?? 0 }),
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
