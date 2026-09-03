import type { ArtifactMetaRow } from "../../ipc/artifacts";

/**
 * A reference to the row a surface is holding open — a question about it,
 * a history read for it.
 *
 * All three parts are needed and none is spare. The workspace, because
 * `workspace.switch` is an agent command and the one under an open
 * dialog can change without the user. The id, because that is what a
 * surface names. The generation, because an id is not an identity:
 * deleting frees it, and the next publish under it is a different
 * artifact wearing the same name.
 */
export interface RowRef {
  workspaceId: string;
  id: string;
  generation: string;
}

/** Whether what a surface is holding is still what is on screen. */
export type RowFate =
  /** The row is there, unchanged. */
  | "stands"
  /** The rows belong to another workspace, or none has landed yet —
   * nothing is known about this ref either way. */
  | "unknown"
  /** The row it names is not there, or is not the same artifact. */
  | "gone";

/**
 * The ONE answer to "is what I am holding still true", asked by every
 * surface that holds a row across an await — and they all hold one,
 * because every one of them is a question the user takes time over.
 *
 * `unknown` is not `gone` on purpose: a re-read in flight says nothing
 * about the row, and dropping a question the moment a refresh starts
 * would close a dialog under the user's hand every time an agent
 * publishes something else.
 */
export function fateOf(
  ref: RowRef,
  workspaceId: string | null,
  rows: readonly ArtifactMetaRow[] | null,
): RowFate {
  if (ref.workspaceId !== workspaceId) return "gone";
  if (rows === null) return "unknown";
  const row = rows.find((candidate) => candidate.id === ref.id);
  if (row === undefined || row.generation !== ref.generation) return "gone";
  return "stands";
}
