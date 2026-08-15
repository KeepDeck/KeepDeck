/**
 * The artifacts notification producers (§D2's producer half): one
 * notification per FIRST publish of a NEW artifact, one per delete call;
 * republish is badge-only (the publish command's own note carries the
 * iteration news; the center must not stack it).
 *
 * The producers ride the command layer, not the store: they read the
 * publish result's `isNew` (D2's rule — from the IPC result, which
 * carries it) and the delete outcome, and they know the workspace
 * lifetime for the typed source.
 */
import { notify } from "../notificationCenter";
import { artifactSource, type ArtifactEvent } from "./entryPoints";

export interface ProducerDeps {
  workspaces: () =>
    | readonly { id: string; name: string }[]
    | null;
}

/** Announce one artifact event: first-publish or delete. Republish never
 * arrives here (the command layer calls this only on isNew / deleted). */
export function announceArtifact(
  event: ArtifactEvent,
  deps: ProducerDeps,
): void {
  const ws = deps
    .workspaces()
    ?.find((w) => w.id === event.workspaceId);
  const wsName = ws?.name ?? event.workspaceId;
  const source = artifactSource(event);
  if (event.kind === "published") {
    notify({
      title: `${event.paneLabel} published an artifact`,
      body: `${event.slug} · ${wsName} — click to open it in the browser`,
      source,
      tag: `artifacts:${event.workspaceId}:${event.slug}`,
    });
    return;
  }
  notify({
    title: `${event.paneLabel} removed an artifact`,
    body: `${event.slug} · ${wsName}`,
    source,
    tag: `artifacts:${event.workspaceId}:${event.slug}`,
  });
}
