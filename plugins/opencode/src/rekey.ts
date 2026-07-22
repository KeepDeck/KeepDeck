/**
 * Rekey an opencode session export into a RELOCATING fork clone.
 *
 * opencode's native `-s <id> --fork` copies a session but re-homes it to the
 * SOURCE session's `directory` and drops its project to `global` — the target
 * directory KeepDeck launches it in is ignored (probe-verified, 1.18.4). The
 * portable fork therefore goes through `opencode export → rekey → import`, run
 * FROM the target directory: `import` binds the new session's `directory` to
 * its launch CWD (NOT the JSON's `info.directory`) and re-derives the project
 * from it. So the relocation is driven by the import CWD (see `fork.ts`); this
 * module still sets `info.directory` to the target so the clone's declared
 * directory matches where import places it, but that field is not what moves it.
 *
 * The catch is `import` DEDUPS by global id: a message/part whose `id` already
 * exists in the store is silently skipped (leaving the source untouched — safe,
 * but the clone comes out empty). So a real clone must mint FRESH ids for the
 * session, every message, and every part, rewriting the `sessionID`/`messageID`
 * links that hold them together. This module is that pure transform; the exec
 * plumbing lives in `fork.ts`.
 */

/** The slice of opencode's export JSON this transform touches; everything else
 * rides through untouched via the index signatures. */
export interface OpencodeExport {
  info: OpencodeSessionInfo;
  messages: OpencodeMessage[];
  [key: string]: unknown;
}
export interface OpencodeSessionInfo {
  id: string;
  directory: string;
  title?: string;
  [key: string]: unknown;
}
interface OpencodeMessage {
  info: { id: string; sessionID: string; [key: string]: unknown };
  parts?: OpencodePart[];
  [key: string]: unknown;
}
interface OpencodePart {
  id?: string;
  messageID?: string;
  sessionID?: string;
  [key: string]: unknown;
}

/** Base62 so a minted tail is a valid opencode id body. */
const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A random base62 string of length `n`, from the injected byte source. */
function randomTail(n: number, bytes: (len: number) => Uint8Array): string {
  const raw = bytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += B62[raw[i] % 62];
  return out;
}

/**
 * A fresh, globally-unique id that keeps its SORT POSITION. opencode ids are
 * `<prefix>_<sortable-body><random>` (the body encodes creation time+seq, and
 * the store orders a message's parts by id); keeping the leading run and
 * reminting only the tail preserves order while the ~14 random base62 chars
 * make a collision astronomically unlikely. Same length as the original — a
 * length `import` was probe-verified to accept.
 */
export function remintId(old: string, bytes: (len: number) => Uint8Array): string {
  const KEEP = 16;
  if (old.length <= KEEP + 4) {
    // Degenerate short id: keep the `<prefix>_` and remint the rest.
    const cut = old.indexOf("_");
    const head = cut >= 0 ? old.slice(0, cut + 1) : "";
    return head + randomTail(Math.max(8, old.length - head.length), bytes);
  }
  return old.slice(0, KEEP) + randomTail(old.length - KEEP, bytes);
}

export interface RekeyOptions {
  /** The fork's target directory. Written to `info.directory` so the clone's
   * declared directory is honest; the actual placement comes from the CWD
   * `import` is launched in (fork.ts runs it from the target). */
  directory: string;
  /** Byte source for id minting; defaults to Web Crypto. Injected in tests for
   * deterministic ids. */
  bytes?: (len: number) => Uint8Array;
}

/**
 * Produce the import-ready clone JSON and its new session id. Pure: no IO, the
 * input document is not mutated (a structural copy is returned).
 */
export function rekeyExport(
  exported: OpencodeExport,
  opts: RekeyOptions,
): { rekeyed: OpencodeExport; newSessionId: string } {
  const bytes =
    opts.bytes ?? ((len: number) => crypto.getRandomValues(new Uint8Array(len)));
  const doc = structuredClone(exported);

  const newSessionId = remintId(doc.info.id, bytes);
  doc.info.id = newSessionId;
  doc.info.directory = opts.directory;
  if (typeof doc.info.title === "string" && doc.info.title !== "") {
    doc.info.title = `${doc.info.title} (fork)`;
  }

  // Every message and part gets a fresh id so `import`'s global-id dedup does
  // not skip them; the sessionID/messageID links are rewritten to match.
  const msgIdMap = new Map<string, string>();
  for (const message of doc.messages ?? []) {
    const oldMsgId = message.info.id;
    const newMsgId = remintId(oldMsgId, bytes);
    msgIdMap.set(oldMsgId, newMsgId);
    message.info.id = newMsgId;
    message.info.sessionID = newSessionId;
    for (const part of message.parts ?? []) {
      if (typeof part.id === "string") part.id = remintId(part.id, bytes);
      if (typeof part.sessionID === "string") part.sessionID = newSessionId;
      const mapped = part.messageID && msgIdMap.get(part.messageID);
      if (mapped) part.messageID = mapped;
    }
  }

  return { rekeyed: doc, newSessionId };
}
