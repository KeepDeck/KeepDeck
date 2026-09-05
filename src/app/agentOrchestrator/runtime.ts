import type { ResumeOrigin } from "../../domain/agents";
import type { SpawnPlanContext } from "../spawnSpecs";
import {
  findPane,
  findWorkspace,
  paneAgentType,
  paneExecutionCwd,
  paneRunIntent,
  paneWakeOrigin,
  type Pane,
  type Workspace,
  attachedWorktree,
  locationOf,
  paneBranch,
} from "../../domain/deck";
import { describeError, log } from "../../ipc/log";
import { createDeckActions, type DeckActions } from "../deckActions";
import {
  buildLivePaneSpec,
  buildResumeSpec,
  dropPaneSpawnSpec,
  markPaneResumeOrigin,
  peekPaneSpawnSpec,
  subscribeSpawnSpecs,
} from "../spawnSpecs";
import { createRunViewStore } from "./view";
import { createStartupSilenceWatch } from "./startupSilence";
import type {
  AgentOrchestrator,
  AgentOrchestratorDeps,
  StagedSkillsAsk,
} from ".";
import { createAgentOrchestratorClosing } from "./closing";
import { createAgentOrchestratorContinuations } from "./continuations";
import { createAgentOrchestratorCreation } from "./creation";
import { createAgentOrchestratorRestart } from "./restart";
const SPAWN_PLACEHOLDER_SIZE = { cols: 80, rows: 24 };

/** How one attempt to bring a pane up ended. */
type Attempt =
  | { kind: "woken" }
  /** The pane's directory is gone; it needs relocating, not retrying. */
  | { kind: "blocked"; dir: string }
  /** The probe or the resume plan refused; `why` is shown on the card. */
  | { kind: "failed"; why: string };

