import type { ResumeOrigin } from "../domain/agents";
import {
  findPane,
  findWorkspace,
  paneAgentType,
  paneIsRemoteFresh,
  paneRunIntent,
  paneWakeOrigin,
  skillRootsOf,
  type Pane,
  type Workspace,
} from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { createDeckActions, type DeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";
import type { SpawnContextSource } from "./spawnContextSource";
import {
  buildLivePaneSpec,
  buildResumeSpec,
  dropPaneSpawnSpec,
  markPaneResumeOrigin,
  peekPanePlanError,
  peekPaneSpawnSpec,
  type SpawnPluginAccess,
} from "./spawnSpecs";
import type { SpawnPlan, SpawnPlanContext } from "../domain/agents";

/**
 * The owner of an agent pane's run lifecycle.
 *
 * It answers one question for every pane — should a process be behind it,
 * and if not, why ([`paneRunIntent`]) — and drives the primitives that make
 * reality match: the worktree probe, the plugin's resume-plan hook, and the
 * deck's own transitions. Nothing here computes; the decision is the domain's
 * and the doing is the primitives'.
 *
 * Deliberately outside React. The processes it governs outlive any render,
 * and a request can arrive for a pane that is not on screen — `agent.resume`
 * takes a workspace argument precisely so it can reach one. Constructed with
 * injected ports rather than reaching for modules, so a test builds its own
 * with fakes and needs no DOM.
 */
export interface AgentOrchestrator {
  /** What the deck renders about panes that are not running. Stable between
   * changes (the `useSyncExternalStore` snapshot contract). */
  getView(): AgentRunView;
  subscribe(listener: () => void): () => void;
  /** Detach the pane from the missing worktree and start it fresh in the
   * workspace cwd. */
  startFresh(wsId: string, paneId: string): void;
  /**
   * Ask for a stopped pane back — the ONE gesture behind the card's Resume,
   * the blocked card's "Look again" and the `agent.resume` command. It clears
   * whatever the last attempt left (a block, a refusal note) and marks the
   * wake as the user's, which is what keeps a rejected session id from
   * quietly becoming a different conversation.
   *
   * Answers what it did: a live pane has nothing to resume, and a caller that
   * reports success for that would be lying.
   */
  resume(wsId: string, paneId: string): ResumeRequest;
}

export interface AgentRunView {
  /** paneId → the missing directory (the idle tile's note). */
  blocked: Record<string, string>;
  /** paneId → why the resume the USER asked for could not be prepared. The
   * pane stayed stopped rather than coming up as a different conversation;
   * its card says this. Cleared when the pane is asked for again. */
  wakeFailed: Record<string, string>;
  /** Each live pane's spawn plan, once its build lands. A pane without one
   * yet has nothing to run: its terminal waits. */
  specs: Record<string, SpawnPlan>;
  /** Panes whose plan build FAILED — the deck shows an error tile with a
   * retry instead of leaving them on "Waking up…" forever. */
  planFailed: ReadonlySet<string>;
}

/** What asking for a pane back did. */
export type ResumeRequest =
  | "resuming"
  /** The pane is already running — nothing to bring back. */
  | "running"
  /** Its worktree is still being created; it has never run, so there is no
   * session to come back to. Distinct from "running" because telling the user
   * a pane mid-create is already running is simply false. */
  | "provisioning"
  /** No installed plugin provides this pane's agent, so the sweep would skip
   * it forever. Refused rather than marked: a pane left rising with nothing
   * to raise it loses the durable stamp that says it was stopped. */
  | "unavailable"
  /** No such pane (or workspace) in the deck. */
  | "gone";

/** The agents a plugin currently provides. Re-enabling a cli plugin must wake
 * the panes its absence kept idle, without an app restart — hence a live
 * source rather than a snapshot. */
export interface AgentCatalogPort {
  ids(): ReadonlySet<string>;
  /** Resolves once the plugin system has booted. Before that every pane's
   * agent would read as unknown, and waking anything would misjudge it. */
  ready(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

/** Does this directory still exist? The pane's worktree may have been removed
 * behind the app's back. */
export type WorktreeProbePort = (dir: string) => Promise<{ exists: boolean }>;

/** Whether restored agents come back stopped instead of resuming. Live, not a
 * value captured once: the setting is not a fact about any pane, and the panes
 * it governs are precisely the ones that have not started yet — including the
 * ones still waiting in a workspace nobody has opened. */
export interface LaunchPolicyPort {
  parkOnLaunch(): boolean;
  subscribe(listener: () => void): () => void;
}

/** The live PTY sessions. Subscribed to rather than polled: a restart drops a
 * pane's cached plan and closes its process, and nothing in the deck records
 * either — without this the orchestrator would never rebuild the plan. */
export interface SessionRegistryPort {
  subscribe(listener: () => void): () => void;
}

export interface AgentOrchestratorDeps {
  deck: DeckStore;
  spawnContext: SpawnContextSource;
  agents: AgentCatalogPort;
  launchPolicy: LaunchPolicyPort;
  sessions: SessionRegistryPort;
  plugins: SpawnPluginAccess;
  probe: WorktreeProbePort;
}

/** How one attempt to bring a pane up ended. */
type Attempt =
  | { kind: "woken" }
  /** The pane's directory is gone; it needs relocating, not retrying. */
  | { kind: "blocked"; dir: string }
  /** The probe or the resume plan refused; `why` is shown on the card. */
  | { kind: "failed"; why: string };

const EMPTY_VIEW: AgentRunView = {
  blocked: {},
  wakeFailed: {},
  specs: {},
  planFailed: new Set(),
};

export function createAgentOrchestrator(
  deps: AgentOrchestratorDeps,
): AgentOrchestrator {
  const { deck, spawnContext, agents, launchPolicy, sessions, plugins, probe } =
    deps;
  const actions: DeckActions = createDeckActions(deck);
  const blocked = new Map<string, string>();
  const wakeFailed = new Map<string, string>();
  /** Attempts in flight — a notification while one is pending must not
   * double-run it. */
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let view: AgentRunView = EMPTY_VIEW;
  let booted = false;
  let scheduled = false;

  function publish(): void {
    // The plan snapshot is read off the shared cache rather than mirrored:
    // resume and fork plans are written there by other paths, and a second
    // copy here would be a second answer to "what does this pane run".
    const specs: Record<string, SpawnPlan> = {};
    const planFailed = new Set<string>();
    for (const ws of deck.getSnapshot().workspaces) {
      for (const pane of ws.panes) {
        const spec = peekPaneSpawnSpec(pane.id);
        if (spec) specs[pane.id] = spec;
        if (peekPanePlanError(pane.id)) planFailed.add(pane.id);
      }
    }
    view = {
      blocked: Object.fromEntries(blocked),
      wakeFailed: Object.fromEntries(wakeFailed),
      specs,
      planFailed,
    };
    for (const listener of [...listeners]) listener();
  }

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
    let dropped = false;
    for (const map of [blocked, wakeFailed]) {
      for (const paneId of [...map.keys()]) {
        if (!live.has(paneId)) {
          map.delete(paneId);
          dropped = true;
        }
      }
    }
    return dropped;
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
      blocked.set(pane.id, attempt.dir);
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
      wakeFailed.set(pane.id, attempt.why);
      publish();
    }
    // Drop the half-built plan with its failure flag, or the pane's next
    // wake lands on the plan-error tile instead of a terminal.
    dropPaneSpawnSpec(pane.id);
    actions.failPaneWake(wsId, pane.id);
  }

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
            branch: pane.branch,
            yolo: pane.yolo,
            wsSkillRoots: skillRootsOf(ws),
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
        void buildLivePaneSpec(plugins, ws, pane, ctx).then((changed) => {
          if (changed) publish();
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
    const available = agents.ids();

    for (const ws of state.workspaces) {
      for (const pane of ws.panes) {
        // Whether a process ALREADY belongs to this pane. The deck's own
        // marker is the only answer available here: a pane with none is up (or
        // the render path is about to bring it up), and nothing in this sweep
        // may touch it.
        if (!pane.idle || inFlight.has(pane.id)) continue;
        // Everything else — a decision the user or the policy made, an agent
        // no plugin provides, a directory that is gone, a workspace nobody has
        // opened — is one question with one answer, and the reason it gives is
        // the same reason the card shows.
        const intent = paneRunIntent(pane, {
          agentAvailable: available.has(paneAgentType(pane)),
          missingDir: blocked.get(pane.id) ?? null,
          workspaceActive: ws.id === active.id,
          parkOnLaunch: launchPolicy.parkOnLaunch(),
        });
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
        if (paneIsRemoteFresh(pane)) {
          void wake(ws, pane, ws.cwd, sessionId).finally(() =>
            inFlight.delete(pane.id),
          );
          continue;
        }
        const dir = pane.cwd ?? ws.cwd;
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
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    startFresh(wsId, paneId) {
      let changed = blocked.delete(paneId);
      changed = wakeFailed.delete(paneId) || changed;
      if (changed) publish();
      actions.resetPaneLocation(wsId, paneId);
      // Ask for a wake rather than clearing the marker outright: the pane is
      // pointed at the workspace folder now, and the sweep should probe it like
      // any other before mounting a terminal there.
      actions.requestPaneWake(wsId, paneId);
    },
    resume(wsId, paneId) {
      const pane = findPane(deck.getSnapshot().workspaces, wsId, paneId);
      if (!pane) return "gone";
      if (pane.provisioning) return "provisioning";
      if (!pane.idle) return "running";
      // The same catalog gate the sweep applies. Asked here too, because the
      // sweep's version is a silent skip: marking the pane first would strand
      // it in a state nothing settles.
      if (!agents.ids().has(paneAgentType(pane))) return "unavailable";
      // Clear the last attempt's verdicts first: a stale block would make the
      // sweep skip this pane forever, and a stale note would explain a failure
      // the user is already retrying.
      let changed = blocked.delete(paneId);
      changed = wakeFailed.delete(paneId) || changed;
      if (changed) publish();
      actions.requestPaneWake(wsId, paneId);
      return "resuming";
    },
  };
}
