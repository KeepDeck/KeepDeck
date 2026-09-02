import type { ArtifactMetaRow } from "../../ipc/artifacts";

/**
 * What the registry's body shows — the presentation model, decided away
 * from the markup.
 *
 * Five states that look alike from the outside: no workspace, a read
 * still out, a store that refused, a workspace with nothing in it, and
 * rows. Telling them apart is a decision, not a rendering. Left in the
 * JSX it was a chain of ternaries that the next state would have to be
 * threaded into by hand, beside the elements it also lays out, and with
 * no way to check the classification without a DOM.
 */
export type ArtifactsView =
  | { kind: "noWorkspace" }
  | { kind: "loading" }
  /** The store said why it cannot answer; its words, verbatim. */
  | { kind: "refusal"; message: string }
  | { kind: "empty" }
  | { kind: "rows"; rows: readonly ArtifactMetaRow[] };

/**
 * Which of the five, from the three facts that decide it.
 *
 * The order is the meaning. Rows outrank a failure, so a read that fails
 * while a list is up leaves the list readable and lets the banner carry
 * the news; and a refusal outranks emptiness, so a store that could not
 * answer is never read as a workspace that has published nothing.
 */
export function viewOf(
  workspaceId: string | null,
  rows: readonly ArtifactMetaRow[] | null,
  error: string | null,
): ArtifactsView {
  if (workspaceId === null) return { kind: "noWorkspace" };
  if (rows === null) return { kind: "loading" };
  if (rows.length > 0) return { kind: "rows", rows };
  if (error !== null) return { kind: "refusal", message: error };
  return { kind: "empty" };
}
