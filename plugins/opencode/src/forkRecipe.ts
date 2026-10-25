import { extractJson, linesOf, tail, type CommandRun } from "./exec";
import {
  isV1Export,
  isV2Export,
  rekeyExportV1,
  rekeyExportV2,
  type Rekeyed,
  type V1Export,
  type V2Export,
} from "./rekey";

/**
 * How one opencode generation forks a session: the commands, the transform
 * between them, and how each command's output is read. fork.ts runs the
 * steps in their order and decides what a failure means; a recipe only knows
 * its generation's words.
 *
 * Neither generation's word is trusted on its own (task-457, measured):
 * - 1.x `import` exits 0 and says `Imported session: <id>` for a real clone,
 *   for a clone that came out EMPTY, and for a re-import of the source's own
 *   id — which silently moved the SOURCE to the import's directory. So 1.x
 *   says only that it claims an import, and the clone is read back.
 * - 2.x `session import` exits 0 on a collision too, saying `Session already
 *   exists` on stderr. Only its exact `Imported session: <id>` is a success.
 */
export interface ForkRecipe<Document> {
  /** The export of `sessionId`, run in the target directory. */
  exportArgs(sessionId: string): readonly string[];
  readExport(run: CommandRun): ExportReading;
  /** The clone, or a throw when the document is not this generation's. */
  rekey(exported: unknown, directory: string): Rekeyed<Document>;
  /** The import of the clone written to `file`, into `directory`. */
  importArgs(file: string, directory: string): readonly string[];
  readImport(run: CommandRun, newSessionId: string): ImportReading;
  /** The deletion of a clone a refused fork imported. */
  deleteArgs(sessionId: string): readonly string[];
  /** How a generation whose import only CLAIMS reads its clone back. */
  verify?: {
    args(newSessionId: string): readonly string[];
    read(run: CommandRun, clone: Rekeyed<Document>, directory: string): Check;
  };
}

export type ExportReading =
  | { kind: "document"; document: unknown }
  /** This opencode has no such session. */
  | { kind: "missing" }
  | { kind: "failed"; detail: string };

export type ImportReading =
  /** Imported: the generation's word is final. */
  | { kind: "imported" }
  /** Claimed: read the clone back before believing it. */
  | { kind: "claimed" }
  /** The id was already taken: what is under it is not this fork's. */
  | { kind: "collision" }
  | { kind: "failed"; detail: string };

export type Check = { ok: true } | { ok: false; detail: string };

const failedRun = (run: CommandRun, what: string) =>
  `opencode ${what} exited ${run.code}: ${tail(run.text)}`;

const failed = (detail: string) => ({ kind: "failed" as const, detail });

/** Whether a command answered with an exit code other than success. A code
 * the PTY could not report is not read as a failure: what was printed
 * decides then. */
const exitedBadly = (run: CommandRun) => run.code !== null && run.code !== 0;

const notFound = (run: CommandRun) =>
  linesOf(run).some((line) => /Session not found/i.test(line));

/** The export's JSON, as this generation's document or as a failure. */
function exported(
  run: CommandRun,
  isDocument: (value: unknown) => boolean,
  generation: string,
): ExportReading {
  if (exitedBadly(run)) {
    return notFound(run) ? { kind: "missing" } : failed(failedRun(run, "export"));
  }
  let document: unknown;
  try {
    document = JSON.parse(extractJson(run.text));
  } catch {
    return failed(`opencode export printed no session: ${tail(run.text)}`);
  }
  return isDocument(document)
    ? { kind: "document", document }
    : failed(`opencode export did not print a ${generation} session`);
}

/** Whether the output says exactly this success line. */
const said = (run: CommandRun, line: string) => linesOf(run).includes(line);

/** `/private/tmp` and `/tmp` are one directory on macOS, and 1.x records
 * the canonical one (measured: an import run in `/tmp/…` records
 * `/private/tmp/…`). */
const sameDirectory = (recorded: string, asked: string) =>
  recorded === asked || recorded === `/private${asked}`;

/** A message 1.x may leave out of a clone: an answer that never finished
 * (export and import carry only what was written whole). */
const unfinished = (message: V1Export["messages"][number]) => {
  const time = message.info.time;
  return (
    message.info.role === "assistant" &&
    !(typeof time === "object" && time !== null && "completed" in time && time.completed)
  );
};

export const recipeV1: ForkRecipe<V1Export> = {
  exportArgs: (sessionId) => ["export", sessionId],
  readExport: (run) => exported(run, isV1Export, "1.x"),
  rekey(document, directory) {
    if (!isV1Export(document)) throw new Error("opencode export is not a 1.x session");
    return rekeyExportV1(document, directory);
  },
  // 1.x records the directory the import runs IN; fork.ts runs it there.
  importArgs: (file) => ["import", file],
  readImport(run, newSessionId) {
    if (exitedBadly(run)) return failed(failedRun(run, "import"));
    return said(run, `Imported session: ${newSessionId}`)
      ? { kind: "claimed" }
      : failed(`opencode import did not import ${newSessionId}: ${tail(run.text)}`);
  },
  deleteArgs: (sessionId) => ["session", "delete", sessionId],
  // What a clone must be to be believed: the three ways 1.x was measured to
  // claim an import it did not make — an empty clone, a re-import that moved
  // the source, a clone placed elsewhere — fail one of these. Parts are
  // reminted, so the import cannot quietly keep half of them.
  verify: {
    args: (newSessionId) => ["export", newSessionId],
    read(run, clone, directory) {
      const reading = exported(run, isV1Export, "1.x");
      if (reading.kind !== "document" || !isV1Export(reading.document)) {
        return { ok: false, detail: "the clone could not be read back" };
      }
      const landed = reading.document;
      if (landed.info.id !== clone.newSessionId) {
        return { ok: false, detail: `the clone read back as ${landed.info.id}` };
      }
      if (!sameDirectory(landed.info.directory, directory)) {
        return { ok: false, detail: `the clone landed in ${landed.info.directory}, not ${directory}` };
      }
      const kept = new Map(landed.messages.map((message) => [message.info.id, message.info]));
      for (const message of clone.document.messages) {
        const got = kept.get(message.info.id);
        if (!got) {
          if (unfinished(message)) continue;
          return { ok: false, detail: `the clone lost message ${message.info.id}` };
        }
        if (got.parentID !== message.info.parentID) {
          return { ok: false, detail: `the clone's message ${message.info.id} answers another turn` };
        }
      }
      return { ok: true };
    },
  },
};

export const recipeV2: ForkRecipe<V2Export> = {
  exportArgs: (sessionId) => ["session", "export", sessionId, "--standalone"],
  readExport: (run) => exported(run, isV2Export, "2.x"),
  rekey(document) {
    if (!isV2Export(document)) throw new Error("opencode export is not a 2.x session");
    return rekeyExportV2(document);
  },
  importArgs: (file, directory) => [
    "session",
    "import",
    file,
    "--directory",
    directory,
    "--standalone",
  ],
  readImport(run, newSessionId) {
    if (said(run, `Imported session: ${newSessionId}`) && !exitedBadly(run)) {
      return { kind: "imported" };
    }
    if (said(run, "Session already exists")) return { kind: "collision" };
    return failed(`opencode session import did not import ${newSessionId}: ${tail(run.text)}`);
  },
  deleteArgs: (sessionId) => ["session", "delete", sessionId, "--standalone"],
};
