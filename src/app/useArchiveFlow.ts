/**
 * Putting a workspace away, as the person asks for it: a confirm first —
 * always, by the person's decision — then the orchestrator's archive.
 *
 * The confirm is a TRANSACTION, like Close: it holds the keyboard and sits
 * over every dialog. What it says is `archiveConfirmView`'s, read live, so a
 * workspace archived or closed elsewhere while the confirm stands takes the
 * confirm down with it instead of asking about something no longer there.
 */
import { useState } from "react";
import { findWorkspace, findWorkspaceByRef, type Workspace } from "../domain/deck";
import type { WorkspaceRef } from "../domain/workspaceInstance";
import { archiveConfirmView, archiveRefusalText, type ArchiveConfirmView } from "../presentation/archiveView";
import type { AgentOrchestrator } from "./agentOrchestrator";

export interface ArchiveFlow {
  /** The confirm standing, or null. */
  confirming: ArchiveConfirmView | null;
  request(wsId: string): void;
  confirm(): void;
  cancel(): void;
}

export function useArchiveFlow(deps: {
  workspaces: Workspace[];
  archive: AgentOrchestrator["archive"];
  onRefused(title: string, message: string): void;
}): ArchiveFlow {
  const [asked, setAsked] = useState<WorkspaceRef | null>(null);
  const target = asked ? findWorkspaceByRef(deps.workspaces, asked) : undefined;
  const live = target && !target.archived ? target : null;
  return {
    confirming: live ? archiveConfirmView(live) : null,
    request(wsId) {
      const ws = findWorkspace(deps.workspaces, wsId);
      if (ws && !ws.archived) setAsked({ id: ws.id, instance: ws.instance });
    },
    confirm() {
      setAsked(null);
      if (!live) return;
      const { name } = live;
      void deps.archive({ id: live.id, instance: live.instance }).then((outcome) => {
        const refusal = archiveRefusalText(outcome, name);
        if (refusal) deps.onRefused("Can't archive this workspace", refusal);
      });
    },
    cancel: () => setAsked(null),
  };
}
