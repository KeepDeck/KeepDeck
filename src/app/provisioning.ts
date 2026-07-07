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
import { acquirePane, attachPane, closePane } from "./ptyManager";

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
  },
  wsId: string,
): ProvisionCallbacks {
  return {
    onResolved: (paneId, worktree) =>
      deck.resolvePaneProvisioning(wsId, paneId, worktree),
    onFailed: (paneId, error) =>
      deck.setPaneProvisioningError(wsId, paneId, error),
    onSetup: (paneId) => deck.setPaneProvisioningPhase(wsId, paneId, "setup"),
  };
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
): Pane[] {
  if (!ws.worktreeBaseDir) return makePanes(startSeq, count, agentType);
  return makeProvisioningPanes(startSeq, count, agentType, {
    cwd: ws.cwd,
    baseDir: ws.worktreeBaseDir,
    name: ws.name,
  });
}

/**
 * Create the worktrees behind `panes`' provisioning cards, reporting each
 * result as it lands (completion order is whatever the per-repo lock hands
 * out — the deck shows panes coming alive as they're ready). One base commit
 * is pinned for the whole batch so concurrent creates don't straddle a moving
 * HEAD. Panes without an intent are ignored, so a retry can pass one pane and
 * the batch flows can pass them all. Never throws: a failure lands on its
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
  setup?: string,
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

/** One pane's create (+ optional setup) → its card resolves or fails. */
async function provisionPane(
  paneId: string,
  intent: PaneProvisioning,
  base: string | undefined,
  cb: ProvisionCallbacks,
  setup?: string,
): Promise<void> {
  let rec: { path: string; branch: string };
  try {
    rec = await createWorktree({
      repo: intent.repo,
      baseDir: intent.baseDir ?? "",
      agentId: paneId,
      branch: intent.branch,
      base,
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
    return;
  }

  if (setup) {
    cb.onSetup?.(paneId);
    const result = await runSetup(paneId, rec.path, rec.branch, setup);
    if (!result.ok) {
      log.error(
        "web:provisioning",
        `setup failed for ${paneId} in ${rec.path}: ${result.tail}`,
      );
      // Roll the half-prepared worktree back; best-effort — a failing remove
      // leaves the card error as the source of truth and Retry surfaces the
      // "already exists" from the next create.
      await removeWorktree(intent.repo, rec.path, {
        force: true,
        branch: rec.branch,
      }).catch((e) =>
        log.warn(
          "web:provisioning",
          `setup rollback failed for ${rec.path}: ${describeError(e)}`,
        ),
      );
      cb.onFailed(paneId, `Setup failed: ${result.tail}`);
      return;
    }
  }
  cb.onResolved(paneId, { cwd: rec.path, branch: rec.branch });
}

/** Output tail kept for the failed card — enough to see the actual error. */
const SETUP_TAIL_CHARS = 600;

/** ANSI escapes and control bytes have no place on a status card. */
function plainText(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x09\x0b-\x1f]/g, "");
}

/**
 * Run the setup command in the created worktree, through the pane's own PTY
 * slot: `ptyManager` keys sessions by pane id, so closing the pane mid-setup
 * kills the setup's whole process group like any other session — nothing to
 * leak. The entry is released on completion; the pane's terminal (a different
 * spawn identity) then takes the slot over cleanly. If the pane IS closed
 * mid-setup the promise never settles — its `runProvisioning` chain dies with
 * it, which is exactly right: there is no card left to report to.
 */
function runSetup(
  paneId: string,
  worktree: string,
  branch: string,
  command: string,
): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    let tail = "";
    // Assigned below; the default covers a sink that settles before
    // `attachPane` returns (a replayed exit).
    let detach: () => void = () => {};
    const decoder = new TextDecoder();
    const settle = (ok: boolean, note: string) => {
      detach();
      void closePane(paneId);
      resolve({ ok, tail: plainText(note).trim().slice(-SETUP_TAIL_CHARS) });
    };
    acquirePane(paneId, {
      command: null, // the user's shell
      args: ["-c", command],
      env: setupEnv(worktree, branch),
      cwd: worktree,
      cols: 80,
      rows: 24,
    });
    detach = attachPane(paneId, {
      onOutput: (bytes) => {
        tail = (tail + decoder.decode(bytes, { stream: true })).slice(
          -SETUP_TAIL_CHARS * 4,
        );
      },
      onExit: (code) =>
        code === 0
          ? settle(true, "")
          : settle(false, tail || `exit code ${code ?? "?"}`),
      onSpawnError: (message) => settle(false, message),
      onReady: () => {},
    });
  });
}

/**
 * Tear down each target's git worktree and branch when the close dialog's delete
 * checkbox was ticked. Always forced — the checkbox is explicit intent, so a
 * dirty worktree / unmerged branch is discarded per the user's decision. Never
 * throws: a failing target is collected so one bad worktree doesn't strand the
 * rest, and the messages surface in the error dialog.
 */
export async function discardWorktrees(
  targets: WorktreeTarget[],
): Promise<string[]> {
  const failures: string[] = [];
  for (const t of targets) {
    try {
      await removeWorktree(t.repo, t.path, { force: true, branch: t.branch });
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
