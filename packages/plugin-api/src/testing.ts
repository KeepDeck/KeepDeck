/**
 * Doubles for the contract's own shapes — for tests that stand in for the
 * host, never shipped to a running plugin.
 *
 * Separate entry point (`@keepdeck/plugin-api/testing`) rather than part of
 * the main export, on the same precedent as `unsafe-text`: what a plugin
 * imports at runtime and what its tests import are different lists, and
 * merging them puts test scaffolding on the production surface.
 *
 * The reason this exists at all: three plugins were each building the same
 * answer by hand, and the copies had ALREADY begun to differ — one counted a
 * text's length in code units where the others counted bytes, and every test
 * stayed green because each compared its own wrong number to itself. That is
 * the shape of drift this package's shared text module was created to stop,
 * one floor down: a derivation repeated per plugin is a derivation waiting to
 * disagree with itself.
 */

import type { FsEntry, FsFile, PluginFs } from "./context/services.ts";
import type { PublishingFsWrite } from "./context/publish.ts";

/** The SKILL.md shapes the codec must carry, and the ones it must refuse to
 * re-author — one corpus for the codec's suite and every consumer's. */
export {
  CARRIED as CARRIED_SKILL_FILES,
  REFUSED as REFUSED_SKILL_FILES,
} from "./context/skill.testSupport.ts";
import type { SpeechCapture, SpeechTranscript } from "./context/speech.ts";
import type {
  PluginSessionStore,
  ReadOutcome,
  ReadScope,
  ReadStop,
  SessionCursor,
  SessionFormat,
} from "./context/sessionRead.ts";

/**
 * One `readFile` answer, as the fs service would give it.
 *
 * `fullSize` is the file's length ON DISK when the read came back SHORT —
 * pass it to describe a capped read, omit it for a whole one. Both numbers
 * then follow from that single choice, which is the point: `truncated`,
 * `size` and `readBytes` are three views of one fact, and a double that lets
 * a caller set them independently lets a caller set them inconsistently.
 *
 * Bytes, never code units. The service measures what came off disk, and a
 * double counting characters describes a different world the moment a fixture
 * holds anything but ASCII — quietly, because the assertion beside it would
 * compare the same wrong number to itself.
 */
export function fsFileRead(
  path: string,
  text: string | null,
  fullSize?: number,
): FsFile {
  const readBytes = text === null ? 0 : new TextEncoder().encode(text).length;
  return {
    path,
    text,
    isBinary: false,
    size: fullSize ?? readBytes,
    readBytes,
    truncated: fullSize !== undefined,
  };
}

/**
 * A whole filesystem the size of a variable, honouring the WINDOW contract:
 * a read starts at `offset`, stops at the smaller of the caller's `maxBytes`
 * and this host's own ceiling, drops a character the window cut in half, and
 * reports where it actually stopped.
 *
 * Here rather than in each plugin's tests for the reason this module exists
 * at all: the answer above was hand-built three times and the copies had
 * already begun to disagree. Anything reading a store a window at a time
 * needs this double, and three private copies of window arithmetic would
 * disagree the same way — silently, each test comparing its own wrong number
 * to itself.
 *
 * `ceiling` is the load-bearing parameter. The contract says the host clamps
 * a read to its OWN ceiling, so a tiny one is a LEGITIMATE host — and it puts
 * a window boundary every few bytes, where a reader's whole difficulty lives.
 * Without it, testing what happens at a boundary would need a fixture larger
 * than the real 256 KB window and would exercise one boundary for the price.
 */
export function fsStore(
  files: Record<string, string | Uint8Array>,
  ceiling = 8 * 1024 * 1024,
): PluginFs {
  // Encoded once, not per read: a walk asks for many windows of one file, and
  // re-encoding the whole fixture each time turns a test of the reader into a
  // test of the double.
  const bytes = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    bytes.set(
      path,
      typeof content === "string" ? new TextEncoder().encode(content) : content,
    );
  }

  return {
    readDir: async (path: string): Promise<FsEntry[]> => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const children = new Map<string, FsEntry>();
      for (const [full, content] of bytes) {
        if (!full.startsWith(prefix)) continue;
        const rest = full.slice(prefix.length);
        const cut = rest.indexOf("/");
        const name = cut === -1 ? rest : rest.slice(0, cut);
        children.set(name, {
          name,
          path: `${prefix}${name}`,
          kind: cut === -1 ? "file" : "dir",
          ...(cut === -1 ? { size: content.length, mtime: 0 } : {}),
        });
      }
      if (children.size === 0) throw new Error(`no such directory: ${path}`);
      return [...children.values()];
    },

    readFile: async (path, opts): Promise<FsFile> => {
      const content = bytes.get(path);
      if (content === undefined) throw new Error(`no such file: ${path}`);
      const size = content.length;
      const offset = opts?.offset ?? 0;
      const window = content.subarray(
        offset,
        offset + Math.min(opts?.maxBytes ?? 1024 * 1024, ceiling),
      );
      const truncated = size > offset + window.length;
      const keep = truncated ? withoutDanglingTail(window) : window.length;
      const text = decodeText(window.subarray(0, keep));
      return {
        path,
        text,
        isBinary: text === null,
        size,
        truncated: size > offset + keep,
        readBytes: text === null ? window.length : keep,
      };
    },

    watch: () => ({ ready: Promise.resolve(), dispose() {} }),
  };
}

