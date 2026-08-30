/**
 * The pane transforms: one workspace list in, the next one out.
 *
 * Fifteen answers to "what does this workspace list look like after X happens
 * to one pane" — renamed, put on a team, parked, suspended, bound to a
 * session, provisioned. They lived inside `workspaces.ts` beside workspace
 * CRUD, path arithmetic and an async worktree-name probe, which is why that
 * file's job could not be stated in one sentence.
 *
 * Every one of them is pure and total: an unknown workspace or pane leaves
 * the list untouched, so a caller never has to check first — `mapWorkspace`
 * is what keeps that promise in one place.
 */
import {
  paneCanPark,
  paneCanSuspend,
  type PaneIdle,
  type PaneSession,
  type PaneStopped,
  type PaneTeam,
} from "./index";
import { findPane, mapWorkspace, type Workspace } from "../workspaces";

export function renamePane(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  name: string,
): Workspace[] {
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) =>
      p.id === paneId ? { ...p, name: name.trim() || undefined } : p,
    ),
  );
}

/** Set a pane's auto title from the terminal (OSC title); empty clears it ([F11]).
 * The terminal can emit the same title repeatedly, so an unchanged (or absent)
 * pane returns the SAME array (no-op → no re-render), like the sibling pane
 * transforms — the guard lives here, not in the reducer. */
export function setPaneAutoTitle(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  title: string,
): Workspace[] {
  const next = title.trim() || undefined;
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane || pane.autoTitle === next) return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => (p.id === paneId ? { ...p, autoTitle: next } : p)),
  );
}

/** Put a pane on a team under a role, or take it off one (`null`).
 *
 * Validation is NOT here: whether a role is free is a question about the
 * whole workspace and belongs to `checkTeamAssignment`, which the caller
 * runs first. This applies a settled decision, and returns the SAME array
 * for a no-op like its sibling pane transforms. */
export function setPaneTeam(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  team: PaneTeam | null,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane) return workspaces;
  const next = team ?? undefined;
  if (pane.team?.name === next?.name && pane.team?.role === next?.role) {
    return workspaces;
  }
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      // Deleted rather than set to undefined: the pane is serialized, and a
      // key holding `undefined` is a key the round-trip has to think about.
      const { team: _dropped, ...rest } = p;
      return next ? { ...rest, team: next } : rest;
    }),
  );
}

/** Drop a pane's idle marker — the LAST step of waking one, run by the revive
 * sweep once it has probed the directory and built the resume plan. Named for
 * what it does rather than for the goal: calling it to "wake" a pane skips
 * both of those and spawns a fresh session into a directory that may be gone,
 * which is exactly what the sweep exists to prevent. To ask for a pane back,
 * use [`requestPaneWake`].
 *
 * Returns the SAME array when the pane is absent or already live, so a
 * repeated revive effect doesn't re-render anything. */
export function clearPaneIdle(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  // Only a pane still RISING is finished here. A suspend can land while the
  // sweep is mid-probe; clearing then would spawn the process the user just
  // stopped, so the late arrival simply finds nothing left to finish.
  if (pane?.idle?.reason !== "waking") return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      const { idle: _idle, ...live } = p;
      return live;
    }),
  );
}

/** Ask for a stopped pane back: it starts waking, which the revive sweep acts
 * on exactly like a restored pane — same directory probe, same resume-plan
 * build, same wake — while recording that a HUMAN asked. That distinction is
 * not cosmetic: a boot restore whose session id turns out dead may fall back
 * to a fresh conversation, and a resume someone clicked may not.
 *
 * The state the pane rose FROM rides along whole, so a wake that FAILS can
 * put it back exactly there ([`failPaneWake`]) rather than inventing a state
 * for it.
 *
 * Returns the SAME array for a live pane, one already on its way up, or an
 * unknown id. */
export function requestPaneWake(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  // A pane already rising for the SWEEP's own reasons is upgraded rather than
  // left alone: "a human asked" is new information even mid-wake, and it is
  // the only thing standing between a rejected session id and a silent new
  // conversation. Only a pane that is live, unknown, or already rising *by
  // request* has nothing to learn from this.
  if (!pane?.idle || (pane.idle.reason === "waking" && pane.idle.origin === "manual")) {
    return workspaces;
  }
  // Carried whole rather than as a field decoded back into a reason: a wake
  // that fails must restore what was there, and anything less than the marker
  // itself is a guess that gets worse every time the union grows. A wake
  // already in flight keeps whatever IT rose from — the upgrade changes who
  // asked, not where the pane came from.
  const from: PaneStopped | undefined =
    pane.idle.reason === "waking" ? pane.idle.from : pane.idle;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) =>
      p.id === paneId
        ? {
            ...p,
            idle: { reason: "waking", origin: "manual", ...(from && { from }) },
          }
        : p,
    ),
  );
}

