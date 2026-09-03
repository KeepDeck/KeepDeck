import { formatAge } from "../../domain/usage";
import type {
  ArtifactMetaRow,
  ArtifactVersionRow,
} from "../../ipc/artifacts";

/**
 * A history reads newest first, while the store writes it oldest first —
 * the row above it says "2h ago" about the newest version, and a list
 * that started at v1 would put the oldest line closest to it.
 *
 * A copy, because the store's array is the caller's and reversing in
 * place would rearrange what someone else is holding.
 */
export function versionsNewestFirst(
  versions: readonly ArtifactVersionRow[],
): ArtifactVersionRow[] {
  return [...versions].reverse();
}

/**
 * The row's identity line, in the order it is meant to be read:
 * `auth-flow · v3 · 2h ago`.
 *
 * Split at the id because the id is drawn apart from the rest — it is
 * the durable half, the half that survives a restart and the half a
 * teammate is given, while the address the row opens is not. What
 * decides the line — its order and its separator — is here; the view
 * draws two pieces and chooses nothing.
 */
export function rowMeta(
  row: ArtifactMetaRow,
  now: number,
): { id: string; tail: string } {
  const rest = [`v${row.versionCount}`, formatAge(row.updatedAt, now)];
  return { id: row.id, tail: ` · ${rest.join(" · ")}` };
}
