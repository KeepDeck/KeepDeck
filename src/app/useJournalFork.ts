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
import {
  provisionInto,
  registerPostProvision,
  runProvisioning,
} from "./provisioning";
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
 * Fork-from-journal ([F8]): the agent plugin's `fork.plan` performs its store
 * surgery and yields the spawn args; the pane then lands like any other. The
 * surgery runs bound to the directory the fork will LIVE in — for a DIR target
 * that exists up front, but for a NEW worktree only AFTER provisioning creates
 * it (via a registered post-provision step), because opencode's `import` binds
 * the session's directory to the launch cwd, which must be the created
 * worktree. The pane shows a provisioning card until the worktree lands, then
 * spawns with the cached fork plan; the step runs on Retry too.
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
      // create lands the worktree, and only THEN does the surgery run — as a
      // registered post-provision step, bound to the CREATED worktree, so
      // opencode's import relocates the session there. The step runs on the
      // initial create AND on Retry (both go through provisionPane), which
      // rolls the worktree back and fails the card if the surgery throws.
      const wsNow = findWorkspaceByRef(deckRef.current.workspaces, {
        id: ws.id,
        instance: ws.instance,
      });
      if (!wsNow) return;
      // A full workspace would make addAgentPane a silent no-op — stranding a
      // provisioned, ownerless worktree on disk.
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
      // Throwing (via forkSurgery's !built guard) makes provisionPane treat it
      // as a failed step: roll back the worktree and fail the card.
      registerPostProvision(pid, async (worktree) => {
        if (!(await forkSurgery(worktree.cwd))) {
          throw new Error("Agent could not prepare a fork plan");
        }
      });
      deckRef.current.addAgentPane(wsNow.id, pane);
      void runProvisioning([pane], provisionInto(deckRef.current, wsNow.id));
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