/** A wake the user asked for could not be prepared — put the pane back down
 * instead of letting it come up as something else. Only a MANUAL wake is
 * reversed: a boot restore that can't build a resume plan takes the documented
 * fresh-start degradation, because nobody is watching it.
 *
 * The pane returns to the marker it rose FROM, put back verbatim: one that
 * was suspended reads exactly as it did before the failed attempt, stamp and
 * all. A pane that rose from nothing — parked at launch, or restored and then
 * asked for — goes back to `parked`, which is runtime-only. Writing
 * `suspended` there would forge a decision the user never made AND make it
 * durable, so turning the launch policy off could never bring that pane back.
 *
 * Returns the SAME array unless the pane really is mid-manual-wake. */
export function failPaneWake(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (pane?.idle?.reason !== "waking" || pane.idle.origin !== "manual") {
    return workspaces;
  }
  const idle: PaneIdle = pane.idle.from ?? { reason: "parked" };
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => (p.id === paneId ? { ...p, idle } : p)),
  );
}

/**
 * Park a pane the launch policy says must not start: it stops rising and gets
 * the card its state deserves, instead of waiting behind a "starting" one for
 * a start that is never coming.
 *
 * Only a pane still on its way up by the SWEEP's own reasons. A pane asked for
 * by name is exempt — the policy governs what starts on its own, not what a
 * user just asked for — and a pane that is already running is never touched:
 * the setting decides how agents come back, and killing a live agent because
 * a preference changed would be a destruction nobody asked for.
 *
 * `parked` is runtime-only, so turning the policy off brings these panes back
 * on the next launch. Returns the SAME array when the pane is not eligible.
 */
export function parkPane(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  if (!paneCanPark(findPane(workspaces, workspaceId, paneId))) {
    return workspaces;
  }
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) =>
      p.id === paneId ? { ...p, idle: { reason: "parked" as const } } : p,
    ),
  );
}

/** Suspend a pane: mark it idle by the user's own decision, so nothing wakes
 * it but an explicit resume. The PTY teardown is the app layer's half — this
 * records the intent that outlives it (and the save).
 *
 * Returns the SAME array for any pane [`paneCanSuspend`] rejects. The guard
 * consults that predicate rather than restating it: this action is exported
 * through the deck barrel, so a future "suspend every agent here" would
 * otherwise park the remote panes the predicate exists to protect.
 *
 * `blocked` is false here because the domain has no sweep verdict to consult
 * — that lives in the app layer, which refuses such a pane before dispatching
 * (the orchestrator's). This guard is the backstop for the rules the MODEL can see,
 * and the argument is spelled out rather than defaulted so the omission is a
 * decision on the page instead of an invisible one. */
export function suspendPane(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  at: string,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane || !paneCanSuspend(pane, false)) return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) =>
      p.id === paneId ? { ...p, idle: { reason: "suspended", at } } : p,
    ),
  );
}

/** Record the agent session a live pane is bound to — the resume key persisted
 * with the deck ([F7]/[F8]) — or DROP it (`null`) when the recorded session
 * turned out dead (a fresh revive must not keep pointing at a ghost, or the
 * pane's real session is never re-bound). Same-id rebinds and clearing an
 * already-clear pane return the SAME array (no-op). */
export function setPaneSession(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  session: PaneSession | null,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane || (pane.session?.id ?? null) === (session?.id ?? null))
    return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      if (session) return { ...p, session };
      const { session: _dead, ...rest } = p;
      return rest;
    }),
  );
}

/** Detach a pane from its (gone) worktree so it can start fresh in the
 * workspace cwd ([F7] restore reconcile): drops `cwd`/`branch` AND the
 * recorded session — a directory-bound session can't resume somewhere else.
 * Returns the SAME array when there's nothing to drop. */
export function resetPaneLocation(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane || (!pane.cwd && !pane.branch && !pane.session))
    return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      const { cwd: _cwd, branch: _branch, session: _session, ...rest } = p;
      return rest;
    }),
  );
}

/** The pane's background worktree create landed: pin the pane to the created
 * worktree and drop the provisioning card so its terminal mounts. Returns the
 * SAME array when the pane is gone (closed mid-create — the stray worktree on
 * disk is accepted; worktrees survive closes anyway) or wasn't provisioning. */
export function resolvePaneProvisioning(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  worktree: { cwd: string; branch: string },
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane?.provisioning) return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId) return p;
      const { provisioning: _done, ...rest } = p;
      return { ...rest, cwd: worktree.cwd, branch: worktree.branch };
    }),
  );
}

/** Record why a pane's worktree create failed — the card flips to the failed
 * state showing it — or clear it (`null`) when a Retry starts, flipping back
 * to creating. Returns the SAME array for a gone / non-provisioning pane and
 * when the error already equals the target. */
export function setPaneProvisioningError(
  workspaces: Workspace[],
  workspaceId: string,
  paneId: string,
  error: string | null,
): Workspace[] {
  const pane = findPane(workspaces, workspaceId, paneId);
  if (!pane?.provisioning) return workspaces;
  if ((pane.provisioning.error ?? null) === error) return workspaces;
  return mapWorkspace(workspaces, workspaceId, (panes) =>
    panes.map((p) => {
      if (p.id !== paneId || !p.provisioning) return p;
      const { error: _old, ...intent } = p.provisioning;
      return {
        ...p,
        provisioning: error === null ? intent : { ...intent, error },
      };
    }),
  );
}
