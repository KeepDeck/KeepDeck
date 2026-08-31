/**
 * The `jsonl` transport: a store that is one JSON value per line.
 *
 * Everything here is about the FRAMING and nothing about any agent — where a
 * line ends, how to carry half of one across a window edge, how to name the
 * position a read stopped at. What a decoded record means is the plugin's,
 * and this file cannot see it.
 *
 * The loop that follows is the one written three times over, once per
 * file-backed plugin, each copy holding the whole file in a string first.
 */

import type { PluginFs } from "./services.ts";
import type {
  ReadOutcome,
  SessionCursor,
  SessionReader,
} from "./sessionRead.ts";

/** How much of the file one window holds. Small enough that a window is
 * never the thing that costs memory, large enough that a multi-megabyte
 * store is tens of reads rather than thousands. */
const CHUNK_BYTES = 256 * 1024;

export interface JsonlRequest {
  /** The store file. */
  path: string;
  /** Continue from where a previous read stopped; omitted = from the start. */
  from?: SessionCursor;
}

/** What a jsonl cursor holds: the byte to resume at — always a line boundary,
 * which is why only this file may mint one — and the file's length when it was
 * minted, the one thing that can tell us the file was rewritten rather than
 * appended to. */
interface JsonlResume {
  byte: number;
  size: number;
}

const CURSOR_PREFIX = "j1";

function encodeCursor(resume: JsonlResume): SessionCursor {
  return `${CURSOR_PREFIX}:${resume.byte}:${resume.size}` as SessionCursor;
}

/** `null` for anything this version cannot read — a cursor from a future
 * shape, or a forged one. The caller turns that into `changed`, which is
 * already the right instruction: start over. */
function decodeCursor(cursor: SessionCursor): JsonlResume | null {
  const parts = String(cursor).split(":");
  if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) return null;
  const byte = Number(parts[1]);
  const size = Number(parts[2]);
  if (!Number.isSafeInteger(byte) || byte < 0) return null;
  if (!Number.isSafeInteger(size) || size < byte) return null;
  return { byte, size };
}

/** UTF-8 length of `text` up to `end` characters, without building the
 * substring — the reader needs byte positions in a file while holding
 * JavaScript strings, and the conversion happens once per stop rather than
 * once per record. */
function utf8Length(text: string, end: number): number {
  let bytes = 0;
  for (let i = 0; i < end; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code < 0xdc00 && i + 1 < end) {
      // A surrogate PAIR is one four-byte character; its second half is
      // consumed here so it is not counted twice.
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

export function createJsonlReader(
  fs: PluginFs,
): SessionReader<JsonlRequest, unknown> {
  return {
    async pull(request, budget, consume): Promise<ReadOutcome> {
      const resume =
        request.from === undefined
          ? { byte: 0, size: 0 }
          : decodeCursor(request.from);
      if (resume === null) {
        return { payloadBytes: 0, items: 0, stopped: "changed" };
      }

      const start = resume.byte;
      /** Where the next window starts — the read's position in the file. */
      let at = start;
      /** The end of the last line this read consumed. Every line boundary is
       * a valid place to resume, so this is what a cursor names. */
      let consumedEnd = start;
      let items = 0;
      /** The tail of a window that ended mid-line, waiting for its rest. */
      let carry = "";
      let carryBytes = 0;
      let sourceBytes: number | undefined;

      const outcome = (stopped: ReadOutcome["stopped"]): ReadOutcome => ({
        payloadBytes: at - start,
        items,
        stopped,
        sourceBytes,
        // A cursor only where there is something left to come back for.
        next:
          stopped === "budget" || stopped === "satisfied"
            ? encodeCursor({ byte: consumedEnd, size: sourceBytes ?? 0 })
            : undefined,
      });

      for (;;) {
        // The budget bounds what is READ, and bounds it EXACTLY: the last
        // window is trimmed to what is left of it rather than overshooting by
        // up to a whole window. Exactness is what lets a budget be compared
        // with the read cap it replaces — an overshoot would hand back a few
        // hundred kilobytes more conversation than before, which is a change
        // in the answer, not in the mechanism. A record longer than the whole
        // budget stops here too, as a carry that never resolves.
        const left = budget.maxPayloadBytes - (at - start);
        if (left <= 0) return outcome("budget");

        const file = await fs.readFile(request.path, {
          maxBytes: Math.min(CHUNK_BYTES, left),
          offset: at,
        });
        sourceBytes = file.size;

        // An append-only store cannot lose bytes it already wrote, so a file
        // shorter than the position we are reading from is a DIFFERENT file.
        // (Growth proves nothing either way and is the normal case — a live
        // session appends between two reads.)
        if (file.size < Math.max(resume.size, at)) return outcome("changed");
        // Not text at all: a store with a NUL byte or a broken encoding. The
        // conversation did not end here, and there is nothing to retry.
        if (file.text === null) return outcome("unreadable");
        // A window that reads nothing yet claims a remainder would spin this
        // loop forever. It cannot happen for a boundary-aligned read of a
        // sane file; refusing to advance is the honest response if it does.
        if (file.truncated && file.readBytes === 0) return outcome("unreadable");

        const buffer = carry + file.text;
        const bufferStart = at - carryBytes;
        at += file.readBytes;

        const lines = buffer.split("\n");
        // A truncated window's last piece is an unfinished line; a final
        // window's last piece is a record that simply lacks its newline, and
        // dropping it would silently lose the newest turn of a live session.
        const complete = file.truncated ? lines.length - 1 : lines.length;
        let chars = 0;

        for (let i = 0; i < complete; i++) {
          const line = lines[i];
          // The separator `split` removed, except after the very last piece,
          // which had none.
          chars += line.length + (i < lines.length - 1 ? 1 : 0);

          // A blank line, and a line the store wrote half of before dying,
          // are both skipped rather than fatal: one damaged record must not
          // cost the conversation around it. The bytes still count — they
          // were read, and the position moves past them.
          if (line.trim() === "") continue;
          let record: unknown;
          try {
            record = JSON.parse(line) as unknown;
          } catch {
            continue;
          }

          // The position advances BEFORE the record is handed over, so a
          // caller that says "enough" gets a cursor pointing past what it
          // already has rather than at it.
          consumedEnd = bufferStart + utf8Length(buffer, chars);
          items += 1;
          if (consume(record) === "enough") return outcome("satisfied");
        }

        if (!file.truncated) {
          consumedEnd = bufferStart + utf8Length(buffer, chars);
          return outcome("exhausted");
        }
        carry = lines[lines.length - 1];
        carryBytes = utf8Length(carry, carry.length);
      }
    },
  };
}
