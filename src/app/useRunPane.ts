import { paneId, type Pane } from "../domain/panes";
import { buildRunPlan } from "../domain/spawnPlans";
import { describeError, log } from "../ipc/log";
import { allocatePorts } from "../ipc/ports";
import { mintAgentSeq } from "./ids";
import { closePane } from "./ptyManager";
import { setPaneSpawnSpec } from "./spawnSpecs";
import type { Deck } from "./useDeck";

/** Where a run pane executes: the worktree (and branch) of the pane whose ▶
 * launched it — a run pane runs NEXT TO its agent, in the same directory. */
export interface RunLocation {
  cwd?: string;
  branch?: string;
}

/** What to run: a preset (id + its command snapshot) or an ad-hoc line. */
export interface RunRequest {
  presetId?: string;
  command: string;
  /** Pane title; the preset name, or the command itself for ad-hoc runs. */
  name: string;
}

/**
 * Launching and re-running run panes (experimental run presets). The port is
 * allocated BEFORE the pane lands so its spawn plan (pre-registered in the
 * spec cache, like a revive's resume plan) carries the full env contract;
 * allocation failure degrades to a plan without `KEEPDECK_PORT` — the command
 * still runs, and a preset that needed the port fails visibly in its own
 * terminal.
 */
export function useRunPane(deck: Deck) {
  /** Launch `request` in a fresh run pane next to `source`. */
  const launch = async (
    wsId: string,
    source: RunLocation,
    request: RunRequest,
  ): Promise<void> => {
    const ws = deck.workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const id = paneId(mintAgentSeq());
    const worktree = source.cwd ?? ws.cwd;
    const port = await allocatePorts(worktree).catch((e) => {
      log.warn("web:run", `port allocation failed for ${worktree}: ${describeError(e)}`);
      return undefined;
    });
    setPaneSpawnSpec(
      id,
      buildRunPlan(request.command, { worktree, branch: source.branch, port }),
    );
    const pane: Pane = {
      id,
      name: request.name,
      run: {
        command: request.command,
        ...(request.presetId && { presetId: request.presetId }),
      },
      ...(source.cwd && { cwd: source.cwd }),
      ...(source.branch && { branch: source.branch }),
    };
    log.info("web:run", `${id}: launch "${request.command}" in ${worktree} (port ${port ?? "-"})`);
    deck.addAgentPane(wsId, pane);
  };

  /**
   * Run a run pane's command (again): the dormant tile's Run and the exit
   * card's Restart. Closes whatever PTY entry the pane still holds, puts a
   * live pane to sleep so its terminal unmounts, re-registers a fresh plan
   * (new port probe — the old block may have been taken meanwhile), and
   * revives. The remount is what respawns.
   */
  const runAgain = async (wsId: string, paneId: string): Promise<void> => {
    const ws = deck.workspaces.find((w) => w.id === wsId);
    const pane = ws?.panes.find((p) => p.id === paneId);
    if (!ws || !pane?.run) return;
    await closePane(paneId);
    if (!pane.dormant) deck.sleepPane(wsId, paneId);
    const worktree = pane.cwd ?? ws.cwd;
    const port = await allocatePorts(worktree).catch(() => undefined);
    setPaneSpawnSpec(
      paneId,
      buildRunPlan(pane.run.command, { worktree, branch: pane.branch, port }),
    );
    log.info("web:run", `${paneId}: run again "${pane.run.command}" (port ${port ?? "-"})`);
    deck.revivePane(wsId, paneId);
  };

  return { launch, runAgain };
}
