/**
 * A claude session forked into any directory, carried whole.
 *
 * `--resume <id>` looks for the session only in the CURRENT directory's
 * project folder, so the source transcript is copied there first and claude
 * forks it itself (`--fork-session`): it writes the fork's transcript, and
 * moves its file-history snapshots on its own. The fork's id is chosen here
 * (`--session-id`, which claude accepts beside `--fork-session`), so what
 * claude does NOT carry is laid out under that id before it starts:
 *
 * - the session's folder — subagent transcripts (a child is looked up at
 *   SendMessage time under the CURRENT session's folder), spilled tool
 *   outputs, workflow scripts and runs, the custom title;
 * - its task list (`tasks/<id>/`), which a fork otherwise starts without.
 *
 * Histories name those files by absolute path, so every copied transcript
 * has the source folder's path replaced by the fork's.
 *
 * The copy claude forks from goes under a third, throwaway id: in the
 * source's own directory it could not take the source's name, and a second
 * file under the source's id is a second history row for one conversation.
 * The host removes it once the fork has started — the only moment it stops
 * being needed — and everything this surgery made if the fork never does.
 *
 * Not carried, deliberately: live-job state the source still owns (remote
 * agents, async MCP tasks, remote-sync and auto-mode files, recordings) —
 * a copied record cannot hand over a running job. The plan file is keyed by
 * its name, not the session, and stays shared, as claude's own fork does.
 *
 * Verified live on claude 2.1.303 (task-403).
 */
import type {
  ForkDiscard,
  ForkLaunch,
  ForkPlanInput,
  PluginFs,
  PluginFsWrite,
} from "@keepdeck/plugin-api";

/** What of a session's folder a fork carries — its history, not its jobs. */
const CARRIED = new Set(["subagents", "tool-results", "workflows", "custom-title.json"]);

/** Files whose text can name the source folder — the rest are copied as is. */
const TEXT = /\.(jsonl|json)$/;

/** Claude's project folder name for a directory (its `sanitizePath`, read
 * from 2.1.303 and checked against folders it made for 321-char paths):
 * every non-alphanumeric character becomes `-`; past 200 characters the
 * name is cut there and a hash of the WHOLE path is appended. */
export function claudeProjectFolder(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= 200) return slug;
  let hash = 0;
  for (let i = 0; i < cwd.length; i++) hash = ((hash << 5) - hash + cwd.charCodeAt(i)) | 0;
  return `${slug.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}

/** A path as it appears inside a JSON string — how a transcript spells it. */
const inJson = (path: string) => JSON.stringify(path).slice(1, -1);

export interface ClaudeForkStore {
  fs: Pick<PluginFs, "readDir">;
  fsWrite: Pick<PluginFsWrite, "copyFile" | "remove">;
  newId(): string;
}

export async function forkClaudeSession(
  store: ClaudeForkStore,
  input: ForkPlanInput,
): Promise<ForkLaunch> {
  const source = input.transcriptPath;
  if (source === undefined) {
    throw new Error(
      `claude fork of ${input.sessionId}: no transcript is known for this session`,
    );
  }
  if (!source.endsWith(`/${input.sessionId}.jsonl`)) {
    throw new Error(
      `claude fork of ${input.sessionId}: the transcript is not this session's .jsonl (${source})`,
    );
  }
  // The store's own root, read off the transcript — never a guess at the
  // home. A changed layout is refused here; a store moved out of the
  // manifest's write prefixes (CLAUDE_CONFIG_DIR) is refused by the host.
  const marker = "/projects/";
  const at = source.lastIndexOf(marker);
  if (at < 0) {
    throw new Error(`claude fork of ${input.sessionId}: unexpected store layout (${source})`);
  }
  const config = source.slice(0, at);
  const sourceDir = source.slice(0, source.lastIndexOf("/"));
  const targetDir = `${config}/projects/${claudeProjectFolder(input.cwd)}`;
  const forkId = store.newId();
  const scratchId = store.newId();

  const sourceFolder = `${sourceDir}/${input.sessionId}`;
  const forkFolder = `${targetDir}/${forkId}`;
  const scratch = `${targetDir}/${scratchId}.jsonl`;
  const sourceTasks = `${config}/tasks/${input.sessionId}`;
  const forkTasks = `${config}/tasks/${forkId}`;
  const replace = [[inJson(`${sourceFolder}/`), inJson(`${forkFolder}/`)]] as const;

  const made = [scratch, forkFolder, forkTasks];
  try {
    await store.fsWrite.copyFile(source, scratch, { replace });
    // A session that spawned nothing has no folder, one that made no task
    // no list — absent is nothing to carry, but an unreadable store throws.
    if (await hasDir(store, sourceDir, input.sessionId)) {
      await copyTree(store, sourceFolder, forkFolder, replace, (name) => CARRIED.has(name));
    }
    if ((await hasDir(store, config, "tasks")) && (await hasDir(store, `${config}/tasks`, input.sessionId))) {
      // A lock is the source process's coordination, not a task.
      await copyTree(store, sourceTasks, forkTasks, [], (name) => !name.endsWith(".lock"));
    }
  } catch (error) {
    // Throwing must leave the store untouched.
    for (const path of made) await store.fsWrite.remove(path).catch(() => {});
    throw error;
  }
  const discard: ForkDiscard = { onceStarted: [scratch], ifNeverStarted: made };
  return {
    args: ["--session-id", forkId, "--fork-session", "--resume", scratchId],
    discard,
  };
}

async function hasDir(store: ClaudeForkStore, parent: string, name: string): Promise<boolean> {
  const entries = await store.fs.readDir(parent);
  return entries.some((entry) => entry.name === name && entry.kind === "dir");
}

/** Copy `from`'s entries the filter admits (at the top level only) into
 * `to`, recursively; text files with `replace` applied. A symlink is not
 * followed: the store makes none, and following one could copy anything. */
async function copyTree(
  store: ClaudeForkStore,
  from: string,
  to: string,
  replace: readonly (readonly [string, string])[],
  admit: (name: string) => boolean,
): Promise<void> {
  for (const entry of await store.fs.readDir(from)) {
    if (!admit(entry.name)) continue;
    const target = `${to}/${entry.name}`;
    if (entry.kind === "dir") {
      await copyTree(store, entry.path, target, replace, () => true);
    } else if (entry.kind === "file") {
      await store.fsWrite.copyFile(
        entry.path,
        target,
        replace.length > 0 && TEXT.test(entry.name) ? { replace } : undefined,
      );
    }
  }
}
