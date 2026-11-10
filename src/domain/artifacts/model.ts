/**
 * The artifacts domain vocabulary — the pure model every layer speaks.
 *
 * An artifact is an on-demand visual presentation an agent publishes when
 * the user (or a teammate) asks for something clearer than terminal text:
 * a design mockup, a block diagram, a comparison table. Three roles, one
 * object: presentation for the user, an iteration canvas (republish the
 * same slug, the open page refreshes), and a team-shared object.
 *
 * This module owns what the command layer checks before a request
 * crosses to the store (format, caps) and the shapes it reads back —
 * no IO, no framework, no timestamps minted here (callers stamp `at`).
 * The store (Rust) owns the FORMAT on disk and decides every publish and
 * delete: the slug grammar, minting and collisions are its alone.
 */

/** What an artifact is. One member, and still a named type: the format
 * is written into every manifest, rides the wire and names the version
 * files, so it stays a value that must be CHECKED rather than assumed. */
export type ArtifactFormat = "html";

/** Runtime guard for the JSON/Rust boundary — a type union cannot guard
 * an untrusted payload string, and "md" is now just another word that
 * is not html. */
export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return value === "html";
}

/** One version's manifest entry. `n` is the chain position (1-based);
 * the filename is DERIVED from `{n}` + the artifact's pinned format —
 * there is deliberately no `file` field to hand-edit into a read oracle. */
export interface ArtifactVersionMeta {
  n: number;
  at: number;
  size: number;
  message?: string;
}

/** A version read from the registry has the same fields as its manifest
 * entry; the read orders these oldest first. */
export type ArtifactVersionRow = ArtifactVersionMeta;

/** Caps. `content` is the inline convenience path (rides the bridge as
 * one JSON line — the cap keeps the 30s reply timeout a non-issue);
 * `path` publishes a file the bridge never carries. Claude Code's 16 MiB
 * serves hosted rendering; ours rides a localhost server and a
 * fast-iterating team store, so the caps are deliberately tighter until a
 * real case argues. */
export const TITLE_MAX = 200;
export const MESSAGE_MAX = 500;
export const CONTENT_CAP_BYTES = 256 * 1024;
export const FILE_CAP_BYTES = 2 * 1024 * 1024;

/** A title that fits, or null. Titles interpolate into every surface
 * (template, export header, badge) — the cap bounds the escaping surface.
 * Length counts UNICODE SCALARS (not UTF-16 units): the Rust store's
 * mirror counts chars() — one semantics on both sides of the seam, so
 * a 150-emoji title gets one verdict everywhere. */
export function validateTitle(input: string): string | null {
  const scalars = Array.from(input).length;
  return scalars > 0 && scalars <= TITLE_MAX ? input : null;
}

/** A changelog line that fits, or null (empty string is allowed — an
 * iteration without a message is ordinary). Scalars, like the title. */
export function validateMessage(input: string): string | null {
  return Array.from(input).length <= MESSAGE_MAX ? input : null;
}