export function createAgentOrchestratorRuntime(
  deps: AgentOrchestratorDeps,
): AgentOrchestrator {
  const {
    deck,
    spawnContext,
    agents,
    launchPolicy,
    suspendPolicy,
    sessions,
    plugins,
    probe,
    worktrees,
    lifecycle,
  } = deps;
  const actions: DeckActions = createDeckActions(deck);
  const runView = createRunViewStore(deck);
  const publish = runView.publish;
  const startupSilence = createStartupSilenceWatch({
    sessions,
    view: runView,
    publish: () => publish(),
    now: () => Date.now(),
    startTicker: (tick, everyMs) => {
      const handle = setInterval(tick, everyMs);
      return () => clearInterval(handle);
    },
  });
  const startOwed = new Set<string>();
  /** Attempts in flight — a notification while one is pending must not
   * double-run it. */
  const inFlight = new Set<string>();
  let booted = false;
  let scheduled = false;
  const { mcpAccess } = deps;
  // Skills are resolved at plan mint: the staged view is frozen into the
  // hook's output for that spawn, so a later gate flip affects only the next
  // plan.
  const skillsAsk: StagedSkillsAsk = (workspace, landing) => () =>
    worktrees.skillsFor(workspace, landing);


  /** Coalesce to one pass per turn: the sweep dispatches deck transitions of
   * its own, and each would otherwise re-enter this synchronously. */
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      reconcile();
    });
  }

  /** WHO is asking for this pane right now, or null when it is no longer
   * rising at all. Read from the LIVE deck rather than from the snapshot an
   * attempt started with: `requestPaneWake` can upgrade a boot restore to a
   * resume the user asked for by name — and a suspend can cancel the wake
   * outright — while a probe or a plan build is out. An attempt judged by the
   * stale answer is exactly how a resume becomes a different conversation. */
  function askedBy(wsId: string, paneId: string): ResumeOrigin | null {
    const pane = findPane(deck.getSnapshot().workspaces, wsId, paneId);
    return pane ? paneWakeOrigin(pane) : null;
  }

  /** Drop notes about panes that are gone (closed directly, or with their
   * workspace): ids are never reused, so the maps would only ever grow. */
  function reap(): boolean {
    const live = new Set(
      deck.getSnapshot().workspaces.flatMap((w) => w.panes.map((p) => p.id)),
    );
    for (const paneId of [...startOwed]) {
      if (!live.has(paneId)) startOwed.delete(paneId);
    }
    return runView.forgetGone(live);
  }

  /**
   * The ONE place an attempt's outcome is turned into state. Every exit of
   * the sweep routes through here, because the rule that matters — a resume
   * the USER asked for must never come up as a different conversation — has
   * to hold for all of them, and it kept being applied to one exit at a time.
   *
   * WHO asked is re-read here rather than taken from the attempt, because the
   * answer can change while the attempt is out. A boot restore takes the
   * documented degradation on failure: nobody is watching, and an empty pane
   * beats a pane that never comes back. A manual wake goes back down where it
   * came from and says why on its card.
   */
  function settle(wsId: string, pane: Pane, attempt: Attempt): void {
    // Every exit but a successful wake gives the attempt up, so the debt goes
    // with it. Left behind, it would exempt the pane from the
    // unopened-workspace economy for the rest of the session — and a start
    // nobody is coming back for is not a start that is owed.
    if (attempt.kind !== "woken") startOwed.delete(pane.id);
    const origin = askedBy(wsId, pane.id);
    if (!origin) {
      // The pane stopped rising while this attempt was out — closed, or
      // suspended by a user who changed their mind mid-probe. Its verdict is
      // moot, and recording one would leave the card explaining a failure
      // nobody is waiting on (or block a pane nobody asked to wake).
      log.info(
        "web:orchestrator",
        `${pane.id}: wake outcome dropped — the pane is no longer rising`,
      );
      startOwed.delete(pane.id);
      return;
    }
    if (attempt.kind === "woken") {
      actions.clearPaneIdle(wsId, pane.id);
      return;
    }
    if (attempt.kind === "blocked") {
      log.warn(
        "web:orchestrator",
        `${pane.id}: directory gone ${attempt.dir} → blocked tile`,
      );
      runView.markBlocked(pane.id, attempt.dir);
      publish();
    } else {
      log.warn(
        "web:orchestrator",
        `${pane.id}: ${origin} wake failed — ${attempt.why}`,
      );
    }
    if (origin !== "manual") {
      // Nothing to put back: a restore-origin pane that is blocked simply
      // stays where the sweep left it, and one that failed wakes fresh.
      if (attempt.kind === "failed") {
        // Fresh means fresh: a build that THREW also left the pane marked
        // plan-failed inside the spec cache, and waking it with that flag
        // still set lands it on the plan-error tile instead of a terminal.
        dropPaneSpawnSpec(pane.id);
        actions.clearPaneIdle(wsId, pane.id);
      }
      return;
    }
    if (attempt.kind === "failed") {
      runView.markWakeFailed(pane.id, attempt.why);
      publish();
    }
    // Drop the half-built plan with its failure flag, or the pane's next
    // wake lands on the plan-error tile instead of a terminal.
    dropPaneSpawnSpec(pane.id);
    actions.failPaneWake(wsId, pane.id);
  }

  const creation = createAgentOrchestratorCreation({
    deck,
    actions,
    worktrees,
  });
  const closing = createAgentOrchestratorClosing({
    deck,
    actions,
    sessions,
    suspendPolicy,
    worktrees,
    isBlocked: runView.isBlocked,
    lifecycle,
    dropArtifacts: deps.dropArtifacts,
  });
  const restart = createAgentOrchestratorRestart({
    deck,
    actions,
    sessions,
    plugins,
    spawnContext,
    bumpEpoch: runView.bumpEpoch,
    publish: () => publish(),
    markOccupied: runView.markOccupied,
    occupiedNote: runView.occupiedNote,
    clearNotes: runView.clearNotes,
    startOwed,
    skillsAsk,
    mcpAccess,
    schedule,
    lifecycle,
    forks: {
      forkSession: (wsId, record, target, opts) =>
        continuations.forkSession(wsId, record, target, opts),
    },
  });
  const continuations = createAgentOrchestratorContinuations({
    deck,
    spawnContext,
    plugins,
    isBlocked: runView.isBlocked,
    creation,
    skillsAsk,
    mcpAccess,
    worktrees,
  });

  /** Wake one pane onto `sessionId`, or fresh when it is null. */
  async function wake(
    ws: Workspace,
    pane: Pane,
    dir: string,
    sessionId: string | null,
  ): Promise<void> {
    const agentType = paneAgentType(pane);
    // WHOSE resume this is decides what happens when the CLI rejects the id.
    // A boot restore takes the one-shot fall back to a fresh conversation —
    // nobody is watching, and an empty pane beats a dead one. A resume the
    // user CLICKED must not: they were promised this session by name, so a
    // rejection has to stay visible as an exited pane they can act on.
    let origin = askedBy(ws.id, pane.id);
    // Cancelled while the probe was out (suspended, or closed outright):
    // there is nothing to bring up and nobody to report to.
    if (!origin) return;
    log.info(
      "web:orchestrator",
      `${pane.id} (${agentType}): ` +
        (sessionId ? `${origin} resume ${sessionId}` : "fresh"),
    );
    const ctx = spawnContext.get();
    if (sessionId && ctx) {
      // Built through the agent plugin's resume.plan hook and cached BEFORE
      // the pane wakes — the mounting terminal reads it.
      const plan = (asked: ResumeOrigin) =>
        buildResumeSpec(
          plugins,
          agentType,
          {
            paneId: pane.id,
            workspace: { id: ws.id, instance: ws.instance },
            cwd: dir,
            branch: paneBranch(pane),
            yolo: pane.yolo,
            stagedSkills: skillsAsk({ id: ws.id, instance: ws.instance }),
            mcpAccess,
          },
          ctx,
          sessionId,
          asked,
        );
      let failure: string | null = null;
      try {
        const built = await plan(origin);
        // The upgrade can also land INSIDE the build, and the origin is BAKED
        // INTO the cached plan — it is what arms (or disarms) the one-shot
        // fall back to a fresh conversation. A plan built as a restore
        // therefore cannot serve a resume the user asked for by name.
        // Re-stamped rather than rebuilt: the origin never reaches the agent's
        // hook, so there is nothing for a second build to produce differently,
        // and a plugin hook is someone else's code to run twice.
        const nowAsked = askedBy(ws.id, pane.id);
        if (built && nowAsked === "manual" && origin !== "manual") {
          log.info(
            "web:orchestrator",
            `${pane.id}: asked for by name mid-build → re-stamped as a manual resume`,
          );
          origin = "manual";
          markPaneResumeOrigin(pane.id, "manual");
        }
        // A `false` here is "no plan was cached", and it covers two very
        // different causes: a plugin that offers no resume.plan hook at all,
        // and a build a newer decision invalidated mid-flight. The sentence
        // names neither, because this layer cannot tell them apart — blaming
        // the agent for the second one was simply false.
        //
        // Either way the pane must not wake: the ordinary fresh sweep would
        // start a NEW conversation whose reporter then overwrites the binding,
        // the silent substitution the `manual` origin prevents.
        if (!built) failure = "Its resume plan could not be prepared.";
      } catch (e) {
        failure = describeError(e);
      }
      if (failure) {
        settle(ws.id, pane, { kind: "failed", why: failure });
        return;
      }
    }
    settle(ws.id, pane, { kind: "woken" });
  }

  /** Every live pane needs a plan before its terminal has anything to run.
   * Kept next to the wake pass because they are the same reconciliation seen
   * from two sides — one decides that a pane should run, the other prepares
   * what running means — and splitting them across two owners is how a pane
   * came to be woken with no plan cached for it. */
  function planLivePanes(ctx: SpawnPlanContext): void {
    for (const ws of deck.getSnapshot().workspaces) {
      for (const pane of ws.panes) {
        void buildLivePaneSpec(
          plugins,
          ws,
          pane,
          ctx,
          {
            stagedSkills: skillsAsk({ id: ws.id, instance: ws.instance }),
            mcpAccess,
          },
        ).then((changed) => {
          if (!changed) return;
          publish();
          // A plan landing is what a pane waiting to start was waiting FOR —
          // reconcile again, or nothing spawns until an unrelated notification
          // happens along.
          schedule();
        });
      }
    }
  }

  function reconcile(): void {
    if (reap()) publish();
    // Wait for the spawn context (a resume plan built without it would miss
    // the agent's identity mechanism) AND the catalog (see `ready`).
    const ctx = spawnContext.get();
    if (!ctx || !booted) return;
    planLivePanes(ctx);
    const state = deck.getSnapshot();
    const active = findWorkspace(state.workspaces, state.activeId);
    if (!active) return;
    const commands = agents.commands();

    for (const ws of state.workspaces) {
      for (const pane of ws.panes) {
        // One question, one answer: a decision the user or the policy made, an
        // agent no plugin provides, a directory that is gone, a workspace
        // nobody has opened — and the reason it gives is the reason the card
        // shows.
        const agentType = paneAgentType(pane);
        // A restart owns this pane until it is finished, and that covers BOTH
        // halves of the sweep. Guarding only the spawn half left the wake half
        // open: a suspend during a restart's awaits marks the pane idle, a
        // resume then marks it waking, and this pass would build and cache a
        // plan into the same slot the restart is still using — which the
        // restart's own continuation then reads as its own failed build,
        // drops, and replaces with a fresh conversation. The restart schedules
        // another pass when it is done.
        if (restart.owns(pane.id)) continue;
        const intent = paneRunIntent(pane, {
          agentAvailable: commands.has(agentType),
          missingDir: runView.blockedDir(pane.id),
          workspaceActive: ws.id === active.id,
          parkOnLaunch: launchPolicy.parkOnLaunch(),
          startOwed: startOwed.has(pane.id),
        });
        if (intent.kind === "run" && !pane.idle) {
          // A pane with no marker: it should run, and the only question left
          // is whether it already does and whether there is anything to run.
          // Never a reason to END one — this pass starts processes only. (A
          // restart owning the pane was already skipped above: its retiring
          // half empties the slot, which looks exactly like a pane that should
          // be started.)
          if (sessions.state(pane.id).kind !== "none") {
            // It has one: the debt is paid.
            startOwed.delete(pane.id);
            continue;
          }
          const spec = peekPaneSpawnSpec(pane.id);
          if (!spec) continue;
          sessions.acquire(pane.id, {
            command:
              spec.command !== undefined
                ? spec.command
                : (commands.get(agentType) ?? agentType),
            args: spec.args,
            env: spec.env,
            envDefaults: spec.envDefaults,
            cwd: paneExecutionCwd(ws, pane),
            ...SPAWN_PLACEHOLDER_SIZE,
          });
          // Only a continuation gets the silence watch. A fresh start paints
          // sooner still, and telling someone their new agent is taking its
          // time — with an offer to fork a session that does not exist yet —
          // would be a hint about the wrong thing.
          if (spec.resumeOf !== undefined || spec.forkOf !== undefined) {
            startupSilence.arm(pane.id);
          }
          continue;
        }
        if (!pane.idle || inFlight.has(pane.id)) continue;
        if (intent.kind === "hold") {
          // A pane the launch policy holds is not merely skipped: it stops
          // rising, so its card says "stopped" and offers Resume instead of
          // promising a start that is never coming. Only that reason — every
          // other hold either already has its own marker or describes a
          // condition the pane should keep waiting on.
          if (
            intent.reason.kind === "stopped" &&
            intent.reason.by.reason === "parked"
          ) {
            actions.parkPane(ws.id, pane.id);
          }
          continue;
        }
        const sessionId = intent.resume?.sessionId ?? null;
        inFlight.add(pane.id);
        // A remote pane's agent runs against a VPS endpoint — it has no local
        // working directory to probe (so a gone workspace cwd never blocks it)
        // and no recorded session to resume (fresh-session only). Wake it
        // straight to a fresh remote plan built by the spawn-spec sweep.
        if (locationOf(pane).kind === "remote") {
          void wake(ws, pane, ws.cwd, sessionId).finally(() =>
            inFlight.delete(pane.id),
          );
          continue;
        }
        const dir = attachedWorktree(pane)?.cwd ?? ws.cwd;
        void probe(dir)
          .then((probed) => {
            if (probed.exists) return wake(ws, pane, dir, sessionId);
            settle(ws.id, pane, { kind: "blocked", dir });
          })
          // A probe that REJECTS is a failed attempt like any other: it used
          // to wake the pane fresh regardless of who asked, which is exactly
          // the silent substitution the manual origin exists to prevent.
          .catch((e) =>
            settle(ws.id, pane, { kind: "failed", why: describeError(e) }),
          )
          .finally(() => inFlight.delete(pane.id));
      }
    }
  }

  deck.subscribe(schedule);
  // A plan landing is what a pane waiting to start is waiting FOR, and what a
  // card saying "Waking up…" is waiting to stop saying. Several paths write
  // that cache — the sweep, a manual resume, a fork's surgery, a retry — and
  // the ones that go through an await used to reach neither the view nor the
  // next pass: a resumed pane got a real process behind a permanent
  // placeholder, and the plan-error tile's Retry rebuilt nothing.
  subscribeSpawnSpecs(() => {
    publish();
    schedule();
  });
  spawnContext.subscribe(schedule);
  agents.subscribe(schedule);
  launchPolicy.subscribe(schedule);
  sessions.subscribe(schedule);
  void agents.ready().then(() => {
    booted = true;
    schedule();
  });
  // The deck may already hold restored panes by the time this is built (boot
  // hydration races the plugin bootstrap), and a source that never changes
  // again would leave them waiting on a notification that is not coming.
  schedule();

  return {
    getView: runView.get,
    subscribe: runView.subscribe,
    createPane: creation.landPane,
    createWorkspace: creation.createWorkspace,
    retryProvisioning: creation.retryProvisioning,
    suspend: closing.suspend,
    close: closing.close,
    restart: restart.restart,
    recoverRejectedResume: restart.recoverRejectedResume,
    retryPlanBuild: restart.retryPlanBuild,
    forkOccupiedSession: restart.forkOccupiedSession,
    forkStalledSession: restart.forkStalledSession,
    dismissOccupied: restart.dismissOccupied,
    resumeSession: continuations.resumeSession,
    forkSession: continuations.forkSession,
    startFresh(wsId, paneId) {
      if (runView.clearNotes(paneId)) publish();
      startOwed.add(paneId);
      actions.resetPaneLocation(wsId, paneId);
      actions.requestPaneWake(wsId, paneId);
    },
    resume(wsId, paneId) {
      const pane = findPane(deck.getSnapshot().workspaces, wsId, paneId);
      if (!pane) return "gone";
      if (locationOf(pane).kind === "provisioning") return "provisioning";
      if (!pane.idle) return "running";
      if (!agents.commands().has(paneAgentType(pane))) return "unavailable";
      if (runView.clearNotes(paneId)) publish();
      startOwed.add(paneId);
      actions.requestPaneWake(wsId, paneId);
      return "resuming";
    },
  };
}
