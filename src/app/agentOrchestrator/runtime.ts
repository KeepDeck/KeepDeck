import type { ResumeOrigin } from "../../domain/agents";
import {
  agentReach,
  findPane,
  findTeam,
  findWorkspace,
  paneBranch,
  paneExecutionCwd,
  paneResumeSessionId,
  paneRunIntent,
  paneWakeOrigin,
  remoteEndpointOf,
  teamActsOf,
  type Pane,
  type PaneRunIntent,
  type TeamActFacts,
  type TeamActs,
  type Workspace,
} from "../../domain/deck";
import type { LaunchOwner } from "../../ipc/generated/lifecycle/LaunchOwner";
import type { PanePhase } from "../../ipc/generated/lifecycle/PanePhase";
import { log } from "../../ipc/log";
import { createDeckActions, type DeckActions } from "../deckActions";
import {
  buildLivePaneSpec,
  buildResumeSpec,
  dropPaneSpawnSpec,
  markPaneResumeOrigin,
  peekPaneSpawnSpec,
  subscribeSpawnSpecs,
  type SpawnPlanContext,
} from "../spawnSpecs";
import { createLifecycleDoors } from "./doors";
import { createRecovery } from "./recovery";
import { createRunViewStore } from "./view";
import { createStartupSilenceWatch } from "./startupSilence";
import type { AgentOrchestrator, AgentOrchestratorDeps, StagedSkillsAsk } from ".";
import { errorMessage } from "@keepdeck/plugin-api";

const SPAWN_PLACEHOLDER_SIZE = { cols: 80, rows: 24 };

/** How one attempt to bring a pane up ended. */
type Attempt =
  | { kind: "woken" }
  /** The pane's directory is gone; it needs relocating, not retrying. */
  | { kind: "blocked"; dir: string }
  /** The probe or the resume plan refused; `why` is shown on the card. */
  | { kind: "failed"; why: string };