/** How much of a window is safe to decode: the bytes of a character whose
 * remainder the window cut off are OURS, not the file's, and they come back
 * on the next read. */
function withoutDanglingTail(window: Uint8Array): number {
  for (let back = 1; back <= Math.min(4, window.length); back++) {
    const lead = window[window.length - back];
    if ((lead & 0xc0) === 0x80) continue; // a continuation byte, keep walking
    const needs =
      lead < 0x80 ? 1 : (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : 4;
    return back < needs ? window.length - back : window.length;
  }
  return window.length;
}

/** `null` for a window that is not text — the shape a NUL byte or a broken
 * encoding arrives in. */
function decodeText(window: Uint8Array): string | null {
  if (window.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(window);
  } catch {
    return null;
  }
}

/** A tree of files in memory behind the publishing half of `fsWrite`. */
export interface PublishingTree {
  fsWrite: PublishingFsWrite;
  /** Every file under `dir`, by its path inside it, sorted. */
  files(dir: string): string[];
  /** The text of the file at `path`, if there is one. */
  read(path: string): string | undefined;
}

/**
 * What a directory a plugin publishes ends up HOLDING, under the host's rules
 * for each call: a copy lands only where nothing is, a move replaces its
 * destination whole, a removal takes a whole subtree and is no error when
 * nothing is there. Files only — a directory is what holds them.
 *
 * Here so the plugins that publish a layout assert the layout itself, not
 * the calls that build it: a call list pins one way of building, and passes
 * for a layout that lands in the wrong place.
 */
export function publishingTree(files: Record<string, string> = {}): PublishingTree {
  const tree = new Map(Object.entries(files));
  const under = (dir: string) => [...tree.keys()].filter((path) => path.startsWith(`${dir}/`));
  const take = (path: string) => {
    tree.delete(path);
    for (const inside of under(path)) tree.delete(inside);
  };
  const exists = (path: string) => tree.has(path) || under(path).length > 0;
  return {
    fsWrite: {
      writeFile: async (path, text) => void tree.set(path, text),
      copyDir: async (src, dst) => {
        // The host copies an empty directory too; this double knows a
        // directory only by its files, and says so rather than call it none.
        if (under(src).length === 0) throw new Error(`fsWrite.copyDir: ${src} holds no file this double knows of`);
        if (exists(dst)) throw new Error(`fsWrite.copyDir: ${dst} already exists`);
        for (const path of under(src)) tree.set(`${dst}${path.slice(src.length)}`, tree.get(path) ?? "");
      },
      remove: async (path) => take(path),
      move: async (src, dst) => {
        if (!exists(src)) throw new Error(`fsWrite.move: ${src}: no such entry`);
        const moved = [...(tree.has(src) ? [src] : []), ...under(src)].map((path) => [path, tree.get(path) ?? ""] as const);
        take(src);
        take(dst);
        for (const [path, text] of moved) tree.set(`${dst}${path.slice(src.length)}`, text);
      },
    },
    files: (dir) => under(dir).map((path) => path.slice(dir.length + 1)).sort(),
    read: (path) => tree.get(path),
  };
}

/**
 * One transcript, as the speech service would give it. Pass `text` for a
 * spoken hold, or `silenceReason` for a silent one — `silence` follows from
 * which (they are one fact), and the measurements default to a clean, short
 * hold on a well-behaved microphone. Override any measurement explicitly.
 */
export function speechTranscript(
  partial: Partial<Omit<SpeechTranscript, "silence">> = {},
): SpeechTranscript {
  const silenceReason = partial.silenceReason ?? (partial.text ? null : "no-speech");
  return {
    text: "",
    seconds: 1.2,
    level: 0.05,
    peak: 0.4,
    clippedRatio: 0,
    dcOffset: 0,
    device: "Test Microphone",
    cutShort: false,
    ...partial,
    silenceReason,
    silence: silenceReason !== null,
  };
}

/**
 * One capture handle, as `startCapture` would resolve it: recording from a
 * connected test microphone unless told otherwise. Pass the `stop` / `cancel`
 * a test scripts; an unscripted `stop` rejects, so a test cannot pass by
 * accident on a transcript it never set up.
 */
export function speechCapture(partial: Partial<SpeechCapture> = {}): SpeechCapture {
  return {
    device: "Test Microphone",
    deviceMissing: false,
    stop: async () => {
      throw new Error("speechCapture: stop was not scripted");
    },
    cancel: async () => {},
    ...partial,
  };
}

/**
 * `value`, when it is there; a test failure that names `what` when it is
 * not.
 *
 * What a test meant by `x!`: "this element, entry or match must exist". The
 * non-null assertion only told the compiler so — a missing one then failed a
 * line later as "cannot read properties of undefined", naming nothing. This
 * says what was expected, where it was expected.
 */
export function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}, found none`);
  return value;
}

/** A cursor the suites speak as a plain string; the brand is the boundary's,
 * not the test's. */
export function cursorOf(value: string): SessionCursor;
export function cursorOf(value: string): string {
  return value;
}

/** A session store as `fakeSessionStore` builds it: the service, the reads
 * it served and the scope each one asked for. */
export interface FakeSessionStore extends PluginSessionStore {
  reads: number;
  readonly scopes: (ReadScope | undefined)[];
}

/**
 * A session store that hands over the records it was given and ends the way
 * it was told to — for a test of what a reader DOES with records and with
 * the reason a read ended (a walk, a plugin's history). The records are
 * already decoded: a format and its windows are the reader's own suite.
 *
 * A read the consumer stops comes back `satisfied` with a cursor; one that
 * runs out of records ends `stopped`, with `sourceBytes` when given — so a
 * `budget` end over a large `sourceBytes` is a store the host's budget cut
 * short, at no cost of bytes.
 */
export function fakeSessionStore(
  records: unknown[],
  stopped: ReadStop = "exhausted",
  sourceBytes?: number,
  refused?: number,
): FakeSessionStore {
  const store: FakeSessionStore = {
    reads: 0,
    scopes: [],
    async read<Req, Item>(
      _format: SessionFormat<Req, Item>,
      _request: Req,
      consume: (item: Item) => "more" | "enough",
      scope?: ReadScope,
    ): Promise<ReadOutcome> {
      store.reads += 1;
      store.scopes.push(scope);
      let items = 0;
      for (const record of records) {
        items += 1;
        if (Reflect.apply(consume, undefined, [record]) === "enough") {
          return {
            payloadBytes: 10,
            items,
            stopped: "satisfied",
            sourceBytes,
            next: cursorOf("j1:10:20"),
          };
        }
      }
      return { payloadBytes: 10, items, ...(refused ? { refused } : {}), stopped, sourceBytes };
    },
  };
  return store;
}

// --------------------------------------------------------------- values

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A record a test is about to read fields from, or a failure naming what was
 * expected. */
export function recordOf(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected ${what}, found ${typeof value}`);
  return value;
}

