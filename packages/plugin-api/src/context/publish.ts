/**
 * Publishing a directory a plugin builds for its CLI (API 71): the files are
 * written aside and the directory replaced whole, so a CLI starting while it
 * is rebuilt reads the old set or the new one, never half of each — and a
 * file the new set no longer has is gone with the old one.
 */
import type { PluginFsWrite } from "./services.ts";

/** One file of a published directory, by its path inside it. */
export interface PublishedFile {
  /** Relative to the directory, `/`-separated, never `..`. */
  path: string;
  text: string;
}

/**
 * Make `dir` hold exactly `files`: built in `<dir>.tmp`, then moved over
 * `dir` (`fsWrite.move` replaces it whole). A build an earlier run left
 * half-done is cleared first. Callers that may publish the same directory
 * concurrently order themselves ([`oneAtATime`]): two builds share the
 * build-aside directory.
 */
export async function publishFiles(
  fsWrite: Pick<PluginFsWrite, "writeFile" | "remove" | "move">,
  dir: string,
  files: readonly PublishedFile[],
): Promise<void> {
  const tmp = `${dir}.tmp`;
  await fsWrite.remove(tmp);
  for (const file of files) {
    if (file.path.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`publishFiles: "${file.path}" is not a path inside the directory`);
    }
    await fsWrite.writeFile(`${tmp}/${file.path}`, file.text);
  }
  await fsWrite.move(tmp, dir);
}

/** Work run one at a time per key, each after the last one for that key
 * settled — a failure does not stall the next. */
export type OneAtATime = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export function oneAtATime(): OneAtATime {
  const tails = new Map<string, Promise<unknown>>();
  return (key, work) => {
    const run = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    tails.set(key, run);
    void run
      .finally(() => {
        if (tails.get(key) === run) tails.delete(key);
      })
      .catch(() => {});
    return run;
  };
}
