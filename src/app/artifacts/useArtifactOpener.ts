import { openArtifactByRef } from "./entryPoints";

/** Open the artifact `ref` names in `workspaceId` in the browser: the
 * registry's own ladder resolves its live address at the click. Resolves
 * with the address it opened. */
export type ArtifactOpener = (workspaceId: string, ref: string | null) => Promise<string>;

const open: ArtifactOpener = (workspaceId, ref) => openArtifactByRef(workspaceId, ref);

/** The artifact opener port. Stable across renders. */
export function useArtifactOpener(): ArtifactOpener {
  return open;
}
