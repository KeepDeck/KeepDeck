/**
 * What a failed read says about the repository — the state behind git's
 * words. The host hands a plugin the failure as one string: the crate's
 * `GitError` printed (`` `git status …` failed (exit 128): fatal: not a git
 * repository …``, `failed to run git: …`) or the host's own refusal. A tab
 * that printed it verbatim showed a command line and an exit code where a
 * person wanted to know that the folder is not a repository. This reads
 * the state out; the words for it are presentation.
 */
export type RepoTrouble =
  /** The directory is not inside a git repository. */
  | { kind: "not-repo" }
  /** The `git` binary could not be launched at all. */
  | { kind: "no-git" }
  /** An unborn branch: the repository has no commit yet. */
  | { kind: "no-commits" }
  /** The host refused the path — outside the workspace's roots. */
  | { kind: "out-of-scope" }
  /** Anything else: the first line of what was said after the command
   * frame — git's own words for a failure, the host's for a timeout. */
  | { kind: "failed"; detail: string };

export function repoTrouble(message: string): RepoTrouble {
  const text = message.toLowerCase();
  if (text.includes("not a git repository")) return { kind: "not-repo" };
  if (text.includes("failed to run git")) return { kind: "no-git" };
  if (text.includes("does not have any commits yet")) return { kind: "no-commits" };
  if (text.includes("outside the allowed workspace roots")) return { kind: "out-of-scope" };
  return { kind: "failed", detail: gitsOwnWords(message) };
}

/** The first line after the crate's `` `git …` failed (exit N | signal |
 * timeout): `` frame, git's `fatal:` / `error:` tag stripped — git's own
 * words for a failure, the host's ("gave no answer in 30s") for a timeout.
 * A message with no such frame (the host's, a fake's) is taken as it is. */
function gitsOwnWords(message: string): string {
  const framed = /^`git [^`]*` failed \((?:exit \d+|signal|timeout)\): /.exec(message);
  const body = framed ? message.slice(framed[0].length) : message;
  const firstLine = body.split("\n")[0].trim();
  return firstLine.replace(/^(?:fatal|error): /, "");
}
