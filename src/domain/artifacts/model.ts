/**
 * The artifacts domain vocabulary — the pure model every layer speaks.
 *
 * An artifact is an on-demand visual presentation an agent publishes when
 * the user (or a teammate) asks for something clearer than terminal text:
 * a design mockup, a block diagram, a comparison table. Three roles, one
 * object: presentation for the user, an iteration canvas (republish the
 * same slug, the open page refreshes), and a team-shared object.
 *
 * This module owns the RULES (grammar, caps, shapes) and nothing else —
 * no IO, no framework, no timestamps minted here (callers stamp `at`).
 * The store (Rust) owns the FORMAT on disk; planners in `publish.ts` /
 * `delete.ts` own the decisions; this file is the shared nouns.
 */

/** The two formats an artifact exists in. Pinned at first publish — a
 * republish in the other format is a command error (the manifest carries
 * one format; the extension cross-check and the serving CSP both derive
 * from it, so a mid-chain flip would break both). */
export type ArtifactFormat = "html" | "md";

/** Runtime guard for the JSON/Rust boundary — a type union cannot guard
 * an untrusted payload string. */
export function isArtifactFormat(value: unknown): value is ArtifactFormat {
  return value === "html" || value === "md";
}

/**
 * A human-readable artifact id, referenced in mail ("review artifact
 * auth-flow"). Grammar `[a-z0-9-]{1,64}`: lowercase, digits, dashes —
 * filename-safe on every platform, injection-safe in a
 * Content-Disposition, and stable under the mail-vocabulary rule (a burned
 * slug would turn old mail references into forever-404s, so slugs
 * resurrect rather than tombstone).
 */
export type Slug = string & { readonly __slug: unique symbol };

export const SLUG_MAX = 64;
const SLUG_GRAMMAR = /^[a-z0-9-]{1,64}$/;

/** A string that obeys the slug grammar, or null. Does not derive — a
 * MINTED slug is derived from the title by `mintSlug` (publish.ts); an
 * EXPLICIT one is validated here and nothing else. */
export function validateSlug(input: string): Slug | null {
  return SLUG_GRAMMAR.test(input) ? (input as Slug) : null;
}

/** The identity snapshot recorded on every version. Full, not a bare
 * paneId: pane-N slots are reused, so a bare id is ambiguous after reuse —
 * the label snapshot is what makes an old version's author readable (the
 * journal's precedent). */
export interface IdentitySnapshot {
  paneId: string;
  workspaceId: string;
  label: string;
}

/** One version's manifest entry. `n` is the chain position (1-based);
 * the filename is DERIVED from `{n}` + the artifact's pinned format —
 * there is deliberately no `file` field to hand-edit into a read oracle. */
export interface ArtifactVersionMeta {
  n: number;
  authorPaneId: string;
  authorLabel: string;
  at: number;
  size: number;
  message?: string;
}

/** What `artifact.list` returns per artifact — counts, not arrays:
 * the list is a directory, not a document. */
export interface ArtifactMeta {
  id: Slug;
  title: string;
  format: ArtifactFormat;
  versionCount: number;
  updatedAt: number;
  lastAuthor: string;
}

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
 * (template, export header, badge) — the cap bounds the escaping surface. */
export function validateTitle(input: string): string | null {
  return input.length > 0 && input.length <= TITLE_MAX ? input : null;
}

/** A changelog line that fits, or null (empty string is allowed — an
 * iteration without a message is ordinary). */
export function validateMessage(input: string): string | null {
  return input.length <= MESSAGE_MAX ? input : null;
}
