/**
 * The delete decision, as a pure function — the idempotent semantics,
 * the identity-race-informative response, and the "no API weight" rule
 * pinned in the domain, not invented ad hoc in the store or commands.
 *
 * `artifact_delete` is the agents' hygiene operation (the earlier
 * rejection was reversed: agents share one OS user and always had shell
 * rm; the tool makes deletion scoped, attributed and logged). Its
 * contract here:
 * - Deleting an ABSENT artifact is a no-op SUCCESS (`deleted: false`) —
 *   a cleanup flow racing a teammate's must not error on the second
 *   delete, and `{deleted:false}` already tells the caller everything an
 *   error would.
 * - The response carries the artifact's `versionCount`/`createdAt` when
 *   it existed — the fields that make the identity race VISIBLE instead
 *   of silent (a cleaner seeing a young artifact it just deleted knows a
 *   resurrection happened and looks again).
 * - No expected-version / CAS machinery: the identity race (delete →
 *   resurrect → retry kills the NEW artifact) is accepted for MVP, and
 *   this module is where that acceptance lives.
 */
import type { ExistingArtifact } from "./publish";

/** What delete returns, mirroring the manifest's decision-relevant slice
 * (createdAt joins ExistingArtifact's fields here — the informative
 * no-op needs it). */
export interface DeletableArtifact extends ExistingArtifact {
  createdAt: number;
}

export type DeletePlan =
  | { deleted: true; versionCount: number; createdAt: number }
  | { deleted: false; versionCount: null; createdAt: null };

/** Plan one delete. Pure: absence is a legitimate answer, not an error —
 * the store's NotFound-is-absence rule, stated for the write path. */
export function planDelete(existing: DeletableArtifact | null): DeletePlan {
  if (existing === null) {
    return { deleted: false, versionCount: null, createdAt: null };
  }
  return {
    deleted: true,
    versionCount: existing.versionCount,
    createdAt: existing.createdAt,
  };
}
