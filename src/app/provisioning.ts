import type { AgentType } from "../domain/agents";
import {
  makePanes,
  makeProvisioningPanes,
  type Pane,
  type PaneProvisioning,
  type WorktreeTarget,
} from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { createWorktree, inspectRepo, removeWorktree } from "../ipc/worktree";

/**
 * Optimistic provisioning: panes land in the deck the moment they're asked
 * for — in worktree mode as status cards carrying their create intent — and
 * `runProvisioning` performs the actual `git worktree add`s in the
 * background, reporting each result into the deck as it settles. Nothing
 * here awaits before the user sees their panes.
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
 * Post-provision steps, keyed by pane id: a JS step run AFTER a pane's worktree
 * is created (and setup passed) but BEFORE its card resolves — the seam where a
 * journal fork runs its store surgery bound to the CREATED worktree. It runs on
 * the initial create AND on every Retry (both go through `provisionPane`), so a
 * retried fork re-runs its surgery instead of silently resolving into a plain
 * (non-fork) pane. A step THROWS to fail (the worktree is rolled back and the
 * card fails); it is consumed once it succeeds, and kept across a failed attempt
 * so the retry re-runs it.
 *
 * PERSISTENCE COUPLING (don't miss this): a step lives ONLY in this in-memory
 * map — it cannot survive an app restart. So ANY pane that registers a step
 * MUST also be excluded from persistence, or its card restores as a plain
 * retryable card and Retry resolves a NON-fork pane. The journal fork does this
 * via `PaneProvisioning.fork`, which `serializeDeck` drops; a future second user
 * of this map must add the equivalent.
 */
const postProvisionSteps = new Map<
  string,
  (worktree: { cwd: string; branch: string }) => Promise<void>
>();

/**
 * Panes whose worktree must be REMOVED if and when its create lands, because
 * the pane was closed mid-create and the user asked for the directory to go
 * with it.
 *
 * An intent left for the create to honour, rather than a result the close
 * waits for. The close cannot wait: `git worktree add` has no cancel, and the
 * create's own setup step runs in the pane's session slot — which the close has
 * just reaped, leaving that step's promise unsettleable by design (see
 * `runPaneOnce`). Waiting there deadlocks the close and strands the very
 * worktree it meant to delete.
 *
 * Leaving the intent instead also closes the window a waiting close could not:
 * the pane is registered the moment it is closed, not when the create happens
 * to reach the point of announcing itself.
 */
const discardOnArrival = new Set<string>();

/** Remove `paneId`'s worktree when its in-flight create lands. */
export function discardWorktreeOnArrival(paneId: string): void {
  discardOnArrival.add(paneId);
}

/** Register a step to run after `paneId`'s worktree lands (see the map doc). */
export function registerPostProvision(
  paneId: string,
  step: (worktree: { cwd: string; branch: string }) => Promise<void>,
): void {
  postProvisionSteps.set(paneId, step);
}

/** Forget a pane's post-provision step (the fork was abandoned before it ran). */
export function clearPostProvision(paneId: string): void {
  postProvisionSteps.delete(paneId);
}

/** Run the registered step, if any. Returns null on success (or when none is
 * registered — a plain pane) and the failure message otherwise; a successful
 * step is consumed, a failed one is KEPT so a Retry re-runs it. */
async function runPostProvision(
  paneId: string,
  worktree: { cwd: string; branch: string },
): Promise<string | null> {
  const step = postProvisionSteps.get(paneId);
  if (!step) return null;
  try {
    await step(worktree);
    postProvisionSteps.delete(paneId);
    return null;
  } catch (e) {
    return describeError(e);
  }
}

/**
 * Build `count` panes for a workspace, synchronously. In worktree mode each
 * pane carries its create intent (a status card until `runProvisioning`
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
 * Create the worktrees behind `panes`' provisioning cards, reporting each
 * result as it lands (completion order is whatever the per-repo lock hands
 * out — the deck shows panes coming alive as they're ready). One base commit
 * is pinned for the whole batch so concurrent creates don't straddle a moving
 * HEAD; a pane whose intent carries its own picked `base` forks from that
 * instead. Panes without an intent are ignored, so a retry can pass one pane
 * and the batch flows can pass them all. Never throws: a failure lands on its
 * pane's card via `onFailed`.
 *
 * `setup` is the workspace's one-time preparation command: it runs in each
 * created worktree before the pane resolves, and a failure ROLLS THE WORKTREE
 * BACK (so Retry re-creates from scratch instead of hitting "already exists")
 * and lands on the card with the output tail.
 */
export async function runProvisioning(
  panes: Pane[],
  cb: ProvisionCallbacks,
  setup?: SetupStep,
): Promise<void> {
  const pending = panes.filter((p) => p.provisioning);
  if (pending.length === 0) return;

  let base: string | undefined;
  try {
    base = (await inspectRepo(pending[0].provisioning!.repo)).head ?? undefined;
  } catch {
    base = undefined; // create resolves HEAD itself when base is omitted
  }

  await Promise.all(
    pending.map((p) => provisionPane(p.id, p.provisioning!, base, cb, setup)),
  );
}

