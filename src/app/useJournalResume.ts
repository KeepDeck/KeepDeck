import { useRef } from "react";
import type { SpawnPlanContext } from "../domain/agents";
import {
  findWorkspace,
  findWorkspaceByRef,
  MAX_PANES,
  paneId,
  type Pane,
} from "../domain/deck";
import type { SessionRecord } from "../domain/journal";
import { describeError, log } from "../ipc/log";
import { mintAgentSeqs } from "./ids";
import {
  buildResumeSpec,
  dropPaneSpawnSpec,
  peekPaneSpawnSpec,
} from "./spawnSpecs";
import { useAppRuntime } from "./runtimeContext";
import type { Deck } from "./useDeck";

export interface JournalResumeApi {
  /** Resume a journal record into a new pane of its workspace. Rejects when
   * no plan could be prepared; a quiet no-op when the record's session is
   * already running somewhere. */
  resume(wsId: string, record: SessionRecord): Promise<void>;
}

/**
 * Resume-from-journal ([F8]): mint a pane for a recorded session and spawn
 * it with the agent plugin's `resume.plan` — the manual-restart mechanism,
 * minus the pre-existing pane. The plan is built and cached BEFORE the pane
 * enters the deck, so the ordinary fresh-plan sweep never races it (the
 * revive pattern), and the pane arrives already carrying `session`, which
 * claims the journal record back to live in the same transition.
 *
 * `resumeOrigin: "manual"` deliberately: a rejected id fails visibly in the
 * terminal and stays exited — a user-requested continuation must never
 * silently degrade into a fresh conversation.
 */
export function useJournalResume(
  deck: Deck,
  ctx: SpawnPlanContext | null,
): JournalResumeApi {
  const { plugins } = useAppRuntime();
  const inFlight = useRef(new Set<string>());
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const resume = async (wsId: string, record: SessionRecord): Promise<void> => {
    const spawnCtx = ctxRef.current;
    if (!spawnCtx) throw new Error("Agent spawn context is unavailable");
    if (record.state === "live") return;
    const d = deckRef.current;
    const ws = findWorkspace(d.workspaces, wsId);
    if (!ws) return;
    // A session runs in at most one pane, ever — if some pane (any
    // workspace) already holds this binding, there is nothing to do.
    const claimed = d.workspaces.some((w) =>
      w.panes.some((p) => p.session?.id === record.sessionId),
    );
    if (claimed || inFlight.current.has(record.sessionId)) return;

    inFlight.current.add(record.sessionId);
    try {
      const pid = paneId(mintAgentSeqs(1));
      const built = await buildResumeSpec(
        plugins,
        record.agent,
        {
          paneId: pid,
          workspace: { id: ws.id, instance: ws.instance },
          cwd: record.cwd,
          branch: record.branch,
          yolo: record.yolo,
          // The pane isn't in the deck yet, so its cwd can't come from
          // `skillRootsOf` — stage it explicitly.
          wsSkillRoots: [record.cwd],
        },
        spawnCtx,
        record.sessionId,
        "manual",
      );
      const spec = peekPaneSpawnSpec(pid);
      if (!built || spec?.resumeOf !== record.sessionId) {
        dropPaneSpawnSpec(pid);
        throw new Error("Agent could not prepare a resume plan");
      }
      // The workspace may have died during the async build (same instance
      // check as restart — a reused ws id must not adopt the pane).
      const wsNow = findWorkspaceByRef(deckRef.current.workspaces, {
        id: ws.id,
        instance: ws.instance,
      });
      if (!wsNow) {
        dropPaneSpawnSpec(pid);
        return;
      }
      // Re-check what could have changed during the await: the session may
      // have been claimed (a concurrent revive), and a full workspace would
      // make addAgentPane a silent no-op that strands the built plan.
      const claimedNow = deckRef.current.workspaces.some((w) =>
        w.panes.some((p) => p.session?.id === record.sessionId),
      );
      if (claimedNow) {
        dropPaneSpawnSpec(pid);
        return;
      }
      if (wsNow.panes.length >= MAX_PANES) {
        dropPaneSpawnSpec(pid);
        throw new Error("The workspace is full — close a pane first");
      }
      const pane: Pane = {
        id: pid,
        agentType: record.agent,
        // A cwd of the workspace's own dir is the plain-pane default; only a
        // foreign dir (the session's worktree) pins the pane, restoring the
        // exact shape the original pane had.
        ...(record.cwd !== wsNow.cwd && { cwd: record.cwd }),
        ...(record.branch !== undefined && { branch: record.branch }),
        ...(record.yolo && { yolo: true }),
        session: { id: record.sessionId, boundAt: new Date().toISOString() },
      };
      deckRef.current.addAgentPane(wsNow.id, pane);
    } catch (error) {
      log.warn(
        "web:journal",
        `resume of ${record.sessionId} failed: ${describeError(error)}`,
      );
      throw error;
    } finally {
      inFlight.current.delete(record.sessionId);
    }
  };

  return { resume };
}
