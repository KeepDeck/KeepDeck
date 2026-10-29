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

/** A directory copied whole into a published one (API 74) — the staged
 * skills, with every file beside each SKILL.md. */
export interface PublishedCopy {
  /** Where the copy lands: relative to the directory, `/`-separated, never
   * `..`. */
  path: string;
  /** The directory copied (`fsWrite.copyDir`). */
  from: string;
}

/** What publishing needs of `services.fsWrite`. */
export type PublishingFsWrite = Pick<PluginFsWrite, "writeFile" | "copyDir" | "remove" | "move">;

/**
 * Make `dir` hold exactly `entries`: built in `<dir>.tmp`, then moved over
 * `dir` (`fsWrite.move` replaces it whole). A build an earlier run left
 * half-done is cleared first. Callers that may publish the same directory
 * concurrently order themselves ([`oneAtATime`]): two builds share the
 * build-aside directory.
 */
export async function publishFiles(
  fsWrite: PublishingFsWrite,
  dir: string,
  entries: readonly (PublishedFile | PublishedCopy)[],
): Promise<void> {
  await publishAside(fsWrite, dir, async (tmp) => {
    for (const entry of entries) {
      if (entry.path.split("/").some((part) => part === ".." || part === "")) {
        throw new Error(`publishFiles: "${entry.path}" is not a path inside the directory`);
      }
      const at = `${tmp}/${entry.path}`;
      await ("text" in entry ? fsWrite.writeFile(at, entry.text) : fsWrite.copyDir(entry.from, at));
    }
  });
}

/** Make `dir` an exact copy of the directory `from` (API 74), published like
 * [`publishFiles`]. */
export async function publishCopy(fsWrite: PublishingFsWrite, dir: string, from: string): Promise<void> {
  await publishAside(fsWrite, dir, (tmp) => fsWrite.copyDir(from, tmp));
}

/** Build `dir` aside with `build`, then move it over `dir`. */
async function publishAside(
  fsWrite: PublishingFsWrite,
  dir: string,
  build: (tmp: string) => Promise<void>,
): Promise<void> {
  const tmp = `${dir}.tmp`;
  await fsWrite.remove(tmp);
  await build(tmp);
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
