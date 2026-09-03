/**
 * The artifacts entry-points wiring (§D2): producers, the notification
 * router case, and the composition-root registration gate. One owner for
 * the whole "how a human meets an artifact" tail.
 *
 * Producers gate on `isNew` FROM THE IPC RESULT (which carries it) — not
 * the agent-facing wire (which drops it). The router resolves the LIVE
 * URL at click time through the server's identifier-only entry: a dead
 * artifactId falls back to the INDEX; a failed resolution (toggle off,
 * server down) is a silent no-op + log line, never an error dialog off a
 * notification click.
 */
import { describeError, log } from "../../ipc/log";
import { openUrl } from "../../ipc/app";
import { artifactResolveUrls } from "../../ipc/artifacts";
import type {
  NotificationSource,
  NotificationWorkspace,
} from "../../domain/notifications";
import type { WorkspaceInstance } from "../../domain/workspaceInstance";

/** The first-publish / delete notification inputs. */
export interface ArtifactEvent {
  kind: "published" | "deleted";
  workspaceId: string;
  workspaceInstance: WorkspaceInstance;
  slug: string;
  paneLabel: string;
}

/** Build the notification source for one event — identifiers only. */
export function artifactSource(event: ArtifactEvent): Extract<
  NotificationSource,
  { type: "artifacts" }
> {
  return {
    type: "artifacts",
    workspace: {
      id: event.workspaceId,
      instance: event.workspaceInstance,
    },
    ...(event.kind === "published" ? { artifactId: event.slug } : {}),
  };
}

/**
 * Open one artifact by its IDENTITY — the ONE ladder every door climbs.
 *
 * The address is resolved at the moment of the click and never stored:
 * the display server's port is fresh on every launch, so a url a surface
 * kept from last time is a url that answers nothing. `slug === null`
 * names no artifact and goes straight to the workspace index (the
 * delete-built notification source); a named artifact that has since
 * died falls back to the same index.
 *
 * Throws whatever the resolve threw — the notification router swallows
 * it, a dialog shows it, and neither has to know the other's answer.
 */
export async function openArtifactByRef(
  workspaceId: string,
  slug: string | null,
): Promise<string> {
  const resolved = await artifactResolveUrls({ workspaceId }, slug ?? "");
  const target =
    slug === null ? resolved.indexUrl : (resolved.url ?? resolved.indexUrl);
  await openUrl(target);
  return target;
}

/** The click handler for artifacts-sourced notifications. Returns the
 * resolution so tests can assert the fallback ladder without a browser. */
export async function openArtifactFromNotification(
  source: NotificationSource,
  isWorkspaceLive: (workspace: NotificationWorkspace) => boolean,
): Promise<{ opened: string } | { silent: "unresolved" }> {
  if (source.type !== "artifacts") {
    return { silent: "unresolved" };
  }
  if (!isWorkspaceLive(source.workspace)) {
    return { silent: "unresolved" };
  }
  try {
    // The workspace INSTANCE resolves the lifetime first — the reuseable
    // ws-N id alone would resolve a deleted+recreated workspace's store
    // (the wrong generation); every other router case resolves lifetimes
    // via findWorkspaceByRef, and this case owed the same discipline. A
    // stale instance is a silent no-op: the notification outlived its
    // workspace, there is nothing true to open.
    // (The lifetime check lives with the caller's deck knowledge — the
    // workspace existence is verifiable Rust-side too, but the INSTANCE
    // comparison is deck-model knowledge.)
    const opened = await openArtifactByRef(
      source.workspace.id,
      source.artifactId ?? null,
    );
    return { opened };
  } catch (error) {
    // Toggle off, server down, workspace gone — notifications outlive
    // all three. Silent no-op + log; never an error dialog off a click.
    log.warn(
      "web:artifacts",
      `notification click could not resolve: ${describeError(error)}`,
    );
    return { silent: "unresolved" };
  }
}
