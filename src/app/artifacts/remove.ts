import { artifactDelete, type ArtifactDeleteResult } from "../../ipc/artifacts";

/** Which artifact, and — when the caller is answering a question about a
 * row it showed — which incarnation of it. */
export interface ArtifactDeleteRef {
  workspaceId: string;
  slug: string;
  expectedGeneration?: string;
}

/**
 * Delete one artifact and tell the app — the ONE place the pair is
 * spelled.
 *
 * Two surfaces delete: a human answering a question in the registry, and
 * an agent running the tool. They differ in everything around the
 * operation — one owns a confirmation and a busy row, the other owns
 * caller resolution and a notification — and in nothing about the
 * operation itself. Assembled separately they had already drifted once:
 * one announced a change after a delete that removed nothing, the other
 * did not.
 *
 * The signal is INJECTED rather than imported, so this owns the rule
 * without owning the wiring: the command layer keeps handing down its
 * own dependency, and neither caller learns a second way to reach the
 * channel.
 */
export async function deleteArtifact(
  ref: ArtifactDeleteRef,
  { changed }: { changed: () => void },
): Promise<ArtifactDeleteResult> {
  const outcome = await artifactDelete(ref);
  // Deleting is idempotent, and a no-op that claimed the store had
  // changed would send every subscriber to walk it again over nothing.
  if (outcome.deleted) changed();
  return outcome;
}