export function maybeRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** A list a test is about to map, or a failure naming what was expected. */
export function listOf(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected ${what}, found ${typeof value}`);
  return [...value];
}

/** A list of records a test is about to read fields from. */
export function recordsOf(value: unknown, what: string): Record<string, unknown>[] {
  return listOf(value, what).map((item) => recordOf(item, what));
}

export function stringOf(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`expected ${what} to be a string`);
  return value;
}

export function numberOf(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`expected ${what} to be a finite number`);
  }
  return value;
}

export function booleanOf(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") throw new Error(`expected ${what} to be a boolean`);
  return value;
}

/** The `sessionId` of each record in a list. */
export function sessionIds(value: unknown, what = "session records"): string[] {
  return recordsOf(value, what).map((record) =>
    stringOf(record.sessionId, "session id"),
  );
}

/** The element matched by `selector` in `root`, proven to be a `ctor`. */
export function elementOf<T extends Element>(
  root: ParentNode,
  selector: string,
  ctor: abstract new (...args: never[]) => T,
): T {
  return instanceOf(root.querySelector(selector), ctor, selector);
}

/** Every element matched by `selector` in `root`, each proven to be a `ctor`. */
export function elementsOf<T extends Element>(
  root: ParentNode,
  selector: string,
  ctor: abstract new (...args: never[]) => T,
): T[] {
  return [...root.querySelectorAll(selector)].map((found) =>
    instanceOf(found, ctor, selector),
  );
}

/** `value` proven to be a `ctor`, for a node a test already found. */
export function instanceOf<T>(
  value: unknown,
  ctor: abstract new (...args: never[]) => T,
  what: string,
): T {
  if (!(value instanceof ctor)) throw new Error(`expected ${what} to be a ${ctor.name}`);
  return value;
}
