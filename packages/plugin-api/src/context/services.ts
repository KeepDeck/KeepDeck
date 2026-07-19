import type { Disposable } from "./disposable.ts";
import type { PluginDownloads } from "./downloads.ts";
import type { PluginSpeech } from "./speech.ts";

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
  /** Session-store surgery writes, gated by `fsWrite` (see the capability). */
  readonly fsWrite: PluginFsWrite;
  /** Read-only SQL over the plugin's own declared store dbs (capability:
   * `sqliteReadonly`) — for stores that are databases, not files. */
  readonly sqlite: PluginSqlite;
  readonly git: PluginGit;
  /** Generic host-managed network transfers into private plugin storage. */
  readonly downloads: PluginDownloads;
  /** Microphone capture + local speech-to-text (capability: `mic`). */
  readonly speech: PluginSpeech;
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
  /** Open a path in a NAMED application — `application` is the app's name as
   * the OS resolves it (macOS: the `open -a` argument, e.g. "Visual Studio
   * Code"), so a plugin can target a specific editor instead of the default
   * handler. Rejects when the path is gone or the app isn't installed. */
  openPathWith(path: string, application: string): Promise<void>;
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

/** Narrow WRITE surface over the manifest's declared `fsWrite` path
 * prefixes — the surgery side of session portability (fork/relocate). Every
 * call is containment-checked host-side against those prefixes, on both ends
 * of a copy; nothing here deletes. */
export interface PluginFsWrite {
  /** Create a directory (and missing parents). */
  mkdir(path: string): Promise<void>;
  /** Copy one file; `dst` parents are created. BOTH ends must sit inside the
   * declared prefixes. An existing `dst` is overwritten (surgery may retry). */
  copyFile(src: string, dst: string): Promise<void>;
  /** Write a whole UTF-8 file atomically (tmp + rename). */
  writeFile(path: string, text: string): Promise<void>;
  /** Append one newline-terminated line — a single O_APPEND write. The line
   * itself must not contain a newline. */
  appendLine(path: string, line: string): Promise<void>;
}

/** A single parameterized SELECT against a declared store database, opened
 * READ-ONLY host-side (the store cannot be mutated or locked). Rows come
 * back as positional string cells (`null` for SQL NULL) — the plugin owns
 * the schema knowledge and the typing. */
export interface PluginSqlite {
  query(
    dbPath: string,
    sql: string,
    params?: string[],
  ): Promise<(string | null)[][]>;
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
  /** Modification time (epoch ms) — what incremental store scans key change
   * detection on. Absent when stat failed. */
  mtime?: number;
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
   * index by default, index vs HEAD with `staged`, or across a revision range
   * with `from`/`to` (`from` alone diffs against the working tree). Untracked
   * files have no diff; render their plain content (via `fs.readFile`)
   * instead. */
  diffFile(repo: string, file: string, opts?: GitDiffOptions): Promise<string>;
  /** The repo's history for a changes view: the full recent log (newest
   * first, capped by the host), annotated with the branch's fork point off
   * `base` (defaulting to the repo's default branch — exact for worktrees
   * created off it) and how many commits sit on the branch's side of it. */
  history(repo: string, opts?: GitHistoryOptions): Promise<GitHistory>;
  /** The repo's local branches and which one is checked out — the history
   * browser's ref picker. */
  branches(repo: string): Promise<GitBranches>;
  /** The paths changed across `from..to` — or everything since `from`
   * (committed or not) when `to` is omitted. The file list behind one commit
   * or a "since the fork" summary. */
  changedFiles(repo: string, from: string, to?: string): Promise<GitChangedFile[]>;
  /** Watch the repo for status-relevant changes — working-tree edits AND
   * index/HEAD/ref moves (stage, commit, checkout). `onChange` fires
   * throttled; re-`status` to get the fresh state (debounce it — bursts are
   * normal). Passive OS notification: nothing is polled, nothing is locked. */
  watch(repo: string, onChange: () => void): Disposable;
}

export interface GitDiffOptions {
  /** Diff the index against HEAD (what's staged) instead of the worktree
   * against the index. Ignored when `from` is present. */
  staged?: boolean;
  /** Diff from this revision — a commit's parent, a fork point. A root
   * commit's absent parent is handled host-side (empty tree). */
  from?: string;
  /** Diff up to this revision; omitted = the working tree. */
  to?: string;
}

export interface GitHistoryOptions {
  /** The base the fork point is measured against; omitted = the repo's
   * default branch. */
  base?: string;
  /** How many commits to list (the host clamps it). Lazy scrolling grows
   * this window; `ahead` stays honest regardless of it. */
  limit?: number;
  /** Walk history from this ref instead of the working tree's HEAD — a
   * branch can be browsed without being checked out anywhere. */
  rev?: string;
}

/** A repo's local branches, for a history browser's ref picker. */
export interface GitBranches {
  /** The branch the working tree is on; null when detached. */
  current: string | null;
  /** Local branch names, alphabetical; remote-tracking refs excluded. */
  branches: string[];
}

/** One commit in a history listing. */
export interface GitCommit {
  sha: string;
  author: string;
  /** Author time, unix seconds. */
  timestamp: number;
  /** The one-line commit subject. */
  subject: string;
}

/** A branch's history: the full recent log (capped), annotated with its
 * fork point so a UI can draw the boundary between the branch's own commits
 * and the base history beneath them. */
export interface GitHistory {
  /** The fork point commit; null = no meaningful fork (the repo IS the
   * base). It appears in `commits` too, where the boundary sits. */
  forkSha: string | null;
  /** Commits on the branch's own side of the fork — honest even when the
   * fork lies beyond the listing cap. Null without a fork. */
  ahead: number | null;
  /** Recent commits from HEAD, newest first, capped: the branch's own
   * commits, then the fork commit and the base history below it. */
  commits: GitCommit[];
}

/** One changed path across a revision range. `code` is git's status letter
 * (`M`/`A`/`D`/`R`/`C`/`T`); renames fold into one entry carrying both names. */
export interface GitChangedFile {
  path: string;
  origPath: string | null;
  code: string;
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
