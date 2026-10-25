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
 * links that hold them together. This module is that pure transform, one per
 * opencode generation — their exports differ in shape (forkRecipe.ts says
 * which a pane gets); the exec plumbing lives in `fork.ts`.
 */

/** Base62 so a minted tail is a valid opencode id body. */
const B62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A random base62 string of length `n`, from the injected byte source. */
function randomTail(n: number, bytes: (len: number) => Uint8Array): string {
  const raw = bytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += B62[raw[i] % 62];
  return out;
}

/** opencode's id shape: `<prefix>_<body>` (e.g. `ses_…`, `msg_…`, `prt_…`;
 * the store's synthetic `prt_0000000000_thinking` sentinel carries an extra
 * `_`, hence `_` is allowed in the body). Guards the KEEP-prefix scheme below:
 * if opencode ever changes its id layout, remint fails LOUDLY here (matching
 * the kimi/claude idiom of throwing on store-format drift) instead of silently
 * emitting plausible-but-mis-ordered ids. */
const ID_SHAPE = /^[a-z]{2,5}_[0-9A-Za-z_]{2,}$/;

/**
 * A fresh, globally-unique id that keeps its SORT POSITION. opencode ids are
 * `<prefix>_<sortable-body><random>` (the body encodes creation time+seq, and
 * the store orders a message's parts by id); keeping the leading run and
 * reminting only the tail preserves order while the ~14 random base62 chars
 * make a collision astronomically unlikely. Same length as the original — a
 * length `import` was probe-verified to accept.
 */
export function remintId(old: string, bytes: (len: number) => Uint8Array): string {
  if (!ID_SHAPE.test(old)) {
    throw new Error(`unexpected opencode id layout: ${old}`);
  }
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
  /** Byte source for id minting; defaults to Web Crypto. Injected in tests for
   * deterministic ids. */
  bytes?: (len: number) => Uint8Array;
}

/** An import-ready clone and the id it will have. */
export interface Rekeyed<Document> {
  document: Document;
  newSessionId: string;
}

type Fields = { [key: string]: unknown };

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isListOf = <T>(value: unknown, item: (x: unknown) => x is T): value is T[] =>
  Array.isArray(value) && value.every(item);

const defaultBytes = (len: number) => crypto.getRandomValues(new Uint8Array(len));

/** A fork's title: the source's, marked — and nothing on no title. */
const forkedTitle = (info: Fields): void => {
  if (typeof info.title === "string" && info.title !== "") info.title = `${info.title} (fork)`;
};

/** Fresh ids for a set of messages, minted before any link is rewritten —
 * a link may point forward as well as back. */
function remintAll(ids: readonly string[], bytes: (len: number) => Uint8Array) {
  const map = new Map<string, string>();
  for (const id of ids) map.set(id, remintId(id, bytes));
  return map;
}

/** A link to another message of the conversation, through the map — a link
 * the map does not know would point into the SOURCE conversation, so it is
 * format drift, refused loudly rather than carried over. */
function relink(holder: Fields, key: string, map: ReadonlyMap<string, string>): void {
  const old = holder[key];
  if (typeof old !== "string") return;
  const fresh = map.get(old);
  if (!fresh) throw new Error(`opencode export: ${key} ${old} names no message of this session`);
  holder[key] = fresh;
}

// ── 1.x ────────────────────────────────────────────────────────────────

/** A 1.x export: `{info, messages: [{info, parts}]}`, the session's directory
 * in `info`. Only what the rekey touches is typed; the rest rides along. */
export interface V1Export extends Fields {
  info: Fields & { id: string; directory: string };
  messages: V1Message[];
}
export interface V1Message extends Fields {
  info: Fields & { id: string };
  parts?: (Fields & { id?: unknown })[];
}

const isV1Message = (value: unknown): value is V1Message =>
  isFields(value) &&
  isFields(value.info) &&
  typeof value.info.id === "string" &&
  (value.parts === undefined || isListOf(value.parts, isFields));

export const isV1Export = (value: unknown): value is V1Export =>
  isFields(value) &&
  isFields(value.info) &&
  typeof value.info.id === "string" &&
  typeof value.info.directory === "string" &&
  isListOf(value.messages, isV1Message);

/**
 * The 1.x clone: a fresh id for the session, every message and every part,
 * and every link between them rewritten — `sessionID`, a part's `messageID`,
 * and a message's `parentID` (an assistant's answer names the user turn it
 * answers; left alone, the clone's answers would point into the source).
 * `info.directory` is set to the target so the clone's declared directory is
 * honest; the import's cwd is what actually places it. Pure; the input is
 * not mutated.
 */
export function rekeyExportV1(
  exported: V1Export,
  directory: string,
  opts: RekeyOptions = {},
): Rekeyed<V1Export> {
  const bytes = opts.bytes ?? defaultBytes;
  const document = structuredClone(exported);
  const newSessionId = remintId(document.info.id, bytes);
  document.info.id = newSessionId;
  document.info.directory = directory;
  forkedTitle(document.info);

  const messageIds = remintAll(
    document.messages.map((message) => message.info.id),
    bytes,
  );
  for (const message of document.messages) {
    const fresh = messageIds.get(message.info.id) ?? message.info.id;
    message.info.id = fresh;
    message.info.sessionID = newSessionId;
    relink(message.info, "parentID", messageIds);
    for (const part of message.parts ?? []) {
      if (typeof part.id === "string") part.id = remintId(part.id, bytes);
      if (typeof part.sessionID === "string") part.sessionID = newSessionId;
      if (typeof part.messageID === "string") part.messageID = fresh;
    }
  }
  return { document, newSessionId };
}

// ── 2.x ────────────────────────────────────────────────────────────────

/** A 2.x export: `{info, messages}` with FLAT messages (`messages[].id`, no
 * `info` of their own), the place in `info.location`. */
export interface V2Export extends Fields {
  info: Fields & { id: string; location: Fields };
  messages: (Fields & { id: string })[];
}

const isV2Message = (value: unknown): value is Fields & { id: string } =>
  isFields(value) && typeof value.id === "string" && value.info === undefined;

export const isV2Export = (value: unknown): value is V2Export =>
  isFields(value) &&
  isFields(value.info) &&
  typeof value.info.id === "string" &&
  isFields(value.info.location) &&
  isListOf(value.messages, isV2Message);

/**
 * The 2.x clone: a fresh id for the session and every message — the import
 * refuses a message id the store already has (measured: changing the
 * session's alone fails with a collision). A tool call's `content[].id` and a
 * shell's `shellID` are NOT message ids and stay as they are. The place
 * (`location`, `subpath`, `projectID`) is left to the import's `--directory`,
 * which derives it anew. Pure; the input is not mutated.
 */
export function rekeyExportV2(exported: V2Export, opts: RekeyOptions = {}): Rekeyed<V2Export> {
  const bytes = opts.bytes ?? defaultBytes;
  const document = structuredClone(exported);
  const newSessionId = remintId(document.info.id, bytes);
  document.info.id = newSessionId;
  forkedTitle(document.info);

  const messageIds = remintAll(
    document.messages.map((message) => message.id),
    bytes,
  );
  for (const message of document.messages) {
    message.id = messageIds.get(message.id) ?? message.id;
    // None of today's message types links to another or names its session;
    // should one, it must not point into the source.
    relink(message, "parentID", messageIds);
    if (typeof message.sessionID === "string") message.sessionID = newSessionId;
  }
  return { document, newSessionId };
}
