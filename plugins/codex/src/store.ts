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
import type { PluginContext } from "@keepdeck/plugin-api";

/** codex's store root. Day-partitioned below this: `YYYY/MM/DD/`. */
export const ROOT = "~/.codex/sessions";

/** `rollout-<stamp>-<uuid>.jsonl` — the uuid is the session id, which is the
 * only way to tie a file to a pane that reported one. */
export const FILE_UUID = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/;

/**
 * The rollout a session id names, or null while it is not there yet.
 *
 * NEWEST FIRST, because that is the direction the answer usually lies in and
 * because a resumed session can leave an older file with the same id behind:
 * the day partitions sort lexically, so walking them in reverse reaches
 * today before last month.
 *
 * Absence is ordinary rather than an error. codex writes the rollout when
 * the session's first turn lands, so a pane that has reported its id but not
 * yet worked has no file — and the caller simply asks again later.
 */
/**
 * The newest rollouts on disk, newest first — the boot catch-up's candidates.
 *
 * Codex runs outside KeepDeck too, so its own files can know fresher account
 * limits than anything this deck persisted. A just-launched session writes
 * its rollout before any turn, though, so the newest file often carries no
 * limits at all and the real last word is one or two files back — hence a
 * LIST rather than an answer, read in order until one says something.
 *
 * Bounded twice over: the walk stops descending once it has enough, and the
 * day partitions are visited newest-first, so an account with years of
 * history costs the same as one with a week.
 */
export async function newestRollouts(
  ctx: PluginContext,
  limit: number,
): Promise<string[]> {
  const found: { path: string; mtime: number }[] = [];
  const walk = async (path: string): Promise<void> => {
    let entries;
    try {
      entries = await ctx.services.fs.readDir(path);
    } catch {
      // One unreadable partition is not an answer about the account; the
      // rest of the walk still is.
      return;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.kind === "dir") {
        dirs.push(entry.path);
        continue;
      }
      if (entry.kind !== "file") continue;
      if (!FILE_UUID.test(entry.name)) continue;
      found.push({ path: entry.path, mtime: entry.mtime ?? 0 });
    }
    for (const dir of dirs.sort().reverse()) {
      if (found.length >= limit) return;
      await walk(dir);
    }
  };
  await walk(ROOT);
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((entry) => entry.path);
}

export async function findRollout(
  ctx: PluginContext,
  sessionId: string,
): Promise<string | null> {
  const search = async (path: string): Promise<string | null> => {
    let entries;
    try {
      entries = await ctx.services.fs.readDir(path);
    } catch {
      // A partition that cannot be read is not an answer about the session.
      // Skipping keeps the rest of the search alive, which matters because
      // the store spans years of directories and one bad day must not hide
      // today's file.
      return null;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.kind === "dir") {
        dirs.push(entry.path);
        continue;
      }
      if (entry.kind !== "file") continue;
      if (FILE_UUID.exec(entry.name)?.[1] === sessionId) return entry.path;
    }
    for (const dir of dirs.sort().reverse()) {
      const found = await search(dir);
      if (found) return found;
    }
    return null;
  };
  return search(ROOT);
}
