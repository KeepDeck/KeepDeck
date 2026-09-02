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
