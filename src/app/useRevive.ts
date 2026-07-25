import { useEffect, useRef, useState } from "react";
import type {
  AgentInfo,
  ResumeOrigin,
  SpawnPlanContext,
} from "../domain/agents";
import {
  findPane,
  findWorkspace,
  paneAgentType,
  paneIsRemoteFresh,
  paneResumeSessionId,
  paneWakeOrigin,
  skillRootsOf,
  type Pane,
  type Workspace,
} from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { probeWorktree } from "../ipc/worktree";
import { buildResumeSpec, dropPaneSpawnSpec } from "./spawnSpecs";
import { useAppRuntime } from "./runtimeContext";
import type { Deck } from "./useDeck";

/**
 * Lazy revival of restored panes ([F7]): when a workspace with idle panes
 * is (or becomes) active, wake each one so its terminal mounts and spawns —
 * RESUMING its recorded agent session where one is known (the persisted,
 * hook-reported binding) and starting FRESH otherwise — an unbound pane is
 * never matched to a session by its directory, which would resume a FOREIGN
 * conversation whenever panes share a cwd. A resume plan is
 * pre-registered in the spawn-spec cache; a fresh wake takes the default plan
 * the render pass builds (which assigns/arms session identity, v2).
 *
 * Before waking, the pane's directory is probed — a pane whose worktree is
 * gone stays idle and is reported in `blocked`, so its tile can explain
 * itself and offer a fresh start in the workspace cwd instead.
 */
