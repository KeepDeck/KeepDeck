import { useEffect, useRef, useState } from "react";
import type {
  AgentInfo,
  ResumeOrigin,
  SpawnPlanContext,
} from "../domain/agents";
import {
  findWorkspace,
  paneAgentType,
  paneIsRemoteFresh,
  paneResumeSessionId,
  paneWakesAutomatically,
  skillRootsOf,
  type Pane,
} from "../domain/deck";
import { describeError, log } from "../ipc/log";
import { probeWorktree } from "../ipc/worktree";
import { buildResumeSpec } from "./spawnSpecs";
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
  /** Probe the pane's directory again. A blocked pane is skipped by the sweep
   * for the rest of the session, so without this a folder that comes back —
   * an unmounted volume, a worktree recreated by hand — leaves the pane stuck
   * behind a card whose only other exit destroys its session binding. */
  retryBlocked(wsId: string, paneId: string): void;
}

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

  useEffect(() => {
    // Wait for the spawn context (a resume plan built without it would miss
    // the agent's identity mechanism) AND the catalog (see `agentsReady`).
    if (!active || !ctx || !agentsReady) return;

    /** Resolve the resume session and wake one pane. */
    const wake = async (pane: Pane, dir: string) => {
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
      const origin: ResumeOrigin =
        pane.idle?.reason === "waking" ? pane.idle.origin : "restore";
      log.info(
        "web:revive",
        `${pane.id} (${agentType}): ` +
          (sessionId ? `${origin} resume ${sessionId}` : "fresh"),
      );
      if (sessionId && ctxRef.current) {
        // Built through the agent plugin's resume.plan hook and cached
        // BEFORE the pane wakes — the mounting terminal reads it.
        let failure: string | null = null;
        try {
          const built = await buildResumeSpec(
            plugins,
            agentType,
            {
              paneId: pane.id,
              workspace: { id: active.id, instance: active.instance },
              cwd: dir,
              branch: pane.branch,
              yolo: pane.yolo,
              wsSkillRoots: skillRootsOf(active),
            },
            ctxRef.current,
            sessionId,
            origin,
          );
          // A `false` here is a plugin that offers no resume.plan hook at all
          // — no throw, no cached plan. Waking anyway would let the ordinary
          // fresh sweep start a NEW conversation whose reporter then
          // overwrites the binding, which is the same silent substitution the
          // `manual` origin exists to prevent.
          if (!built) failure = "This agent can't prepare a resume plan.";
        } catch (e) {
          failure = describeError(e);
        }
        if (failure) {
          if (origin === "manual") {
            // The user asked for THIS session by name. Put the pane back down
            // with its stamp intact and say why, rather than bring it up as
            // something else.
            log.warn(
              "web:revive",
              `${pane.id}: resume plan build failed — staying stopped: ${failure}`,
            );
            setWakeFailed((f) => ({ ...f, [pane.id]: failure }));
            deckRef.current.failPaneWake(active.id, pane.id);
            return;
          }
          // A boot restore takes the documented degradation: nobody is
          // watching, and an empty pane beats a pane that never comes back.
          log.warn(
            "web:revive",
            `${pane.id}: resume plan build failed — waking fresh: ${failure}`,
          );
        }
      }
      deckRef.current.clearPaneIdle(active.id, pane.id);
    };

    for (const pane of active.panes) {
      // Only a pane on its way up: a suspended or parked one waits for its
      // card's explicit gesture, which routes through the same wake below
      // once it flips the pane to `waking`.
      if (
        !paneWakesAutomatically(pane) ||
        pane.id in blocked ||
        waking.current.has(pane.id)
      )
        continue;
      // An agent no plugin provides must NOT wake: the spawn would run the
      // bare id as a command, and the presence check would answer "absent"
      // for the unknown store and WIPE a binding that resumes fine once the
      // plugin returns. The pane stays idle behind its
      // "agent unavailable" card.
      const agentType = paneAgentType(pane);
      if (!agentsRef.current.some((a) => a.id === agentType)) continue;
      waking.current.add(pane.id);
      // Asking again clears the last refusal, so the card doesn't keep
      // explaining a failure the user is already retrying.
      if (pane.id in wakeFailed) {
        setWakeFailed(({ [pane.id]: _gone, ...rest }) => rest);
      }
      // A remote pane's agent runs against a VPS endpoint — it has no local
      // working directory to probe (so a gone workspace cwd never blocks it)
      // and no recorded session to resume (fresh-session only). Wake it
      // straight to a fresh remote plan built by the spawn-spec sweep.
      if (paneIsRemoteFresh(pane)) {
        void wake(pane, active.cwd).finally(() =>
          waking.current.delete(pane.id),
        );
        continue;
      }
      const dir = pane.cwd ?? active.cwd;
      void probeWorktree(dir)
        .then((probe) => {
          if (probe.exists) return wake(pane, dir);
          log.warn(
            "web:revive",
            `${pane.id}: directory gone ${dir} → blocked tile`,
          );
          setBlocked((b) => ({ ...b, [pane.id]: dir }));
        })
        // A failed probe errs on the side of waking the pane fresh — worst
        // case the spawn itself reports the broken directory in the terminal.
        .catch((e) => {
          log.warn(
            "web:revive",
            `${pane.id}: probe failed, waking fresh: ${describeError(e)}`,
          );
          deckRef.current.clearPaneIdle(active.id, pane.id);
        })
        .finally(() => waking.current.delete(pane.id));
    }
  }, [active, blocked, ctx, agentsReady, agentIds, plugins]);

  const startFresh = (wsId: string, paneId: string) => {
    setBlocked(({ [paneId]: _gone, ...rest }) => rest);
    deckRef.current.resetPaneLocation(wsId, paneId);
    deckRef.current.clearPaneIdle(wsId, paneId);
  };

  /** Drop the block; the pane is still idle, so the sweep picks it up again on
   * the very next pass and re-probes. */
  const retryBlocked = (wsId: string, paneId: string) => {
    setBlocked(({ [paneId]: _gone, ...rest }) => rest);
    // A pane the user is retrying has, by definition, been asked for.
    deckRef.current.requestPaneWake(wsId, paneId);
  };

  return { blocked, wakeFailed, startFresh, retryBlocked };
}
