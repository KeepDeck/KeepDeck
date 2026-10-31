import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** fast-import's `data` command: the exact byte count, then the bytes. */
const data = (text) => [`data ${Buffer.byteLength(text)}`, text];

/**
 * A throwaway repository holding `history`, checked out at main. ONE
 * `git fast-import` writes it all: built a git process per step, a case paid
 * seconds of process spawns before the script under test ran once.
 *
 * Each step lands on main by its first parent: a commit, or with
 * `merge: true` a merge of a one-commit side branch. Either carries the
 * `files` it sets ({ path: text }). The caller removes the directory.
 */
export function gitRepo(history) {
  const stream = [];
  let mark = 0;
  const commit = (ref, subject, files, from, merge) => {
    mark += 1;
    stream.push(
      `commit ${ref}`,
      `mark :${mark}`,
      `committer test <test@example.com> ${1_700_000_000 + mark * 60} +0000`,
      ...data(subject),
    );
    if (from) stream.push(`from :${from}`);
    if (merge) stream.push(`merge :${merge}`);
    for (const [path, text] of Object.entries(files)) {
      stream.push(`M 100644 inline ${path}`, ...data(text));
    }
    return mark;
  };

  let main = null;
  for (const { subject, files = {}, merge = false } of history) {
    const side = merge
      ? commit("refs/heads/side", `work for: ${subject}`, { [`side-${mark}.txt`]: subject }, main)
      : null;
    main = commit("refs/heads/main", subject, files, main, side);
  }

  const dir = mkdtempSync(join(tmpdir(), "kd-git-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, input: `${stream.join("\n")}\n` });
  execFileSync("git", ["checkout", "-qf", "main"], { cwd: dir });
  return dir;
}