export interface ReviveApi {
  /** paneId → the missing directory (the idle tile's note). */
  blocked: Record<string, string>;
  /** paneId → why the resume the USER asked for could not be prepared. The
   * pane stayed stopped rather than coming up as a different conversation;
   * its card says this. Cleared when the pane is asked for again. */
  wakeFailed: Record<string, string>;
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

/** How one attempt to bring a pane up ended. */
type Attempt =
  | { kind: "woken" }
  /** The pane's directory is gone; it needs relocating, not retrying. */
  | { kind: "blocked"; dir: string }
  /** The probe or the resume plan refused; `why` is shown on the card. */
  | { kind: "failed"; why: string };

export function useRevive(
  deck: Deck,
  agents: AgentInfo[],
  ctx: SpawnPlanContext | null,
  /** The agent catalog reflects the booted plugin system — waking anything
   * earlier would misjudge every pane's agent as unknown. */
  agentsReady: boolean,
): ReviveApi {
  const { plugins } = useAppRuntime();
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const [wakeFailed, setWakeFailed] = useState<Record<string, string>>({});
  // Revivals in flight — re-renders while one is pending must not double-run.
  const waking = useRef(new Set<string>());
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const active = findWorkspace(deck.workspaces, deck.activeId);

  /** WHO is asking for this pane right now, or null when it is no longer
   * rising at all. Read from the LIVE deck rather than from the snapshot an
   * attempt started with: `requestPaneWake` can upgrade a boot restore to a
   * resume the user asked for by name — and a suspend can cancel the wake
   * outright — while a probe or a plan build is out. An attempt judged by the
   * stale answer is exactly how a resume becomes a different conversation. */
  const askedBy = (wsId: string, paneId: string): ResumeOrigin | null => {
    const pane = findPane(deckRef.current.workspaces, wsId, paneId);
    return pane ? paneWakeOrigin(pane) : null;
  };

  // Reap entries whose pane is gone (closed directly, or with its workspace):
  // ids are never reused, so without this the map only ever grows.
  useEffect(() => {
    const live = new Set(
      deck.workspaces.flatMap((w) => w.panes.map((p) => p.id)),
    );
    const reap = (prev: Record<string, string>) => {
      const kept = Object.entries(prev).filter(([paneId]) => live.has(paneId));
      return kept.length === Object.keys(prev).length
        ? prev
        : Object.fromEntries(kept);
    };
    setBlocked(reap);
    setWakeFailed(reap);
  }, [deck.workspaces]);

  // Re-run when the catalog's id set changes: re-enabling a cli plugin must
  // wake the panes its absence kept idle, without an app restart.
  const agentIds = agents
    .map((a) => a.id)
    .sort()
    .join("\n");

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
  const settle = (wsId: string, pane: Pane, attempt: Attempt) => {
    const origin = askedBy(wsId, pane.id);
    if (!origin) {
      // The pane stopped rising while this attempt was out — closed, or
      // suspended by a user who changed their mind mid-probe. Its verdict is
      // moot, and recording one would leave the card explaining a failure
      // nobody is waiting on (or block a pane nobody asked to wake).
      log.info(
        "web:revive",
        `${pane.id}: wake outcome dropped — the pane is no longer rising`,
      );
      return;
    }
    if (attempt.kind === "woken") {
      deckRef.current.clearPaneIdle(wsId, pane.id);
      return;
    }
    if (attempt.kind === "blocked") {
      log.warn(
        "web:revive",
        `${pane.id}: directory gone ${attempt.dir} → blocked tile`,
      );
      setBlocked((b) => ({ ...b, [pane.id]: attempt.dir }));
    } else {
      log.warn(
        "web:revive",
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
        deckRef.current.clearPaneIdle(wsId, pane.id);
      }
      return;
    }
    if (attempt.kind === "failed") {
      setWakeFailed((f) => ({ ...f, [pane.id]: attempt.why }));
    }
    // Drop the half-built plan with its failure flag, or the pane's next
    // wake lands on the plan-error tile instead of a terminal.
    dropPaneSpawnSpec(pane.id);
    deckRef.current.failPaneWake(wsId, pane.id);
  };

  useEffect(() => {
    // Wait for the spawn context (a resume plan built without it would miss
    // the agent's identity mechanism) AND the catalog (see `agentsReady`).
    if (!active || !ctx || !agentsReady) return;

    /** Resolve the resume session and wake one pane. */
    const wake = async (ws: Workspace, pane: Pane, dir: string) => {
      const agentType = paneAgentType(pane);
      // A recorded binding is TRUSTED: it came from the pane's own process
      // (the reporter posts at session creation), so it existed. If it was
      // deleted out from under us since, the resume fails VISIBLY in the
      // terminal — accepted, rare, and uniform across agents; the app never
      // reads an agent's session store. An unbound pane starts FRESH:
      // matching the newest session in the directory would resume a FOREIGN
      // conversation whenever panes share a cwd (the default — a worktree
      // is optional). A REMOTE pane is always fresh-session: even if a stale
      // binding clings to it, resuming would run locally and drop the
      // endpoint (the binding layer prevents new ones; this is the
      // consume-side guard).
      const sessionId = paneResumeSessionId(pane);
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
        "web:revive",
        `${pane.id} (${agentType}): ` +
          (sessionId ? `${origin} resume ${sessionId}` : "fresh"),
      );
      if (sessionId && ctxRef.current) {
        // Built through the agent plugin's resume.plan hook and cached
        // BEFORE the pane wakes — the mounting terminal reads it.
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
            ctxRef.current!,
            sessionId,
            asked,
          );
        let failure: string | null = null;
        try {
          let built = await plan(origin);
          // The upgrade can also land INSIDE the build, and the origin is
          // BAKED INTO the cached plan — it is what arms (or disarms) the
          // one-shot fall back to a fresh conversation. A plan built as a
          // restore therefore cannot serve a resume the user asked for by
          // name: build it again for the request that actually stands.
          // Terminates by construction — `restore` → `manual` is the only
          // transition, and `requestPaneWake` no-ops on an already-manual
          // pane, so this can run at most twice.
          const nowAsked = askedBy(ws.id, pane.id);
          if (built && nowAsked === "manual" && origin !== "manual") {
            log.info(
              "web:revive",
              `${pane.id}: asked for by name mid-build → rebuilding as a manual resume`,
            );
            origin = "manual";
            built = await plan("manual");
          }
          // A `false` here is "no plan was cached", and it covers two very
          // different causes: a plugin that offers no resume.plan hook at
          // all, and a build a newer decision invalidated mid-flight. The
          // sentence names neither, because this layer cannot tell them
          // apart — blaming the agent for the second one was simply false.
          // (Distinguishing them means a discriminated result from
          // `buildResumeSpec`, which three callers share.)
          //
          // Either way the pane must not wake: the ordinary fresh sweep would
          // start a NEW conversation whose reporter then overwrites the
          // binding, the silent substitution the `manual` origin prevents.
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
    };

    for (const ws of deckRef.current.workspaces) {
      for (const pane of ws.panes) {
        // Only a pane on its way up: a suspended or parked one waits for its
        // card's explicit gesture, which routes through the same wake below
        // once it flips the pane to `waking`.
        const origin = paneWakeOrigin(pane);
        if (!origin || pane.id in blocked || waking.current.has(pane.id))
          continue;
        // Lazy revive is about the panes that rise BY THEMSELVES: waking six
        // restored agents in a workspace nobody has opened is what the policy
        // exists to prevent. A pane someone asked for BY NAME is not that —
        // `agent.resume` takes a workspace argument precisely so it can reach
        // one that isn't on screen, and leaving that request unserved stranded
        // the pane in a state that is neither running nor durably stopped.
        if (ws.id !== active.id && origin !== "manual") continue;
        // An agent no plugin provides must NOT wake: the spawn would run the
        // bare id as a command, and the presence check would answer "absent"
        // for the unknown store and WIPE a binding that resumes fine once the
        // plugin returns. The pane stays idle behind its
        // "agent unavailable" card.
        const agentType = paneAgentType(pane);
        if (!agentsRef.current.some((a) => a.id === agentType)) continue;
        waking.current.add(pane.id);
        // A remote pane's agent runs against a VPS endpoint — it has no local
        // working directory to probe (so a gone workspace cwd never blocks it)
        // and no recorded session to resume (fresh-session only). Wake it
        // straight to a fresh remote plan built by the spawn-spec sweep.
        if (paneIsRemoteFresh(pane)) {
          void wake(ws, pane, ws.cwd).finally(() =>
            waking.current.delete(pane.id),
          );
          continue;
        }
        const dir = pane.cwd ?? ws.cwd;
        void probeWorktree(dir)
          .then((probe) => {
            if (probe.exists) return wake(ws, pane, dir);
            settle(ws.id, pane, { kind: "blocked", dir });
          })
          // A probe that REJECTS is a failed attempt like any other: it used
          // to wake the pane fresh regardless of who asked, which is exactly
          // the silent substitution the manual origin exists to prevent.
          .catch((e) =>
            settle(ws.id, pane, { kind: "failed", why: describeError(e) }),
          )
          .finally(() => waking.current.delete(pane.id));
      }
    }
    // `deck.workspaces` rather than just `active`: a pane asked for by name in
    // a workspace that isn't on screen is swept too, and its request arrives
    // as a workspaces change, not an activation.
  }, [deck.workspaces, active, blocked, ctx, agentsReady, agentIds, plugins]);

  const startFresh = (wsId: string, paneId: string) => {
    setBlocked(({ [paneId]: _gone, ...rest }) => rest);
    setWakeFailed(({ [paneId]: _forgotten, ...rest }) => rest);
    deckRef.current.resetPaneLocation(wsId, paneId);
    // Ask for a wake rather than clearing the marker outright: the pane is
    // pointed at the workspace folder now, and the sweep should probe it like
    // any other before mounting a terminal there.
    deckRef.current.requestPaneWake(wsId, paneId);
  };

  const resume = (wsId: string, paneId: string): ResumeRequest => {
    const pane = findPane(deckRef.current.workspaces, wsId, paneId);
    if (!pane) return "gone";
    if (pane.provisioning) return "provisioning";
    if (!pane.idle) return "running";
    // The same catalog gate the sweep applies. Asked here too, because the
    // sweep's version is a silent `continue`: marking the pane first would
    // strand it in a state nothing settles.
    const agentType = paneAgentType(pane);
    if (!agentsRef.current.some((a) => a.id === agentType)) return "unavailable";
    // Clear the last attempt's verdicts first: a stale block would make the
    // sweep skip this pane forever, and a stale note would explain a failure
    // the user is already retrying.
    setBlocked(({ [paneId]: _unblocked, ...rest }) => rest);
    setWakeFailed(({ [paneId]: _forgotten, ...rest }) => rest);
    deckRef.current.requestPaneWake(wsId, paneId);
    return "resuming";
  };

  return { blocked, wakeFailed, startFresh, resume };
}
