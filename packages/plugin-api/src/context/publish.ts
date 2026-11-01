/**
 * Publishing a directory a plugin builds for its CLI (API 71): the files are
 * written aside and the directory replaced whole, so a CLI starting while it
 * is rebuilt reads the old set or the new one, never half of each — and a
 * file the new set no longer has is gone with the old one.
 *
 * A directory that already holds what it would be made to hold is left as it
 * is (API 76), when the caller lets publishing read: the text of every file
 * written, and where each copy came from, are kept beside them in the
 * directory; what a copy of a staged skills view holds, it says itself — the
 * view's fingerprint file comes along with what it describes. So a skip
 * never stands on a copy older than the words it was published under.
 */
import type { PluginFs, PluginFsWrite } from "./services.ts";

/** The file a staged skills view holds at its top (API 76): a digest of
 * everything else in it, written with it, so every copy of the view says
 * what it holds. Extensionless: no CLI reading the view takes it for a skill. */
export const VIEW_FINGERPRINT_FILE = ".keepdeck-fingerprint";

/** What a published directory keeps of how it was published. Extensionless,
 * like the fingerprint: a CLI loading every `*.md` it finds would take it
 * for its own. */
const STAMP_FILE = ".keepdeck-published";

/** What publishing reads of `services.fs` to tell a directory already holds
 * what it would be made to hold (API 76). */
export type PublishingRead = Pick<PluginFs, "readFile">;

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
  copyOf: string;
}

/** What publishing needs of `services.fsWrite`. */
export type PublishingFsWrite = Pick<PluginFsWrite, "writeFile" | "copyDir" | "remove" | "move">;

/**
 * Make `dir` hold exactly `entries`: built in `<dir>.tmp`, then moved over
 * `dir` (`fsWrite.move` replaces it whole). A build an earlier run left
 * half-done is cleared first. Callers that may publish the same directory
 * concurrently order themselves ([`oneAtATime`]): two builds share the
 * build-aside directory.
 *
 * With `read` (API 76), a `dir` already published with the same `entries` is
 * left as it is — while each copy in it still says what its source says.
 */
export async function publishFiles(
  fsWrite: PublishingFsWrite,
  dir: string,
  entries: readonly (PublishedFile | PublishedCopy)[],
  read?: PublishingRead,
): Promise<void> {
  const copies = entries.flatMap((entry) => ("copyOf" in entry ? [{ at: `${dir}/${entry.path}`, from: entry.copyOf }] : []));
  await publishAside(fsWrite, dir, { read, stamp: stampOf(entries), copies }, async (tmp) => {
    for (const entry of entries) {
      if (entry.path.split("/").some((part) => part === ".." || part === "")) {
        throw new Error(`publishFiles: "${entry.path}" is not a path inside the directory`);
      }
      const at = `${tmp}/${entry.path}`;
      await ("text" in entry ? fsWrite.writeFile(at, entry.text) : fsWrite.copyDir(entry.copyOf, at));
    }
  });
}

/** Make `dir` a copy of the directory `from` (API 74), published like
 * [`publishFiles`]. */
export async function publishCopy(
  fsWrite: PublishingFsWrite,
  dir: string,
  from: string,
  read?: PublishingRead,
): Promise<void> {
  await publishAside(fsWrite, dir, { read, stamp: stampOf([{ copyOf: from }]), copies: [{ at: dir, from }] }, (tmp) =>
    fsWrite.copyDir(from, tmp),
  );
}

/** How a directory is published, as its stamp says it: the text of every
 * file written and where every copy came from. */
function stampOf(entries: readonly (PublishedFile | PublishedCopy | Pick<PublishedCopy, "copyOf">)[]): string {
  return JSON.stringify({ v: 1, entries });
}

/** What tells a published directory is already as asked: a way to read it,
 * the stamp it would get, and each copy in it beside its source. */
interface Published {
  read: PublishingRead | undefined;
  stamp: string;
  copies: readonly { at: string; from: string }[];
}

/** Build `dir` aside with `build`, then move it over `dir` — unless it is
 * already as asked. */
async function publishAside(
  fsWrite: PublishingFsWrite,
  dir: string,
  { read, stamp, copies }: Published,
  build: (tmp: string) => Promise<void>,
): Promise<void> {
  if (read && (await alreadyPublished(read, dir, stamp, copies))) return;
  const tmp = `${dir}.tmp`;
  await fsWrite.remove(tmp);
  await build(tmp);
  if (read) await fsWrite.writeFile(`${tmp}/${STAMP_FILE}`, stamp);
  await fsWrite.move(tmp, dir);
}

/** `dir` was published with `stamp`, and every copy in it holds what its
 * source holds now — a source that says nothing of itself is never taken
 * for the same. */
async function alreadyPublished(
  read: PublishingRead,
  dir: string,
  stamp: string,
  copies: readonly { at: string; from: string }[],
): Promise<boolean> {
  if ((await textOf(read, `${dir}/${STAMP_FILE}`)) !== stamp) return false;
  for (const { at, from } of copies) {
    const said = await textOf(read, `${from}/${VIEW_FINGERPRINT_FILE}`);
    if (said === null || said !== (await textOf(read, `${at}/${VIEW_FINGERPRINT_FILE}`))) return false;
  }
  return true;
}

/** A file's whole text; null for one that is not there, not text, or not
 * read whole — anything but a plain answer means publishing again. */
async function textOf(read: PublishingRead, path: string): Promise<string | null> {
  try {
    const file = await read.readFile(path);
    return file.truncated ? null : file.text;
  } catch {
    return null;
  }
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
