import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { artifactChanges } from "../../app/artifacts/changes";
import {
  artifactsEnableStatus,
  refusalOf,
} from "../../app/artifacts/enableStatus";
import { openArtifactByRef } from "../../app/artifacts/entryPoints";
import { deleteArtifact } from "../../app/artifacts/remove";
import {
  artifactList,
  artifactVersions,
  type ArtifactMetaRow,
  type ArtifactVersionRow,
} from "../../ipc/artifacts";
import { writeText } from "../../ipc/clipboard";
import { describeError } from "../../ipc/log";
import { fateOf, type RowRef } from "./rowRef";
import { viewOf, type ArtifactsView } from "./view";

/** How long a copied-id acknowledgement stays on its row. */
const COPIED_ACK_MS = 1500;

/** A deletion the user has been asked about, and WHICH row it was asked
 * about ([`RowRef`]) — plus the title, because that is what the question
 * has to name. */
interface ArtifactConfirm extends RowRef {
  title: string;
}

/** An open history, and WHICH row it belongs to. The versions are null
 * while the read is still out. */
interface ArtifactHistory extends RowRef {
  versions: readonly ArtifactVersionRow[] | null;
}

export interface ArtifactsRegistry {
  /** What the body shows — the classification lives in [`viewOf`]. */
  view: ArtifactsView;
  /** The row an action is in flight for; one at a time. */
  busyId: string | null;
  /** The row whose id sits in the clipboard, until the ack expires. */
  copiedId: string | null;
  /** The open history, or null. Iteration history is the shape of an
   * artifact, and until now only agents could see it. */
  expanded: ArtifactHistory | null;
  /** The deletion waiting for an answer, or null. What it carries and
   * why is [`ArtifactConfirm`]'s to say. */
  confirm: ArtifactConfirm | null;
  open(id: string): void;
  copyId(id: string): void;
  /** Open one row's history, or close the open one. */
  toggleVersions(id: string): void;
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
  const [expanded, setExpanded] = useState<ArtifactHistory | null>(null);
  /** Which history read the answers on the wire belong to. */
  const historyAsk = useRef(0);
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
        // A refresh that failed leaves the rows it could not refresh ON
        // SCREEN — they are the last thing the store did say, and a
        // transient read failure must not swap a readable list for a
        // placeholder. Only a workspace that never answered falls to
        // empty, where the refusal becomes the whole body: a store that
        // refused must never render as one that published nothing.
        setListing((current) =>
          current !== null && current.ws === workspaceId
            ? current
            : { ws: workspaceId, rows: [] },
        );
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

  const toggleVersions = useCallback(
    (id: string) => {
      const row = rows?.find((candidate) => candidate.id === id);
      if (workspaceId === null || row === undefined) return;
      // Every answer and every failure below is stamped with the ask it
      // belongs to. An id is not enough: the same row can be opened,
      // closed and opened again while a read is out, and the first
      // answer would then fill the second disclosure with a history
      // taken before the change that prompted it.
      const ask = (historyAsk.current += 1);
      // One open at a time: a second row's history replaces the first's
      // rather than growing the dialog into a list of lists.
      if (expanded?.id === id) {
        setExpanded(null);
        return;
      }
      const ref: RowRef = { workspaceId, id, generation: row.generation };
      setExpanded({ ...ref, versions: null });
      void artifactVersions({ workspaceId, slug: id })
        .then((history) => {
          if (ask !== historyAsk.current) return;
          setExpanded({ ...ref, versions: history });
        })
        .catch((e: unknown) => {
          // A refusal belongs to the ask that earned it: shown after the
          // user moved on, it is a foreign error over someone else's row.
          if (ask !== historyAsk.current) return;
          setExpanded(null);
          setError(describeError(e));
        });
    },
    [workspaceId, expanded, rows],
  );

  const requestDelete = useCallback(
    (id: string) => {
      // The question names the TITLE, so it is read from the row the user
      // pointed at — a row that has since left the list has no question
      // to ask.
      const row = rows?.find((candidate) => candidate.id === id);
      if (row === undefined || workspaceId === null) return;
      setConfirm({
        workspaceId,
        id,
        title: row.title,
        generation: row.generation,
      });
    },
    [rows, workspaceId],
  );

  // A question about a row that is no longer there is a question about
  // nothing: withdraw it rather than re-aim it. Asking again costs one
  // press, against a deletion that cannot be undone.
  //
  // This is the KIND half. It cannot be the safe half — whatever a list
  // says is already the past by the time an answer travels, and the read
  // that would notice is still in flight while the user presses. What
  // makes the answer safe is the store comparing the same generation
  // under the guard it deletes with; this only keeps a stale question
  // off the screen.
  useEffect(() => {
    if (confirm !== null && fateOf(confirm, workspaceId, rows) === "gone") {
      setConfirm(null);
    }
    // The same rule for the same reason: a history is a row held open
    // across an await, and a row that left takes its history with it —
    // otherwise ws-1's versions reappear under ws-2's artifact of the
    // same name, or under the resurrection that replaced it.
    if (expanded !== null && fateOf(expanded, workspaceId, rows) === "gone") {
      historyAsk.current += 1;
      setExpanded(null);
    }
  }, [rows, confirm, expanded, workspaceId]);

  const cancelConfirm = useCallback(() => setConfirm(null), []);

  const confirmDelete = useCallback(() => {
    if (confirm === null) return;
    // SYNCHRONOUSLY, not via the effect above: `workspace.switch` is an
    // agent command, so the workspace under an open dialog can change
    // between the question and the answer, and the effect that notices
    // runs a render later. Answering then would delete the other
    // workspace's artifact of the same name.
    if (confirm.workspaceId !== workspaceId) {
      setConfirm(null);
      return;
    }
    const { id, generation } = confirm;
    setConfirm(null);
    setBusyId(id);
    void deleteArtifact(
      { workspaceId: confirm.workspaceId, slug: id, expectedGeneration: generation },
      { changed: artifactChanges.changed },
    )
      .then(() => setError(null))
      .catch((e: unknown) => setError(describeError(e)))
      .finally(() => setBusyId((current) => (current === id ? null : current)));
  }, [confirm, workspaceId]);

  // The enable's reason REPLACES the store's only when the store
  // refused: a live store that failed one open (server down mid-click)
  // has its own answer, and the stale claim story is not it.
  const shownError =
    error !== null && enableRefusal !== null ? enableRefusal : error;

  return {
    // The ONE place a refusal is placed: as the whole body when there is
    // nothing else to show, as a banner over rows when there is. The
    // view renders the arm it is given and never combines the two facts
    // itself.
    view: viewOf(workspaceId, rows, shownError),
    busyId,
    copiedId,
    expanded,
    confirm,
    open,
    copyId,
    toggleVersions,
    requestDelete,
    confirmDelete,
    cancelConfirm,
  };
}