/**
 * One pane's create (+ optional setup) → its card resolves or fails, with the
 * worktree it made published for the duration so a close landing mid-create
 * can still find it. Only a create that leaves something ON DISK records a
 * result; every failure path here rolls its own directory back.
 */
async function provisionPane(
  paneId: string,
  intent: PaneProvisioning,
  base: string | undefined,
  cb: ProvisionCallbacks,
  setup?: SetupStep,
): Promise<void> {
  /**
   * The pane left while we were working. Asked after every await that could
   * outlive it, because everything below this point is done ON ITS BEHALF: a
   * setup command would spawn into a session slot the close already reaped,
   * and `onResolved` would hand a worktree to a pane that cannot take it,
   * leaving a directory nothing will ever name again.
   */
  const abandoned = (rec: { path: string; branch: string }): boolean => {
    if (!cb.abandoned(paneId)) return false;
    log.info(
      "web:provisioning",
      `${paneId} left while its worktree was being created` +
        (discardOnArrival.has(paneId) ? " — removing it" : " — keeping it"),
    );
    // Only if the user asked. Closing without ticking the box is a deliberate
    // "keep the worktree", and a create that happened to be slow must not
    // turn that into a delete.
    if (discardOnArrival.delete(paneId)) void rollbackWorktree(intent.repo, rec);
    return true;
  };

  let rec: { path: string; branch: string };
  try {
    rec = await createWorktree({
      repo: intent.repo,
      baseDir: intent.baseDir ?? "",
      agentId: paneId,
      branch: intent.branch,
      // The user's picked base branch outranks the batch-pinned HEAD.
      base: intent.base ?? base,
      workspace: intent.workspace,
      index: intent.index,
      path: intent.path,
    });
  } catch (e) {
    log.error(
      "web:provisioning",
      `worktree create failed for ${paneId}: ${describeError(e)}`,
    );
    cb.onFailed(paneId, describeError(e));
    // Nothing landed, so there is nothing to discard; drop any request so a
    // Retry's create is judged on its own.
    discardOnArrival.delete(paneId);
    return;
  }
  // Before the setup command, not only after: it runs in the pane's session
  // slot, and spawning there once the pane is gone leaves a process with
  // nothing to reap it.
  if (abandoned(rec)) return;

  if (setup) {
    cb.onSetup?.(paneId);
    const result = await setup(paneId, { cwd: rec.path, branch: rec.branch });
    if (!result.ok) {
      log.error(
        "web:provisioning",
        `setup failed for ${paneId} in ${rec.path}: ${result.tail}`,
      );
      await rollbackWorktree(intent.repo, rec);
      cb.onFailed(paneId, `Setup failed: ${result.tail}`);
      discardOnArrival.delete(paneId);
      return;
    }
    if (abandoned(rec)) return;
  }

  // The worktree is on disk — run any registered post-provision step (a journal
  // fork's store surgery, bound to the CREATED worktree). A failure rolls the
  // worktree back and fails the card; the step stays registered, so Retry
  // re-runs it rather than resolving into a plain (non-fork) pane.
  const stepError = await runPostProvision(paneId, {
    cwd: rec.path,
    branch: rec.branch,
  });
  if (stepError !== null) {
    log.error(
      "web:provisioning",
      `post-provision step failed for ${paneId} in ${rec.path}: ${stepError}`,
    );
    await rollbackWorktree(intent.repo, rec);
    cb.onFailed(paneId, stepError);
    discardOnArrival.delete(paneId);
    return;
  }
  // The last gate, with no await between it and the handover: past here the
  // pane owns the worktree and an ordinary close can name it.
  if (abandoned(rec)) return;

  cb.onResolved(paneId, { cwd: rec.path, branch: rec.branch });
}

/** Best-effort teardown of a half-prepared worktree so Retry re-creates cleanly
 * instead of hitting "already exists"; a failing remove leaves the card error as
 * the source of truth. */
async function rollbackWorktree(
  repo: string,
  rec: { path: string; branch: string },
): Promise<void> {
  await removeWorktree(repo, rec.path, {
    force: true,
    branch: rec.branch,
  }).catch((e) =>
    log.warn(
      "web:provisioning",
      `worktree rollback failed for ${rec.path}: ${describeError(e)}`,
    ),
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

/**
 * Tear down each target's git worktree and branches when the close dialog's
 * delete checkbox was ticked. Always forced — the checkbox is explicit intent,
 * so a dirty worktree / unmerged branch is discarded per the user's decision;
 * the same intent covers every branch the agent CREATED in the worktree, not
 * just the tracked one (side branches would otherwise pile up dead). Never
 * throws: a failing target is collected so one bad worktree doesn't strand the
 * rest, and the messages surface in the error dialog.
 */
export async function discardWorktrees(
  targets: WorktreeTarget[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const t of targets) {
    try {
      await removeWorktree(t.repo, t.path, {
        force: true,
        branch: t.branch,
        reapCreatedBranches: true,
      });
    } catch (e) {
      log.warn("web:provisioning", `worktree discard failed for ${t.path}: ${describeError(e)}`);
      failures.push(`${t.branch ?? t.path}: ${e}`);
    }
  }
  return failures;
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
