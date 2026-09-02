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
  format: "html";
  path?: string;
  content?: string;
  message?: string;
  autoOpen: boolean;
}

export async function artifactPublish(
  payload: ArtifactPublishPayload,
): Promise<PublishIpcResult> {
  return await invoke("artifact_publish", { payload });
}

/** The publish result (mirrors Rust `PublishResult`): urls null while
 * the display server is down — a publish never fails on that. `isNew`
 * rides the IPC (the notification producers) even though the
 * agent-facing wire drops it. */
export interface PublishIpcResult {
  slug: string;
  version: number;
  isNew: boolean;
  url: string | null;
  indexUrl: string | null;
}

/** One list row (mirrors Rust `ArtifactMeta`, camelCase on the wire).
 *
 * No `format`: the Rust struct carries none — the format is pinned in the
 * manifest and rides the READ, not the listing. Declared here it typed as
 * `"html"` a field that arrives `undefined`, which is the shape a
 * consumer cannot defend against. */
export interface ArtifactMetaRow {
  id: string;
  title: string;
  versionCount: number;
  updatedAt: number;
  lastAuthor: string;
}

export async function artifactList(payload: {
  workspaceId: string;
}): Promise<ArtifactMetaRow[]> {
  return await invoke("artifact_list", { payload });
}

/** The read result (mirrors Rust `ReadOutcome`): inline content, or the
 * over-cap arm's size and honest note. Tagged by `kind`. */
export type ArtifactReadResult =
  | {
      kind: "inline";
      id: string;
      version: number;
      title: string;
      format: "html";
      content: string;
      authorLabel: string;
      at: number;
    }
  | {
      kind: "overCap";
      id: string;
      version: number;
      size: number;
      title: string;
      note: string;
    };

export async function artifactRead(payload: {
  workspaceId: string;
  slug: string;
  version?: number;
}): Promise<ArtifactReadResult> {
  return await invoke("artifact_read", { payload });
}

/** The delete result (mirrors Rust `DeleteOutcome`): when nothing was
 * there, `deleted: false` with the counts it would have had. */
export interface ArtifactDeleteResult {
  id: string;
  deleted: boolean;
  versionCount: number | null;
  createdAt: number | null;
}

export async function artifactDelete(payload: {
  workspaceId: string;
  slug: string;
}): Promise<ArtifactDeleteResult> {
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

/** Drop a closing workspace's whole artifact store. Idempotent; called
 * from workspace deletion (the deck model is the only knower of the
 * live workspace set). */
export async function artifactDropWorkspace(wsId: string): Promise<void> {
  await invoke("artifact_drop_workspace", { wsId });
}
