import type { AgentType } from "../domain/agents";
import { makePanes, makeProvisioningPanes, type Pane } from "../domain/deck";

/**
 * Optimistic provisioning, planning half: panes land in the deck the moment
 * they're asked for — in worktree mode as status cards carrying their create
 * intent — and nothing here awaits before the user sees them. Performing the
 * actual `git worktree add`s, and reporting each result into the deck as it
 * settles, is the worktree manager's ([`app/worktrees`]); this module holds the
 * pieces the manager is driven WITH: what to plan, where to report, and how the
 * workspace's setup command is packaged.
 */

/** Where the background runner reports as each pane's create settles. */
export interface ProvisionCallbacks {
  onResolved(paneId: string, worktree: { cwd: string; branch: string }): void;
  onFailed(paneId: string, error: string): void;
  /** The worktree exists; the workspace's setup command started in it. */
  onSetup?(paneId: string): void;
  /**
   * Has the pane left the deck? A no-op sink is not enough to answer this:
   * `onResolved` silently doing nothing looks exactly like success from here,
   * and the create needs to KNOW, because everything it does after the
   * directory exists is done on that pane's behalf.
   */
  abandoned(paneId: string): boolean;
}

/** The runner's usual sinks: the deck's provisioning actions for `wsId`.
 * Both no-op inside the reducer when the pane was closed mid-create. */
export function provisionInto(
  deck: {
    resolvePaneProvisioning(
      wsId: string,
      paneId: string,
      worktree: { cwd: string; branch: string },
    ): void;
    setPaneProvisioningError(
      wsId: string,
      paneId: string,
      error: string | null,
    ): void;
    setPaneProvisioningPhase(wsId: string, paneId: string, phase: "setup"): void;
    /** Is this pane still in the deck? Read live — the create outlives the
     * render that started it. */
    hasPane(wsId: string, paneId: string): boolean;
  },
  wsId: string,
): ProvisionCallbacks {
  return {
    onResolved: (paneId, worktree) =>
      deck.resolvePaneProvisioning(wsId, paneId, worktree),
    onFailed: (paneId, error) =>
      deck.setPaneProvisioningError(wsId, paneId, error),
    onSetup: (paneId) => deck.setPaneProvisioningPhase(wsId, paneId, "setup"),
    abandoned: (paneId) => !deck.hasPane(wsId, paneId),
  };
}

/**
 * Build `count` panes for a workspace, synchronously. In worktree mode each
 * pane carries its create intent (a status card until the manager's `provision`
 * resolves it); otherwise plain panes that run in the workspace cwd.
 */
export function planPanes(
  ws: { cwd: string; worktreeBaseDir: string | null; name: string },
  startSeq: number,
  count: number,
  agentType: AgentType,
  yolo = false,
): Pane[] {
  if (!ws.worktreeBaseDir) return makePanes(startSeq, count, agentType, yolo);
  return makeProvisioningPanes(
    startSeq,
    count,
    agentType,
    {
      cwd: ws.cwd,
      baseDir: ws.worktreeBaseDir,
      name: ws.name,
    },
    yolo,
  );
}

/**
 * The workspace's one-time preparation for ONE created worktree: run it, and
 * say whether it passed with the output tail for the card.
 *
 * A step the caller supplies rather than something built here, because it
 * occupies the pane's own process slot — and that slot has one owner. Build
 * one with [`setupStepFor`].
 */
export type SetupStep = (
  paneId: string,
  worktree: { cwd: string; branch: string },
) => Promise<{ ok: boolean; tail: string }>;

/**
 * The workspace's setup command as a step, bound to the env contract below
 * and to `run` — the caller's way of occupying a pane's slot.
 *
 * The pane's OWN slot is the point: sessions are keyed by pane id, so closing
 * the pane mid-setup kills the whole process group like any other session,
 * and the pane's terminal takes the slot over cleanly afterwards.
 */
export function setupStepFor(
  command: string,
  run: (
    paneId: string,
    spec: {
      command: null;
      args: string[];
      env: [string, string][];
      cwd: string;
      cols: number;
      rows: number;
    },
  ) => Promise<{ ok: boolean; tail: string }>,
): SetupStep {
  return (paneId, worktree) =>
    run(paneId, {
      command: null, // the user's shell
      args: ["-c", command],
      env: setupEnv(worktree.cwd, worktree.branch),
      cwd: worktree.cwd,
      cols: 80,
      rows: 24,
    });
}

/** The workspace env contract for the one-time setup command: the same
 * KEEPDECK_* variables every run surface provides (the Run plugin implements
 * the identical contract for its presets — two independent implementers of
 * one stable convention). Setup runs at create time, before any port
 * allocation, so KEEPDECK_PORT is deliberately absent here. */
function setupEnv(worktree: string, branch?: string): [string, string][] {
  const env: [string, string][] = [["KEEPDECK_WORKTREE", worktree]];
  if (branch) env.push(["KEEPDECK_BRANCH", branch]);
  return env;
}