export function createAgentOrchestratorRuntime(deps: AgentOrchestratorDeps): AgentOrchestrator {
  const { deck, spawnContext, agents, launchPolicy, sessions, plugins, probe, machine, mcpAccess, armCwd } = deps;
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
  /** Restarts the machine took on, waiting for their pane's next process:
   * true for one that resumes its recorded session. */
  const restarting = new Map<string, boolean>();
  /** Attempts in flight — a wake or a lease — that a notification while one
   * is pending must not run twice. */
  const inFlight = new Set<string>();
  /** Panes whose lease was refused, by the snapshot generation that refused
   * it: asked again only once the machine's state has moved. */
  const leaseRefused = new Map<string, number>();
  let generation = 0;
  let booted = false;
  let scheduled = false;
  // Skills are resolved at plan mint: the staged view is frozen into the
  // hook's output for that spawn, so a later gate flip affects only the next
  // plan.
  const skillsAsk: StagedSkillsAsk = (workspace) => () => deps.skills.skillsFor(workspace);

  /** Coalesce to one pass per turn: the funnel dispatches deck transitions
   * of its own, and each would otherwise re-enter this synchronously. */
  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      reconcile();
    });
  }

  /** The machine's phase of a pane, or null before it names it. */
  function phaseOf(paneId: string): PanePhase | null {
    return machine.snapshot()?.panes[paneId] ?? null;
  }

  /** WHO is asking for this pane right now, or null when it is no longer
   * rising at all — read from the LIVE deck, never from the snapshot an
   * attempt started with: a boot restore can become a resume the user asked
   * for by name, and a suspend can cancel the wake outright, while a probe or
   * a plan build is out. */
  function askedBy(wsId: string, paneId: string): ResumeOrigin | null {
    const pane = findPane(deck.getSnapshot().workspaces, wsId, paneId);
    return pane ? paneWakeOrigin(pane) : null;
  }

  /** Drop notes about panes that are gone: ids are never reused, so the maps
   * would only ever grow. */
  function reap(): boolean {
    const live = new Set(deck.getSnapshot().workspaces.flatMap((w) => w.panes.map((p) => p.id)));
    for (const paneId of [...startOwed]) if (!live.has(paneId)) startOwed.delete(paneId);
    for (const paneId of [...restarting.keys()]) if (!live.has(paneId)) restarting.delete(paneId);
    for (const paneId of [...leaseRefused.keys()]) if (!live.has(paneId)) leaseRefused.delete(paneId);
    return runView.forgetGone(live);
  }

  /**
   * The ONE place an attempt's outcome is turned into state. Every exit of
   * the wake routes through here, because the rule that matters — a resume
   * the USER asked for must never come up as a different conversation — has
   * to hold for all of them. A boot restore takes the documented degradation
   * on failure: nobody is watching, and an empty pane beats a pane that never
   * comes back. A manual wake goes back down where it came from and says why
   * on its card.
   */
  function settle(wsId: string, pane: Pane, attempt: Attempt): void {
    if (attempt.kind !== "woken") startOwed.delete(pane.id);
    const origin = askedBy(wsId, pane.id);
    if (!origin) {
      log.info("web:orchestrator", `${pane.id}: wake outcome dropped — the pane is no longer rising`);
      startOwed.delete(pane.id);
      return;
    }
    if (attempt.kind === "woken") {
      actions.clearPaneIdle(wsId, pane.id);
      return;
    }
    if (attempt.kind === "blocked") {
      log.warn("web:orchestrator", `${pane.id}: directory gone ${attempt.dir} → blocked tile`);
      runView.markBlocked(pane.id, attempt.dir);
      publish();
    } else {
      log.warn("web:orchestrator", `${pane.id}: ${origin} wake failed — ${attempt.why}`);
    }
    if (origin !== "manual") {
      if (attempt.kind === "failed") {
        // Fresh means fresh: a build that THREW also left the pane marked
        // plan-failed, and waking it with that flag still set lands it on the
        // plan-error tile instead of a terminal.
        dropPaneSpawnSpec(pane.id);
        actions.clearPaneIdle(wsId, pane.id);
      }
      return;
    }
    if (attempt.kind === "failed") {
      runView.markWakeFailed(pane.id, attempt.why);
      publish();
    }
    dropPaneSpawnSpec(pane.id);
    actions.failPaneWake(wsId, pane.id);
  }

  /** What a team act reads beyond the deck: the funnel's folder verdict, the
   * live agent catalog, and whether the machine is suspending a pane. */
  const teamFacts: TeamActFacts = {
    blocked: (paneId) => runView.isBlocked(paneId),
    agentAvailable: (agentType) => agents.commands().has(agentType),
    suspending: (paneId) => phaseOf(paneId) === "suspending",
  };

  function teamActs(wsId: string, teamId: string): TeamActs | null {
    const workspace = findWorkspace(deck.getSnapshot().workspaces, wsId);
    return workspace && findTeam(workspace, teamId) ? teamActsOf(workspace, teamId, teamFacts) : null;
  }

  const doors = createLifecycleDoors({
    deck,
    actions,
    send: machine.send,
    teamActs,
    askedBack(paneIds) {
      if (paneIds.filter((paneId) => runView.clearNotes(paneId)).length > 0) publish();
      for (const paneId of paneIds) startOwed.add(paneId);
      schedule();
    },
    restarting(paneId, resume) {
      restarting.set(paneId, resume);
      startOwed.add(paneId);
      if (runView.clearNotes(paneId)) publish();
      schedule();
    },
  });

  const recovery = createRecovery({
    deck,
    actions,
    sessions,
    plugins,
    spawnContext,
    lifecycle: deps.lifecycle,
    skillsAsk,
    mcpAccess,
    armCwd,
    bumpEpoch: runView.bumpEpoch,
    publish: () => publish(),
    markOccupied: runView.markOccupied,
    clearNotes: runView.clearNotes,
    owe: (paneId) => startOwed.add(paneId),
    schedule,
  });

  /** The facts a plan for `pane` is built from. */
  function factsOf(ws: Workspace, pane: Pane, cwd: string) {
    const ref = { id: ws.id, instance: ws.instance };
    return {
      paneId: pane.id,
      workspace: ref,
      cwd,
      branch: paneBranch(ws, pane),
      yolo: pane.yolo,
      stagedSkills: skillsAsk(ref),
      mcpAccess,
      armCwd,
    };
  }

  /** Wake one pane onto `sessionId`, or fresh when it is null. */
  async function wake(ws: Workspace, pane: Pane, dir: string, sessionId: string | null): Promise<void> {
    // WHOSE resume this is decides what happens when the CLI rejects the id:
    // a boot restore falls back to a fresh conversation, a resume the user
    // clicked does not.
    let origin = askedBy(ws.id, pane.id);
    if (!origin) return;
    log.info("web:orchestrator", `${pane.id} (${pane.agentType}): ` + (sessionId ? `${origin} resume ${sessionId}` : "fresh"));
    const ctx = spawnContext.get();
    if (sessionId && ctx) {
      let failure: string | null = null;
      try {
        const built = await buildResumeSpec(plugins, pane.agentType, factsOf(ws, pane, dir), ctx, sessionId, origin);
        // The upgrade can land INSIDE the build, and the origin is baked into
        // the cached plan: a plan built as a restore cannot serve a resume the
        // user asked for by name. Re-stamped, not rebuilt.
        const nowAsked = askedBy(ws.id, pane.id);
        if (built && nowAsked === "manual" && origin !== "manual") {
          origin = "manual";
          markPaneResumeOrigin(pane.id, "manual");
        }
        if (!built) failure = "Its resume plan could not be prepared.";
      } catch (e) {
        failure = errorMessage(e);
      }
      if (failure) {
        settle(ws.id, pane, { kind: "failed", why: failure });
        return;
      }
    }
    settle(ws.id, pane, { kind: "woken" });
  }

  /** The plan a pane that should run is launched with: a restart that keeps
   * its conversation resumes it, by the person's ask; anything else gets
   * the plan a live pane runs. */
  function plan(ws: Workspace, pane: Pane, cwd: string, ctx: SpawnPlanContext): void {
    const resumes = restarting.get(pane.id) === true ? paneResumeSessionId(pane) : null;
    const built = resumes
      ? buildResumeSpec(plugins, pane.agentType, factsOf(ws, pane, cwd), ctx, resumes, "manual")
      : buildLivePaneSpec(plugins, ws, pane, ctx, { stagedSkills: skillsAsk({ id: ws.id, instance: ws.instance }), mcpAccess, armCwd });
    void built.then(
      (changed) => {
        if (!changed) return;
        publish();
        schedule();
      },
      (e: unknown) => log.warn("web:orchestrator", `${pane.id}: plan build failed — ${errorMessage(e)}`),
    );
  }

  /** Lease a launch for `pane` and start it with the permit the machine
   * granted. A refusal leaves it down until the machine's state moves; one
   * for a target on its way out says nothing at all. */
  function launch(ws: Workspace, pane: Pane, cwd: string): void {
    const spec = peekPaneSpawnSpec(pane.id);
    if (!spec) return;
    const remote = remoteEndpointOf(pane) !== null;
    const owner: LaunchOwner = remote ? { kind: "remote", pane: pane.id } : { kind: "pane", pane: pane.id };
    const asked = generation;
    inFlight.add(pane.id);
    void machine
      .lease({ kind: "launch", workspace: ws.id, owner, dir: remote ? null : cwd })
      .then((reply) => {
        if (reply.kind !== "answered" || reply.answer.kind !== "leased") {
          leaseRefused.set(pane.id, asked);
          const why = reply.kind !== "answered" ? reply.kind : reply.answer.kind === "refused" ? reply.answer.refusal.kind : reply.answer.kind;
          if (why !== "targetLeaving") log.info("web:orchestrator", `${pane.id}: no launch lease (${why})`);
          return;
        }
        const permit = reply.answer.permit;
        // Read again after the wait: a plan can be dropped while it was out.
        const current = peekPaneSpawnSpec(pane.id);
        if (!current || sessions.state(pane.id).kind !== "none") {
          void machine.release(permit).catch(() => {});
          return;
        }
        const commands = agents.commands();
        sessions.acquire(
          pane.id,
          {
            command: current.command !== undefined ? current.command : (commands.get(pane.agentType) ?? pane.agentType),
            args: current.args,
            env: current.env,
            envDefaults: current.envDefaults,
            cwd,
            ...SPAWN_PLACEHOLDER_SIZE,
          },
          { permit, owner },
        );
        restarting.delete(pane.id);
        startOwed.delete(pane.id);
        // Only a continuation gets the silence watch: a fresh start paints
        // sooner still.
        if (current.resumeOf !== undefined || current.forkOf !== undefined) startupSilence.arm(pane.id);
      })
      .catch((e: unknown) => log.warn("web:orchestrator", `${pane.id}: lease failed — ${errorMessage(e)}`))
      .finally(() => {
        inFlight.delete(pane.id);
        schedule();
      });
  }

  /** The run decision for one pane — the ONE place its facts are gathered,
   * for the funnel and for `reachOf` alike. A catalog that has not loaded yet
   * is not one that lacks the agent. */
  function intentOf(ws: Workspace, pane: Pane, activeId: string | null, commands: ReadonlyMap<string, string>): PaneRunIntent {
    return paneRunIntent(ws, pane, {
      workspaceArchived: ws.archived !== undefined,
      agentAvailable: !booted || commands.has(pane.agentType),
      missingDir: runView.blockedDir(pane.id),
      workspaceActive: ws.id === activeId,
      parkOnLaunch: launchPolicy.parkOnLaunch(),
      startOwed: startOwed.has(pane.id),
      phase: phaseOf(pane.id),
    });
  }

  function reconcile(): void {
    if (reap()) publish();
    // The barrier: until the machine has reconciled against the deck, the
    // funnel waits — silently, with nothing to say on any card.
    if (machine.snapshot()?.open !== true) return;
    const ctx = spawnContext.get();
    if (!ctx || !booted) return;
    const state = deck.getSnapshot();
    if (!findWorkspace(state.workspaces, state.activeId)) return;
    const commands = agents.commands();

    for (const ws of state.workspaces) {
      for (const pane of ws.panes) {
        if (recovery.owns(pane.id) || inFlight.has(pane.id)) continue;
        const intent = intentOf(ws, pane, state.activeId, commands);
        const process = sessions.state(pane.id).kind;
        if (intent.kind === "run" && !pane.idle) {
          // A restart's old process is over: let go of it, so the next one
          // can start in its place.
          if (restarting.has(pane.id) && (process === "exited" || process === "failed")) {
            void sessions.close(pane.id).then(schedule);
            continue;
          }
          if (process !== "none") {
            startOwed.delete(pane.id);
            continue;
          }
          const cwd = paneExecutionCwd(ws, pane);
          if (cwd === null) continue;
          if (leaseRefused.get(pane.id) === generation) continue;
          if (!peekPaneSpawnSpec(pane.id)) {
            plan(ws, pane, cwd, ctx);
            continue;
          }
          launch(ws, pane, cwd);
          continue;
        }
        if (!pane.idle) continue;
        if (intent.kind === "hold") {
          // A pane the launch policy holds stops rising: its card says
          // "stopped" and offers Resume instead of promising a start.
          if (intent.reason.kind === "stopped" && intent.reason.by.reason === "parked") actions.parkPane(ws.id, pane.id);
          continue;
        }
        const sessionId = intent.resume?.sessionId ?? null;
        const dir = paneExecutionCwd(ws, pane);
        if (dir === null) continue;
        inFlight.add(pane.id);
        // A remote pane's agent runs against an endpoint — no local folder to
        // probe, no recorded session to resume.
        if (remoteEndpointOf(pane) !== null) {
          void wake(ws, pane, dir, sessionId).finally(() => {
            inFlight.delete(pane.id);
            schedule();
          });
          continue;
        }
        void probe(dir)
          .then((probed) => {
            if (probed.exists) return wake(ws, pane, dir, sessionId);
            settle(ws.id, pane, { kind: "blocked", dir });
          })
          .catch((e) => settle(ws.id, pane, { kind: "failed", why: errorMessage(e) }))
          .finally(() => {
            inFlight.delete(pane.id);
            schedule();
          });
      }
    }
  }

  deck.subscribe(schedule);
  subscribeSpawnSpecs(() => {
    publish();
    schedule();
  });
  machine.subscribe(() => {
    generation += 1;
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
  schedule();

  return {
    getView: runView.get,
    subscribe: runView.subscribe,
    reachOf(paneId) {
      const state = deck.getSnapshot();
      for (const ws of state.workspaces) {
        const pane = ws.panes.find((candidate) => candidate.id === paneId);
        if (!pane) continue;
        return agentReach(intentOf(ws, pane, state.activeId, agents.commands()), sessions.state(paneId).kind, runView.get().planFailed.has(paneId));
      }
      return null;
    },
    ...doors,
    recoverRejectedResume: recovery.recoverRejectedResume,
    retryPlanBuild: recovery.retryPlanBuild,
    dismissOccupied: recovery.dismissOccupied,
    teamActs,
  };
}
