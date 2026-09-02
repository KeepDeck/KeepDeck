import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { artifactChanges } from "../../app/artifacts/changes";
import {
  artifactsEnableStatus,
  refusalOf,
} from "../../app/artifacts/enableStatus";
import { openArtifactByRef } from "../../app/artifacts/entryPoints";
import {
  artifactDelete,
  artifactList,
  type ArtifactMetaRow,
} from "../../ipc/artifacts";
import { writeText } from "../../ipc/clipboard";
import { describeError } from "../../ipc/log";
import { viewOf, type ArtifactsView } from "./view";

/** How long a copied-id acknowledgement stays on its row. */
const COPIED_ACK_MS = 1500;

/** A deletion the user has been asked about, and the row it was asked
 * about — the stamp is what makes the answer belong to that row and not
 * merely to its id. */
interface ArtifactConfirm {
  id: string;
  title: string;
  updatedAt: number;
  versionCount: number;
}

export interface ArtifactsRegistry {
  /** What the body shows — the classification lives in [`viewOf`]. */
  view: ArtifactsView;
  /** The last refusal, in the words of whoever actually knows the reason:
   * the failed enable when the store never opened, otherwise the store
   * itself (its sentences are written to be read). Cleared by the next
   * successful action. */
  error: string | null;
  /** The row an action is in flight for; one at a time. */
  busyId: string | null;
  /** The row whose id sits in the clipboard, until the ack expires. */
  copiedId: string | null;
  /** The deletion waiting for an answer. The TITLE because that is what
   * the question has to name, and the row's STAMP because an id alone
   * does not identify what the user agreed to delete — see
   * [`requestDelete`]. */
  confirm: ArtifactConfirm | null;
  open(id: string): void;
  copyId(id: string): void;
  /** Ask. Deleting takes every version and cannot be undone, so nothing
   * here deletes without a confirmed answer. */
  requestDelete(id: string): void;
  confirmDelete(): void;
  cancelConfirm(): void;
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
  // The listing carries WHOSE it is. That is what makes "still loading"
  // derivable instead of a state someone has to remember to set: rows are
  // unknown exactly while the ones in hand belong to another workspace.
  // Clearing them on every read instead would blank the list — and
  // collapse the dialog — on each publish, for the few milliseconds a
  // local read takes.
  const [listing, setListing] = useState<{
    ws: string | null;
    rows: readonly ArtifactMetaRow[];
  } | null>(null);
  const rows = listing !== null && listing.ws === workspaceId ? listing.rows : null;
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ArtifactConfirm | null>(null);
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
  // Why the store is shut, when it is. The store cannot say — it knows
  // only that it is closed, and answers everyone with "turn the
  // experiment on first", which is exactly wrong for a user who did.
  const enableRefusal = refusalOf(
    useSyncExternalStore(
      artifactsEnableStatus.subscribe,
      artifactsEnableStatus.last,
      artifactsEnableStatus.last,
    ),
  );

  useEffect(() => {
    if (workspaceId === null) {
      // No workspace, no store to read: an honest empty rather than a
      // list that never lands and reads as "loading" forever.
      setListing({ ws: null, rows: [] });
      setError(null);
      return;
    }
    // A workspace switch (or a re-read) must not be overtaken by the read
    // it replaced: a late answer for the previous workspace would paint
    // another workspace's artifacts under this one's name.
    let live = true;
    void artifactList({ workspaceId })
      .then((listed) => {
        if (!live) return;
        setListing({ ws: workspaceId, rows: listed });
        setError(null);
      })
      .catch((e: unknown) => {
        if (!live) return;
        // The list is UNKNOWN, not empty — a store that refused must not
        // render as a workspace that published nothing.
        setListing({ ws: workspaceId, rows: [] });
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

  const requestDelete = useCallback(
    (id: string) => {
      // The question names the TITLE, so it is read from the row the user
      // pointed at — a row that has since left the list has no question
      // to ask.
      const row = rows?.find((candidate) => candidate.id === id);
      if (row === undefined) return;
      setConfirm({
        id,
        title: row.title,
        updatedAt: row.updatedAt,
        versionCount: row.versionCount,
      });
    },
    [rows],
  );

  // An id is not an identity here: deleting an artifact frees its id, and
  // the next publish under that id is a NEW artifact with a fresh token
  // (the store calls it a resurrection). An agent that deletes and
  // republishes `draft` while the user sits on the question would leave
  // the answer pointing at something they never saw — and the modal
  // blocks the human, not the agent. So the question stands only while
  // its row does, unchanged: any move under it withdraws the question
  // rather than re-aiming it.
  useEffect(() => {
    if (confirm === null || rows === null) return;
    const row = rows.find((candidate) => candidate.id === confirm.id);
    const same =
      row !== undefined &&
      row.updatedAt === confirm.updatedAt &&
      row.versionCount === confirm.versionCount;
    if (!same) setConfirm(null);
  }, [rows, confirm]);

  const cancelConfirm = useCallback(() => setConfirm(null), []);

  const confirmDelete = useCallback(() => {
    if (confirm === null || workspaceId === null) return;
    const { id } = confirm;
    setConfirm(null);
    setBusyId(id);
    void artifactDelete({ workspaceId, slug: id })
      .then((outcome) => {
        setError(null);
        // Announced on the app's one channel rather than dropped from the
        // list here: this surface is not the only one showing the store,
        // and a delete it kept to itself would leave the others lying.
        //
        // Only when something WENT, which is the same rule the agent's
        // delete obeys: deleting is idempotent, and a no-op that claimed
        // the store had changed would send every subscriber to walk it
        // again over nothing.
        if (outcome.deleted) artifactChanges.changed();
      })
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusyId((current) => (current === id ? null : current)));
  }, [confirm, workspaceId]);

  // The enable's reason REPLACES the store's only when the store
  // refused: a live store that failed one open (server down mid-click)
  // has its own answer, and the stale claim story is not it.
  const shownError =
    error !== null && enableRefusal !== null ? enableRefusal : error;

  return {
    view: viewOf(workspaceId, rows, shownError),
    error: shownError,
    busyId,
    copiedId,
    confirm,
    open,
    copyId,
    requestDelete,
    confirmDelete,
    cancelConfirm,
  };
}
