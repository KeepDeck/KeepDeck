import { invoke } from "@tauri-apps/api/core";

/**
 * The artifacts feature's Rust surface — the enable pair (§B11: the
 * store claim and the display server ride together) and the artifact_*
 * command handlers (§D1: identity is host fact in the payload, never an
 * agent argument). Throws on failure — callers decide how loudly to
 * react; a store refusal sentence is designed to be agent-readable.
 */

/** Claim the artifacts store root and start the display server
 * (idempotent). Resolves to the display server's port. */
export async function artifactsEnable(): Promise<number> {
  return await invoke<number>("artifacts_enable");
}

/** Tear the display server down (bye to open pages) and release the
 * store claim. Idempotent. */
export async function artifactsDisable(): Promise<void> {
  await invoke("artifacts_disable");
}

export interface ArtifactPublishPayload {
  workspaceId: string;
  paneId: string;
  label: string;
  cwd: string | null;
  slug?: string;
  title: string;
  format: "html" | "md";
  path?: string;
  content?: string;
  message?: string;
  autoOpen: boolean;
}

export async function artifactPublish(
  payload: ArtifactPublishPayload,
): Promise<unknown> {
  return await invoke("artifact_publish", { payload });
}

export async function artifactList(payload: {
  workspaceId: string;
}): Promise<unknown> {
  return await invoke("artifact_list", { payload });
}

export async function artifactRead(payload: {
  workspaceId: string;
  slug: string;
  version?: number;
}): Promise<unknown> {
  return await invoke("artifact_read", { payload });
}

export async function artifactDelete(payload: {
  workspaceId: string;
  slug: string;
}): Promise<unknown> {
  return await invoke("artifact_delete", { payload });
}

/** The notification router's identifier-only URL entry (B10): no token
 * in hand — the server resolves via the ws scan. Dead artifact →
 * `url: null` (the router falls back to the index). */
export async function artifactResolveUrls(
  payload: { workspaceId: string },
  slug: string,
): Promise<{ url: string | null; indexUrl: string }> {
  return await invoke("artifact_resolve_urls", { payload, slug });
}
