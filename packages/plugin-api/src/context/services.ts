import type { Disposable } from "./disposable.ts";

/**
 * Platform services. Every call is checked against the manifest's
 * capabilities before it runs (the CapabilityGate): `sessions.spawn` needs
 * an `exec` capability covering the command, `ports.allocate` needs `ports`.
 */
export interface PluginServices {
  readonly sessions: PluginSessions;
  readonly ports: PluginPorts;
  readonly opener: PluginOpener;
  readonly fs: PluginFs;
  readonly git: PluginGit;
}

export interface PluginSessions {
  /** Spawn a PTY session. Closing signals the whole process group. */
  spawn(
    opts: PluginSpawnOptions,
    onEvent: (event: PluginSessionEvent) => void,
  ): Promise<PluginSessionHandle>;
}

export interface PluginSpawnOptions {
  /** Program to run; omit for the user's shell. */
  command?: string | null;
  args?: string[];
  env?: [string, string][];
  cwd?: string;
  cols: number;
  rows: number;
}

export type PluginSessionEvent =
  | { type: "output"; bytes: Uint8Array }
  | { type: "exit"; code: number | null };

export interface PluginSessionHandle {
  readonly id: string;
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export interface PluginPorts {
  /** Deterministic 10-port block for `key`. */
  allocate(key: string): Promise<number>;
}

/** Open things on the user's machine (capability: `open`) — the default
 * browser for URLs, the default app for file paths. */
export interface PluginOpener {
  openUrl(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
}

/** Read-only access to the user's PROJECT files, gated by the `fs` capability —
 * its scope (`workspace` / `everywhere`) decides which folders are reachable,
 * enforced host-side by path containment the plugin cannot see or bypass.
 *
 * Lazy by design: `readDir` returns ONE directory's immediate children, so a
 * file-tree UI expands a node on demand instead of walking the whole tree (a
 * giant `node_modules` never loads until someone opens it). Read-only: there is
 * no create/write/delete surface here — that would be its own capability. */
export interface PluginFs {
  /** One directory's immediate children (not recursive). Order is unspecified;
   * callers sort for display. Rejects a path outside the capability's scope. */
  readDir(path: string): Promise<FsEntry[]>;
  /** One file's contents, decoded as UTF-8 text. A binary file comes back with
   * `text: null` / `isBinary: true`; a file past the read cap with
   * `truncated: true` — the plugin decides how to present either. */
  readFile(path: string, opts?: FsReadFileOptions): Promise<FsFile>;
  /** Watch a directory for changes to its LISTING — a child added, removed, or
   * renamed, NOT a content edit. `onChange` fires (coalesced) when the entries
   * change; re-`readDir` to get the new listing. Passive OS notification, so
   * the tree stays live without polling. Returns a Disposable that stops
   * watching; scoped by the `fs` capability like reads. */
  watch(path: string, onChange: () => void): Disposable;
}

export interface FsReadFileOptions {
  /** Preferred read cap in bytes; the host clamps it to its own ceiling.
   * Reading stops there and `truncated` is set. */
  maxBytes?: number;
}

/** One directory child. `path` is absolute — pass it straight back into
 * `readDir` / `readFile` to descend (containment is re-checked every call). */
export interface FsEntry {
  name: string;
  path: string;
  kind: FsEntryKind;
  /** Byte size of a regular file; absent for a directory or symlink. */
  size?: number;
}

/** What a child is, WITHOUT following symlinks — a symlink is reported as such,
 * never silently resolved to its target. */
export type FsEntryKind = "file" | "dir" | "symlink";

/** One file's contents. `text` is null when the file is binary (a NUL byte or
 * invalid UTF-8); `truncated` says the text stops at the read cap; `size` is
 * the file's full byte length regardless of the cap. */
export interface FsFile {
  path: string;
  text: string | null;
  isBinary: boolean;
  size: number;
  truncated: boolean;
}

/** Read-only git state of the user's PROJECT repositories, gated by the `git`
 * capability — path-scoped exactly like `fs` (`workspace` / `everywhere`),
 * enforced host-side. Reads never take git's optional locks, so they can run
 * beside an agent's own git commands without ever stalling them. Read-only:
 * stage/commit/discard would be a separate write capability. */
export interface PluginGit {
  /** The working tree's status at `repo` (a worktree path works — each
   * worktree has its own status). Rejects a path outside the scope. */
  status(repo: string): Promise<GitStatus>;
  /** Unified diff text for ONE tracked path, relative to `repo` — worktree vs
   * index by default, index vs HEAD with `staged`. Untracked files have no
   * diff; render their plain content (via `fs.readFile`) instead. */
  diffFile(repo: string, file: string, opts?: GitDiffOptions): Promise<string>;
  /** Watch the repo for status-relevant changes — working-tree edits AND
   * index/HEAD/ref moves (stage, commit, checkout). `onChange` fires
   * throttled; re-`status` to get the fresh state (debounce it — bursts are
   * normal). Passive OS notification: nothing is polled, nothing is locked. */
  watch(repo: string, onChange: () => void): Disposable;
}

export interface GitDiffOptions {
  /** Diff the index against HEAD (what's staged) instead of the worktree
   * against the index. */
  staged?: boolean;
}

/** A working tree's git status: the branch header plus every changed path. */
export interface GitStatus {
  /** Current branch; absent when HEAD is detached. */
  branch: string | null;
  detached: boolean;
  /** HEAD commit sha; absent on an unborn branch. */
  oid: string | null;
  /** Upstream branch, when configured (agent worktrees usually have none). */
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** Changed paths, in git's own output order. */
  entries: GitStatusEntry[];
}

/** One changed path. `staged`/`unstaged` carry git's porcelain v2 codes
 * verbatim (`M`odified, `A`dded, `D`eleted, `R`enamed, …; `"."` = unchanged
 * on that side) — how to word them is the plugin's presentation concern. */
export interface GitStatusEntry {
  /** Path relative to the repo root. */
  path: string;
  /** The pre-rename path, when the index stages a rename. */
  origPath: string | null;
  staged: string;
  unstaged: string;
  untracked: boolean;
  conflicted: boolean;
}
