/**
 * The registry's two reads — what a workspace has published, and one
 * artifact's history — as a PORT the surface is handed, never a transport it
 * chooses for itself.
 *
 * The hook that draws the registry used to import both from `ipc/artifacts`:
 * the one place in this feature where a view model picked its own data
 * source, beside a policy that takes its transport as a port and says why —
 * the wiring site is the one owner of the transport binding, and a default
 * would be a second home for it. The same rule, applied: the port is
 * REQUIRED where it is taken, and bound to IPC exactly once.
 *
 * Open, delete and url resolution are not here: they already go through this
 * layer's own facades (`openArtifactByRef`, `deleteArtifact`).
 */
import {
  artifactList,
  artifactVersions,
  type ArtifactMetaRow,
  type ArtifactVersionRow,
} from "../../ipc/artifacts";

/** The read model, re-exported from the port's home: the surface names the
 * rows it draws without naming the wire they came over. */
export type { ArtifactMetaRow, ArtifactVersionRow };

export interface ArtifactsRegistryReadPort {
  /** Every artifact the workspace holds, newest first as the store sorts. */
  list(args: { workspaceId: string }): Promise<readonly ArtifactMetaRow[]>;
  /** One artifact's versions, oldest first as the store keeps them. */
  versions(args: {
    workspaceId: string;
    slug: string;
  }): Promise<readonly ArtifactVersionRow[]>;
}

/** The port bound to IPC. Built ONCE at the composition root and handed down
 * as the same object: a fresh one per render would be a fresh effect input,
 * and the registry would re-read the store on every paint. */
export function artifactsRegistryReads(): ArtifactsRegistryReadPort {
  return {
    list: (args) => artifactList(args),
    versions: (args) => artifactVersions(args),
  };
}
