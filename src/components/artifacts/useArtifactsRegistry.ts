import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { artifactChanges } from "../../app/artifacts/changes";
import { openArtifactByRef } from "../../app/artifacts/entryPoints";
import { artifactList, type ArtifactMetaRow } from "../../ipc/artifacts";
import { writeText } from "../../ipc/clipboard";
import { describeError } from "../../ipc/log";

/** How long a copied-id acknowledgement stays on its row. */
const COPIED_ACK_MS = 1500;

export interface ArtifactsRegistry {
  /** The workspace's artifacts, or `null` while the first read is still
   * out — an empty list must not claim "nothing published" before the
   * store has answered. */
  rows: readonly ArtifactMetaRow[] | null;
  /** The last refusal, verbatim from the store (its sentences are written
   * to be read: "artifact store is off — turn the artifacts experiment on
   * first"). Cleared by the next successful action. */
  error: string | null;
  /** The row an action is in flight for; one at a time. */
  busyId: string | null;
  /** The row whose id sits in the clipboard, until the ack expires. */
  copiedId: string | null;
  open(id: string): void;
  copyId(id: string): void;
}

/**
 * The artifacts registry's machine: what the workspace has published, and
 * the two things a human does with a row.
 *
 * Why a registry exists at all — an artifact's URL carries the display
 * server's port, which is fresh on every launch, so an address that left
 * this app is an address that stops answering. The durable half is the
 * IDENTITY (workspace + id), and this surface is the door that turns one
 * back into a live url at the moment of the click, through the shared
 * [`openArtifactByRef`] ladder. Nothing here stores a url.
 *
 * The view renders; every transition lives here (the SkillsDialog /
 * useSkillsEditor split, applied to a much smaller machine).
 */
export function useArtifactsRegistry(
  workspaceId: string | null,
): ArtifactsRegistry {
  const [rows, setRows] = useState<readonly ArtifactMetaRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every publish and delete this app makes bumps the revision, which is
  // the read's other input — so the list follows the store instead of
  // waiting to be asked. There is no refresh control by design: the
  // writer is in this process, and a button would be the user doing what
  // the app already knows.
  const revision = useSyncExternalStore(
    artifactChanges.subscribe,
    artifactChanges.revision,
    artifactChanges.revision,
  );

  useEffect(() => {
    if (workspaceId === null) {
      // No workspace, no store to read: an honest empty rather than a
      // list that never lands and reads as "loading" forever.
      setRows([]);
      setError(null);
      return;
    }
    // A workspace switch (or a refresh) must not be overtaken by the read
    // it replaced: a late answer for the previous workspace would paint
    // another workspace's artifacts under this one's name.
    let live = true;
    setRows(null);
    void artifactList({ workspaceId })
      .then((listed) => {
        if (!live) return;
        setRows(listed);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        // The list is UNKNOWN, not empty — a store that refused must not
        // render as a workspace that published nothing.
        setRows([]);
        setError(describeError(e));
      });
    return () => {
      live = false;
    };
  }, [workspaceId, revision]);

  useEffect(
    () => () => {
      if (ackTimer.current !== null) clearTimeout(ackTimer.current);
    },
    [],
  );

  const open = useCallback(
    (id: string) => {
      if (workspaceId === null) return;
      setBusyId(id);
      void openArtifactByRef(workspaceId, id)
        .then(() => setError(null))
        .catch((e: unknown) => setError(describeError(e)))
        .finally(() => setBusyId((current) => (current === id ? null : current)));
    },
    [workspaceId],
  );

  const copyId = useCallback((id: string) => {
    void writeText(id)
      .then(() => {
        setError(null);
        setCopiedId(id);
        if (ackTimer.current !== null) clearTimeout(ackTimer.current);
        ackTimer.current = setTimeout(() => setCopiedId(null), COPIED_ACK_MS);
      })
      .catch((e: unknown) => setError(describeError(e)));
  }, []);

  return { rows, error, busyId, copiedId, open, copyId };
}
