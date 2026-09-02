import { formatAge } from "../../domain/usage";
import type { ArtifactMetaRow } from "../../ipc/artifacts";

/**
 * The row's identity line, in the order it is meant to be read:
 * `auth-flow · v3 · 2h ago · support 1`.
 *
 * Split at the id because the id is drawn apart from the rest — it is
 * the durable half, the half that survives a restart and the half a
 * teammate is given, while the address the row opens is not. Everything
 * that decides the line — the order, the separator, and leaving out an
 * author the store does not have rather than printing an empty tail — is
 * here; the view draws two pieces and chooses nothing.
 */
export function rowMeta(
  row: ArtifactMetaRow,
  now: number,
): { id: string; tail: string } {
  const rest = [`v${row.versionCount}`, formatAge(row.updatedAt, now)];
  if (row.lastAuthor !== "") rest.push(row.lastAuthor);
  return { id: row.id, tail: ` · ${rest.join(" · ")}` };
}
