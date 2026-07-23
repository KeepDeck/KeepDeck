import type { SpawnPlanContext } from "../domain/agents";
import {
  findWorkspace,
  findWorkspaceByRef,
  MAX_PANES,
  paneId,
  type Pane,
} from "../domain/deck";
import type { SessionHandle } from "../domain/journal";
import { describeError, log } from "../ipc/log";
import { mintAgentSeqs } from "./ids";
import { provisionInto, runProvisioning } from "./provisioning";
import { removeWorktree } from "../ipc/worktree";
import { buildForkSpec, dropPaneSpawnSpec } from "./spawnSpecs";
import { useAppRuntime } from "./runtimeContext";
import type { Deck } from "./useDeck";
import { useLiveRefs } from "./useLiveRefs";

/** Where a fork lands: an existing directory (the workspace folder, or an
 * attached worktree), or a NEW worktree the fork provisions first. */
export type ForkTarget =
  | { kind: "dir"; cwd: string }
  | { kind: "worktree"; path: string; branch: string; base?: string };

export interface JournalForkApi {
  /** Fork a journal record into `target` as a new pane of the workspace.
   * Rejects when no plan could be prepared (surgery failures included).
   * `opts.name` names the pane; `opts.branch` stamps a dir-target pane's
   * worktree branch (an attached existing worktree — the spawn dialog knows
   * it, a journal fork doesn't). */
  fork(
    wsId: string,
    record: SessionHandle,
    target: ForkTarget,
    opts?: { name?: string; branch?: string },
  ): Promise<void>;
}

/**
 * Fork-from-journal ([F8]): the agent plugin's `fork.plan` performs its
 * store surgery and yields the spawn args; the pane then lands like any
 * other. None of the recipes need the TARGET directory to exist at
 * plan-build time (surgery touches the agent's store, not the target), so
 * a new-worktree fork builds its plan first and provisions the worktree
 * through the ordinary background runner — the pane shows the provisioning
 * card until the dir lands, then spawns with the cached fork plan.
 *
 * The forked CLI reports its own NEW session id like a fresh spawn, so the
 * pane starts unbound and the journal records the fork when the reporter
 * posts back. Deleted source dirs are fine — forking is exactly the escape
 * hatch for a session whose worktree is gone.
 */
export function useJournalFork(
  deck: Deck,
  ctx: SpawnPlanContext | null,
): JournalForkApi {
  const { plugins } = useAppRuntime();
  const { deckRef, ctxRef, inFlight } = useLiveRefs(deck, ctx);

  const fork = async (
    wsId: string,
    record: SessionHandle,
    target: ForkTarget,
    opts?: { name?: string; branch?: string },
  ): Promise<void> => {
    const spawnCtx = ctxRef.current;
    if (!spawnCtx) throw new Error("Agent spawn context is unavailable");
    const d = deckRef.current;
    const ws = findWorkspace(d.workspaces, wsId);
    if (!ws) return;
    // Double-click guard only — forking the same session repeatedly is
    // legitimate (each fork is a fresh copy), racing two at once is not.
    if (inFlight.current.has(record.sessionId)) return;

    inFlight.current.add(record.sessionId);
    try {
      const pid = paneId(mintAgentSeqs(1));
      // The fork's plugin surgery, caching the fork plan for `pid`. Run against
      // the directory the fork will live in — which for a NEW worktree does not
      // exist until provisioning finishes, so that surgery is deferred to
      // `onResolved` below (opencode's import binds the session's directory to
      // this cwd, so it must be the CREATED worktree, not a path not yet there).
      const forkSurgery = (cwd: string) =>
        buildForkSpec(
          plugins,
          record.agent,
          {
            paneId: pid,
            workspace: { id: ws.id, instance: ws.instance },
            cwd,
            yolo: record.yolo,
            wsSkillRoots: [cwd],
          },
          spawnCtx,
          {
            sessionId: record.sessionId,
            sourceCwd: record.cwd,
            ...(record.transcriptPath !== undefined && {
              transcriptPath: record.transcriptPath,
            }),
          },
        );

      const name = opts?.name?.trim();

      if (target.kind === "dir") {
        // The target already exists — run the surgery up front.
        if (!(await forkSurgery(target.cwd))) {
          dropPaneSpawnSpec(pid);
          throw new Error("Agent could not prepare a fork plan");
        }
        const wsNow = findWorkspaceByRef(deckRef.current.workspaces, {
          id: ws.id,
          instance: ws.instance,
        });
        if (!wsNow) {
          dropPaneSpawnSpec(pid);
          return;
        }
        if (wsNow.panes.length >= MAX_PANES) {
          dropPaneSpawnSpec(pid);
          throw new Error("The workspace is full — close a pane first");
        }
        deckRef.current.addAgentPane(wsNow.id, {
          id: pid,
          agentType: record.agent,
          ...(target.cwd !== wsNow.cwd && { cwd: target.cwd }),
          ...(opts?.branch && { branch: opts.branch }),
          ...(record.yolo && { yolo: true }),
          ...(name && { name }),
        });
        return;
      }

      // New worktree. The pane lands as a provisioning card; the background
      // create resolves it, and only THEN — with the worktree on disk — does
      // the surgery run (from the created worktree), cache its fork plan, and
      // resolve the card, which spawns the terminal with that plan. A surgery
      // failure rolls the worktree back and flips the card to the failed state.
      const wsNow = findWorkspaceByRef(deckRef.current.workspaces, {
        id: ws.id,
        instance: ws.instance,
      });
      if (!wsNow) return;
      if (wsNow.panes.length >= MAX_PANES) {
        throw new Error("The workspace is full — close a pane first");
      }
      const pane: Pane = {
        id: pid,
        agentType: record.agent,
        ...(record.yolo && { yolo: true }),
        ...(name && { name }),
        provisioning: {
          repo: wsNow.cwd,
          path: target.path,
          branch: target.branch,
          ...(target.base !== undefined && { base: target.base }),
          workspace: wsNow.name,
          index: wsNow.panes.length + 1,
        },
      };
      deckRef.current.addAgentPane(wsNow.id, pane);
      const sinks = provisionInto(deckRef.current, wsNow.id);
      void runProvisioning([pane], {
        ...sinks,
        onResolved: async (paneId, worktree) => {
          let built = false;
          try {
            built = await forkSurgery(worktree.cwd);
          } catch (e) {
            log.warn(
              "web:journal",
              `fork surgery after provisioning failed for ${paneId}: ${describeError(e)}`,
            );
          }
          if (!built) {
            dropPaneSpawnSpec(paneId);
            // Roll the just-created worktree back (Retry re-creates cleanly)
            // and surface the failure on the card, rather than spawning a
            // non-fork pane in it.
            await removeWorktree(wsNow.cwd, worktree.cwd, {
              force: true,
              branch: worktree.branch,
            }).catch((err) =>
              log.warn(
                "web:journal",
                `fork rollback failed for ${worktree.cwd}: ${describeError(err)}`,
              ),
            );
            sinks.onFailed(paneId, "Fork could not be prepared");
            return;
          }
          // Fork plan cached — resolving spawns the terminal with it.
          sinks.onResolved(paneId, worktree);
        },
      });
    } catch (error) {
      log.warn(
        "web:journal",
        `fork of ${record.sessionId} failed: ${describeError(error)}`,
      );
      throw error;
    } finally {
      inFlight.current.delete(record.sessionId);
    }
  };

  return { fork };
}
