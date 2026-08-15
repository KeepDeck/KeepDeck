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
import type { NotificationSource } from "../../domain/notifications";
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

/** The click handler for artifacts-sourced notifications. Returns the
 * resolution so tests can assert the fallback ladder without a browser. */
export async function openArtifactFromNotification(
  source: NotificationSource,
): Promise<{ opened: string } | { silent: "unresolved" }> {
  if (source.type !== "artifacts") {
    return { silent: "unresolved" };
  }
  try {
    const resolved = await artifactResolveUrls({
      workspaceId: source.workspace.id,
    }, source.artifactId ?? "");
    const target =
      (source.artifactId !== undefined && resolved.url) ||
      resolved.indexUrl;
    await openUrl(target);
    return { opened: target };
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
