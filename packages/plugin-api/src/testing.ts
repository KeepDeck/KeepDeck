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

import type { FsFile } from "./context/services.ts";

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
