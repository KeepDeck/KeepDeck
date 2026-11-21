/**
 * Putting a workspace away, as the person asks for it: a confirm first —
 * always, by the person's decision — then the orchestrator's archive.
 *
 * The confirm opens once the lifecycle machine has said what the archive
 * would stop (`lifecycle_preview`), as Close does; an archive the machine
 * would not take now is said at once, with no confirm. The confirm is a
 * TRANSACTION, like Close: it holds the keyboard and sits over every dialog.
 * What it says is `archiveConfirmView`'s, read live, so a workspace archived
 * or closed elsewhere while the confirm stands takes the confirm down with it
 * instead of asking about something no longer there.
 */
import { useRef, useState } from "react";
import { findWorkspace, findWorkspaceByRef, type Workspace } from "../domain/deck";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import type { Intent } from "../ipc/generated/lifecycle/Intent";
import type { Preview } from "../ipc/generated/lifecycle/Preview";
import { archiveConfirmView, archiveRefusalText, type ArchiveConfirmView } from "../presentation/archiveView";
import type { AgentOrchestrator } from "./agentOrchestrator";

const REFUSED_TITLE = "Can't archive this workspace";

export interface ArchiveFlow {
  /** The confirm standing, or null. */
  confirming: ArchiveConfirmView | null;
  request(wsId: string): void;
  confirm(): void;
  cancel(): void;
}

export function useArchiveFlow(deps: {
  workspaces: Workspace[];
  /** What the machine would do with an archive: the agents it stops, or why
   * it would refuse it now. */
  preview(intent: Intent): Promise<Preview>;
  archive: AgentOrchestrator["archive"];
  onRefused(title: string, message: string): void;
}): ArchiveFlow {
  const [asked, setAsked] = useState<{ ref: WorkspaceRef; stopping: number } | null>(null);
  // The ask whose preview may still open the confirm: a later request, a
  // cancel or a confirm makes any answer still out a stale one.
  const latest = useRef(0);
  const target = asked ? findWorkspaceByRef(deps.workspaces, asked.ref) : undefined;
  const live = asked && target && !target.archived ? target : null;
  const settle = () => {
    latest.current += 1;
    setAsked(null);
  };
  return {
    confirming: live && asked ? archiveConfirmView(live, asked.stopping) : null,
    request(wsId) {
      const ws = findWorkspace(deps.workspaces, wsId);
      if (!ws || ws.archived) return;
      settle();
      const ask = latest.current;
      const ref = { id: ws.id, instance: ws.instance };
      const { name } = ws;
      void deps.preview({ kind: "archive", workspace: ws.id }).then((preview) => {
        if (ask !== latest.current) return;
        if (preview.refusal) {
          const refusal = archiveRefusalText({ kind: "refused", refusal: preview.refusal }, name);
          if (refusal) deps.onRefused(REFUSED_TITLE, refusal);
          return;
        }
        setAsked({ ref, stopping: preview.stops.length });
      });
    },
    confirm() {
      settle();
      if (!live) return;
      const { name } = live;
      void deps.archive({ id: live.id, instance: live.instance }).then((outcome) => {
        const refusal = archiveRefusalText(outcome, name);
        if (refusal) deps.onRefused(REFUSED_TITLE, refusal);
      });
    },
    cancel: settle,
  };
}
