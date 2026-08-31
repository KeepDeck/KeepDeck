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

    watch: () => ({ dispose() {} }),
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
