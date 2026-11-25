import {
  findWorkspaceOfPane,
  paneHasProcess,
  paneWorktree,
} from "../domain/deck";
import { errorMessage, tailWatches, type TailWatch } from "@keepdeck/plugin-api";
import { log } from "../ipc/log";
import {
  linkSessionFile,
  retargetSessionFile,
  unwatchSessionFile,
  watchSessionFile,
} from "../ipc/usage";
import { usageSince } from "../ipc/usageLedger";
import { peekPaneSpawnSpec, subscribeSpawnSpecs } from "./spawnSpecs";
import type { UsageLane, UsageLaneContext } from "./usageChannelSource";

export const TAIL_RETRY_MS = 20_000;

export interface UsageTailsLane extends UsageLane {
  /** Follow, in `paneId`'s tail, the stores its records named by these ids
   * (codex's subagent threads), as its agent locates them. */
  link(paneId: string, ids: readonly string[]): void;
}

/** What a pane was armed with. `token` is the pane's plan's secret at the
 * arm, kept here alone: a tail stands while it is still the plan's — a plan
 * retired, or another minted, ends it — and the reports it carries name no
 * secret, being the deck's own reading of the pane's store. */
interface Armed {
  path: string;
  token: string;
  agentId: string;
  sessionId: string;
}

/** One arming of a pane's tail, as this lane holds it: what it was armed
 * with, and whether its store's status records are its companion's now. */
type Arming = Armed & { covered: boolean };

