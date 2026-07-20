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
   * Rejects when no plan could be prepared (surgery failures included). */
  fork(wsId: string, record: SessionHandle, target: ForkTarget): Promise<void>;
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
      const targetCwd = target.kind === "dir" ? target.cwd : target.path;
      const built = await buildForkSpec(
        plugins,
        record.agent,
        {
          paneId: pid,
          workspace: { id: ws.id, instance: ws.instance },
          cwd: targetCwd,
          yolo: record.yolo,
          wsSkillRoots: [targetCwd],
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
      if (!built) {
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
      // A full workspace would make addAgentPane a silent no-op — stranding
      // the plan and, on the worktree path, provisioning an ownerless
      // worktree on disk.
      if (wsNow.panes.length >= MAX_PANES) {
        dropPaneSpawnSpec(pid);
        throw new Error("The workspace is full — close a pane first");
      }
      if (target.kind === "dir") {
        deckRef.current.addAgentPane(wsNow.id, {
          id: pid,
          agentType: record.agent,
          ...(target.cwd !== wsNow.cwd && { cwd: target.cwd }),
          ...(record.yolo && { yolo: true }),
        });
        return;
      }
      // New worktree: the pane joins as a provisioning card; the background
      // create resolves it (or flips it to the failed card with Retry), and
      // only then does the terminal spawn with the cached fork plan.
      const pane: Pane = {
        id: pid,
        agentType: record.agent,
        ...(record.yolo && { yolo: true }),
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
