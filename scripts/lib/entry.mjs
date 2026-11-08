import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the module at `moduleUrl` is the program node was asked to run — the
 * guard every script's `main()` sits behind, so that importing one (a test,
 * another script) runs nothing.
 *
 * Compared as REAL paths. Node resolves a symlink before it loads the main
 * module, so `import.meta.url` names the target, while `argv[1]` is the path
 * as given. Invoked through a symlinked path — /tmp is one on macOS — the two
 * never matched, and a release script exited 0 having done nothing (task-562).
 * One copy for every script, because nine hand-written ones had already split
 * into two spellings.
 *
 * @param {string} moduleUrl the caller's `import.meta.url`
 * @param {string | undefined} [entry] the path node was given; `process.argv[1]`
 * @returns {boolean}
 */
export function isEntryPoint(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // A path that does not resolve names no program this module could be.
    return false;
  }
}