/** Session-file watcher lane, including Codex's resume-without-binding fallback. */
export function createUsageTailsLane({
  deck,
  declarations,
  attribution,
  bindings,
  sightings,
  tailOf,
  companionOf,
}: UsageLaneContext): UsageTailsLane {
  let disposed = false;
  /** Panes a native watcher is armed for, or is being armed for. */
  const tailed = new Set<string>();
  /**
   * Panes whose store this lane is currently ASKING a dialect to find.
   *
   * Separate from `tailed`, and that separation is the whole point: a search
   * is not an arm. Held in one set, a search that comes back empty releases
   * the pane — and if a binding armed a real tail while the search was out,
   * that release tears the tail down a moment after it was built. Which is
   * exactly what happened: a claude pane bound, armed, and was unwatched
   * within the same second, so nothing read its transcript and the card sat
   * on "working" with no edge left to finish it.
   */
  const searching = new Set<string>();

  /** Whether this pane's process states its status facts itself: its
   * companion said hello from the process the pane is pinned to, and the
   * agent declares that the companion covers them. Then the store's status
   * records are not read at all — one source per process, never two. */
  const statusCovered = (paneId: string, agentId: string): boolean =>
    (companionOf(agentId)?.covers.includes("status-records") ?? false) &&
    attribution.hasCompanion(paneId);

  /** Everything this pane's store has to be read for. The merge — and the
   * order it must happen in — belongs to the contract, not to this lane: see
   * [`tailWatches`]. */
  const watchesFor = (paneId: string, agentId: string): readonly TailWatch[] =>
    tailWatches(
      declarations.current().get(agentId)?.tail,
      statusCovered(paneId, agentId) ? undefined : tailOf(agentId),
    );

  /** What each armed pane was armed WITH — so a companion arriving after the
   * arm can re-arm it without the status records, and only when that changes
   * what is read. The entry itself is the arming: a command meant for one
   * checks, in its turn, that it is still the pane's. */
  const armedWith = new Map<string, Arming>();

  /** Each pane's tail commands, one at a time: the next goes once the core
   * answered the one before it. So the core carries them out in the order
   * this lane decided them — a let-go never overtakes the arming it lets go
   * of, an older arming never lands over a newer one, a narrowing or a link
   * reaches the tail it was meant for — which nothing on the core's side
   * could put right afterwards. */
  const turns = new Map<string, Promise<void>>();

  /** Run `step` in the pane's turn: once every command before it for the pane
   * was answered. Its outcome is its caller's; the next turn waits only for
   * it to end. */
  const inTurn = <T>(paneId: string, step: () => Promise<T>): Promise<T> => {
    const ran = (turns.get(paneId) ?? Promise.resolve()).then(step);
    const over = ran.then(
      () => undefined,
      () => undefined,
    );
    turns.set(paneId, over);
    void over.then(() => {
      if (turns.get(paneId) === over) turns.delete(paneId);
    });
    return ran;
  };

  /** Per armed pane, the ids of the other stores its records named that are
   * linked or being linked. A new arm starts it empty: the fresh tail reads
   * the records that name them again. */
  const links = new Map<string, Set<string>>();

  /** From when the pane's store must be read again for its calls: what the
   * ledger has not booked of the session yet. Unknown is the whole store —
   * the ledger books each call once however often it is read. */
  const sinceFor = (paneId: string, agentId: string, sessionId: string) =>
    usageSince(agentId, sessionId, sightings.sight(paneId, sessionId)).catch(
      (error: unknown) => {
        log.debug(
          "web:usage",
          `${paneId}: no booking horizon, reading the whole store: ${errorMessage(error)}`,
        );
        return null;
      },
    );

  /** Arm one pane's follower, letting go of the arming before it. A failure
   * is this arming's own: it ends it, and leaves alone any arming of the
   * pane since — which also puts the pane back for the next attempt. */
  const arm = (paneId: string, { path, token, agentId, sessionId }: Armed): Promise<void> => {
    const watches = watchesFor(paneId, agentId);
    const siblings = declarations.current().get(agentId)?.tail?.siblings?.(path) ?? null;
    letGo(paneId);
    const armed: Arming = { path, token, agentId, sessionId, covered: statusCovered(paneId, agentId) };
    armedWith.set(paneId, armed);
    links.set(paneId, new Set());
    return inTurn(paneId, async () => {
      const since = await sinceFor(paneId, agentId, sessionId);
      // Let go of while the ledger answered — retired, or armed afresh:
      // nothing is left for it to follow.
      if (armedWith.get(paneId) !== armed) return;
      await watchSessionFile(paneId, {
        path,
        agent: agentId,
        session: sessionId,
        watches,
        siblings,
        since,
      });
    }).catch((error: unknown) => {
      if (armedWith.get(paneId) === armed) {
        tailed.delete(paneId);
        letGo(paneId);
      }
      throw error;
    });
  };

  /** Follow one store a pane's records named, in the pane's tail. The agent
   * says where it is; the core reads it with the pane's own. An id that does
   * not link is forgotten, so the next reading that names it tries again. */
  const linkOne = async (paneId: string, id: string, known: Set<string>) => {
    const agentId = armedWith.get(paneId)?.agentId;
    const locate = agentId ? declarations.current().get(agentId)?.tail?.locate : undefined;
    const path = locate ? await locate(id) : null;
    const linked = await inTurn(paneId, async () => {
      // Re-armed meanwhile: the fresh tail names it again, and the core's
      // tail is not the one this store was named in.
      if (disposed || links.get(paneId) !== known) return true;
      return path ? linkSessionFile(paneId, path) : false;
    });
    if (!linked) known.delete(id);
  };

  const link = (paneId: string, ids: readonly string[]) => {
    const known = links.get(paneId);
    if (disposed || !known) return;
    for (const id of ids) {
      if (known.has(id)) continue;
      known.add(id);
      void linkOne(paneId, id, known).catch((error: unknown) => {
        known.delete(id);
        log.warn("web:usage", `${paneId}: store ${id} not followed: ${errorMessage(error)}`);
      });
    }
  };

  /** Stop following a pane's file — the one place an arming ends, in the
   * pane's turn behind whatever was sent for it before. Nothing waits on it,
   * so a failure is said rather than left unhandled. */
  const letGo = (paneId: string) => {
    if (!armedWith.delete(paneId)) return;
    links.delete(paneId);
    void inTurn(paneId, () => unwatchSessionFile(paneId)).catch((error: unknown) => {
      log.warn("web:usage", `${paneId}: session file not let go: ${errorMessage(error)}`);
    });
  };

  const desiredPanes = () => {
    const desired = new Set<string>();
    const usage = declarations.current();
    for (const workspace of deck.getSnapshot().workspaces) {
      for (const pane of workspace.panes) {
        if (
          paneHasProcess(workspace, pane) &&
          usage.get(pane.agentType)?.tail
        ) {
          desired.add(pane.id);
        }
      }
    }
    return desired;
  };

  const armRecordedTails = () => {
    if (disposed) return;
    const usage = declarations.current();
    for (const workspace of deck.getSnapshot().workspaces) {
      for (const pane of workspace.panes) {
        if (!paneHasProcess(workspace, pane)) continue;
        const sessionId = pane.session?.id;
        if (!sessionId || tailed.has(pane.id) || searching.has(pane.id)) {
          continue;
        }
        const paneId = pane.id;
        const agentId = pane.agentType;
        const tail = usage.get(agentId)?.tail;
        if (!tail) continue;
        // No secret, no tail to arm: nothing to search for yet.
        if (!peekPaneSpawnSpec(paneId)?.token) continue;

        const dialect = tailOf(agentId);
        if (!dialect) {
          // Nothing to ask. An agent whose plugin declares no dialect has no
          // store this lane can find on its own — the host used to know
          // where one CLI kept its files, and that knowledge went home.
          //
          // This used to be gated to ONE agent by name, which was the host
          // saying out loud that it knew whose sessions could be resumed
          // outside the deck. Asking whoever can be asked is the same
          // behaviour: a dialect with nothing to find answers null.
          continue;
        }
        searching.add(paneId);
        log.debug("web:usage", `${paneId}: asking ${agentId} to find ${sessionId}`);
        void dialect
          // The pane's OWN directory, or null: a bare pane hands the dialect
          // nothing, not the workspace cwd — following the project root for
          // a pane that never had a worktree is a search of somebody else's
          // directory.
          .follow({ sessionId, store: null, cwd: paneWorktree(workspace, pane)?.cwd ?? null })
          .then((request) => {
            // `delete` answers whether this search was still wanted: a pane
            // that left the deck while the walk was out is dropped from the
            // set by `reconcile`, and the answer then has nowhere to go.
            const stillWanted = searching.delete(paneId);
            const path = request?.path;
            if (!path) {
              log.debug(
                "web:usage",
                `${paneId}: ${agentId} has no store for ${sessionId} yet`,
              );
              return;
            }
            // A binding may have armed this pane while the search was out —
            // its tail is the better one, built from a path the agent
            // REPORTED rather than one found by walking. Leave it alone.
            if (disposed || !stillWanted || tailed.has(paneId)) return;
            // The secret, like the watches inside `arm`, is read after the
            // search: finding a store is a walk, and a plan minted or a
            // plugin toggled during it would leave this arming what no
            // longer stands.
            const secret = peekPaneSpawnSpec(paneId)?.token;
            if (!secret) return;
            tailed.add(paneId);
            // Its failure is the arming's, not the search's: the arming
            // ended itself, and the pane is armed again on the next round.
            void arm(paneId, { path, token: secret, agentId, sessionId }).catch((error: unknown) => {
              log.warn("web:usage", `session-file tail for ${paneId} failed: ${errorMessage(error)}`);
            });
          })
          .catch((error) => {
            // Only the search is abandoned. A tail armed from a binding
            // meanwhile is untouched — a failed WALK says nothing about a
            // path the agent reported for itself.
            searching.delete(paneId);
            log.warn(
              "web:usage",
              `store lookup for ${paneId} failed: ${error}`,
            );
          });
      }
    }
  };

  const reconcile = () => {
    if (disposed) return;
    const desired = desiredPanes();
    for (const paneId of [...tailed]) {
      // A tail stands while the secret it was armed with is still the
      // pane's. A plan retired, or another minted since, is another
      // generation's — the next arm follows under the plan that stands then.
      const armed = armedWith.get(paneId);
      if (desired.has(paneId) && armed !== undefined && armed.token === peekPaneSpawnSpec(paneId)?.token) continue;
      tailed.delete(paneId);
      letGo(paneId);
    }
    // A pane that left the deck while its store was being looked for: the
    // answer, when it comes, has nowhere to go.
    for (const paneId of [...searching]) {
      if (!desired.has(paneId)) searching.delete(paneId);
    }
    armRecordedTails();
  };

  // ACCEPTED bindings, not raw reports. Judging the report a second time here
  // would ask a stateful question twice: the binding lane pins the pane's
  // generation as it accepts, so this lane's own verdict on the very same
  // report would come back "already bound" and the tail would never arm.
  const unsubscribeBindings = bindings.subscribe((bound) => {
    if (disposed) return;
    const { paneId, sessionId, transcriptPath } = bound;
    if (!transcriptPath) {
      log.debug(
        "web:usage",
        `${paneId}: binding carries no transcript — no tail`,
      );
      return;
    }
    const workspace = findWorkspaceOfPane(
      deck.getSnapshot().workspaces,
      paneId,
    );
    const pane = workspace?.panes.find((candidate) => candidate.id === paneId);
    if (!pane) return;
    const agentId = pane.agentType;
    const tail = declarations.current().get(agentId)?.tail;
    if (!tail) {
      log.debug(
        "web:usage",
        `${paneId}: agent declares no tail — skipped`,
      );
      return;
    }

    // Accepted only while the pane holds a plan that reports, so its secret
    // stands: the tail is armed under it.
    const token = peekPaneSpawnSpec(paneId)?.token;
    if (!token) return;
    // The agent's own declaration of which records to carry, handed through
    // verbatim: the backend applies it without reading it.
    log.debug(
      "web:usage",
      `${paneId}: arming ${agentId} tail from binding${statusCovered(paneId, agentId) ? " — status stated by its companion, usage records only" : ""}`,
    );
    tailed.add(paneId);
    void arm(paneId, { path: transcriptPath, token, agentId, sessionId }).catch((error: unknown) => {
      log.warn("web:usage", `session-file tail for ${paneId} failed: ${errorMessage(error)}`);
    });
  });

  /** A companion now states the pane's status facts: the tail stops carrying
   * the store's status records from where it stands. Nothing it already read
   * is owed again, so the store — a resumed session's can run to hundreds of
   * megabytes — is not re-read. A tail that refuses is armed afresh: the
   * store re-read from its start, the arming before it let go of. Only while
   * `armed` is still the pane's arming — asked in the pane's turn, and again
   * once the core answered — so a narrowing never reaches a later arming's
   * tail. */
  const narrow = (paneId: string, armed: Arming): Promise<void> =>
    inTurn(paneId, async () => {
      if (armedWith.get(paneId) !== armed) return true;
      armed.covered = true;
      return retargetSessionFile(paneId, watchesFor(paneId, armed.agentId));
    }).then((narrowed) => {
      if (narrowed || disposed || armedWith.get(paneId) !== armed) return;
      return arm(paneId, armed);
    });

  // A companion that says hello after the pane armed changes what the store
  // is read for; nothing else does. A companion leaves only with its process,
  // whose retire drops the plan first — and the tail goes with the secret it
  // was armed under, so the next arm reads the store for the turns again.
  const unsubscribeCompanions = attribution.subscribeCompanions((paneId) => {
    if (disposed || !tailed.has(paneId)) return;
    const armed = armedWith.get(paneId);
    if (!armed || armed.covered || !statusCovered(paneId, armed.agentId)) return;
    log.debug("web:usage", `${paneId}: its companion states its turns — narrowing its tail`);
    void narrow(paneId, armed).catch((error: unknown) => {
      // Its own arming's failure, ended by that arming alone: a later one
      // the pane holds meanwhile is not this narrowing's to end.
      if (armedWith.get(paneId) === armed) {
        tailed.delete(paneId);
        letGo(paneId);
      }
      log.warn("web:usage", `session-file re-arm for ${paneId} failed: ${errorMessage(error)}`);
    });
  });
  const unsubscribeDeck = deck.subscribe(reconcile);
  const unsubscribeDeclarations = declarations.subscribe(reconcile);
  // A pane's secret is its plan's: told when a plan is dropped or lands.
  const unsubscribePlans = subscribeSpawnSpecs(reconcile);
  const retryTimer = globalThis.setInterval(
    armRecordedTails,
    TAIL_RETRY_MS,
  );
  reconcile();

  return {
    link,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeCompanions();
      unsubscribeDeck();
      unsubscribeDeclarations();
      unsubscribePlans();
      globalThis.clearInterval(retryTimer);
      unsubscribeBindings();
      for (const paneId of [...armedWith.keys()]) letGo(paneId);
      tailed.clear();
      searching.clear();
      links.clear();
    },
  };
}
