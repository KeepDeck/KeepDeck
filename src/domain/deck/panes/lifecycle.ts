/**
 * What a pane may do right now: whether a process belongs behind it, whether
 * it can be suspended or parked, and what stops it.
 *
 * Every one of these is a QUESTION about the durable model — no pane state is
 * decided here. They live together because they read the same two fields
 * (`idle`, `provisioning`) and answering one of them differently from another
 * is exactly how a pane ends up both "stopped" and "waking".
 */
import type { AgentType, ResumeOrigin } from "../../agents";
import type { Pane, PaneIdle } from "./model";

/** The agent a pane runs — panes minted before the field existed ran claude,
 *  so the default is part of the persisted format, not a UI convenience. */
export function paneAgentType(pane: Pane): AgentType {
  return pane.agentType ?? "claude";
}

/** A remote pane runs its agent against a VPS endpoint and is fresh-session
 *  only — it has no local working directory to probe and must NEVER be handed
 *  to a resume/restart/bind path, which would spawn locally and silently drop
 *  the endpoint. The single predicate every consume site consults so the
 *  invariant lives in one place (not copy-pasted at each call site). Truthy
 *  (not `!== undefined`): an empty-string endpoint is a non-remote degenerate
 *  case, matching spawnSpecs' own truthy target-builder and the inline checks
 *  this centralized. */
export function paneIsRemoteFresh(pane: Pane): boolean {
  return !!pane.remoteEndpoint;
}

/** Whether this pane is one that HAS a process — the durable half of the
 *  question, which is all the model can answer: whether the process is
 *  currently alive is the session registry's half.
 *
 *  A pane with an idle marker has none (stopped, parked, or still on its way
 *  up), and one whose worktree create is in flight has never had one. Five
 *  surfaces ask this to decide who gets telemetry: the usage roster, the two
 *  usage-tail lanes, the limits poller and the close dialog's session count.
 *  They spelled it out by hand and one of them — the limits poller — dropped
 *  the `provisioning` half, so it fired real provider requests for panes the
 *  top bar was deliberately withholding a chip from. One predicate, so the
 *  next reason a pane has no process reaches all five at once. */
export function paneHasProcess(pane: Pane): boolean {
  return !pane.idle && !pane.provisioning;
}

/** Whether this pane can be suspended right now — the boolean form of
 *  [`paneSuspendBlock`], which is what every UI surface calls, because each
 *  of them has to SAY why it refuses. This form is for the caller that only
 *  needs the verdict: the reducer's own guard on `suspendPane`.
 *
 *  Excluded: a pane that is already idle (nothing to stop); one whose worktree
 *  create is still in flight (no process yet, and its create must not be
 *  stranded); and a REMOTE pane, whose conversation lives on the server with
 *  no local session to resume — stopping its thin client and reattaching
 *  would quietly start a different conversation. An EXITED pane qualifies:
 *  parking a dead agent is meaningful (its card becomes the honest "stopped"
 *  one, and resuming rebuilds its resume plan), and the exit is runtime state
 *  this durable model deliberately doesn't carry. */
export function paneCanSuspend(pane: Pane, blocked: boolean): boolean {
  return paneSuspendBlock(pane, blocked) === null;
}

/** WHY a pane can't be suspended, or null when it can. A reason rather than a
 *  bare `false` because three surfaces have to explain the refusal — the
 *  hotkey, the command and the close dialog — and a boolean forces each to
 *  guess, which is how one of them came to tell a remote pane's user that
 *  their running agent "has no session to stop". Mirrors the `ResumeBlock`
 *  shape the session picker already uses for the same job. */
export type PaneSuspendBlock = "stopped" | "provisioning" | "remote";

/** `blocked` is the sweep's runtime verdict that the pane's directory is gone
 *  — the same argument [`idleReadsAsStopped`] takes, and for the same reason:
 *  such a pane has no process and is going nowhere, so every surface has to
 *  agree it is stopped. Passing it is what stops the close dialog from
 *  offering to suspend a pane the tile beside it draws as dead.
 *
 *  REQUIRED, deliberately. A default would let the next surface omit it and
 *  compile — which is exactly the disagreement this argument was added to
 *  end, and a caller reading `false` would stamp a durable suspend onto a
 *  pane whose folder is gone. A caller with no sweep verdict to hand (the
 *  domain's own reducer guard) passes `false` and says so. */
export function paneSuspendBlock(
  pane: Pane,
  blocked: boolean,
): PaneSuspendBlock | null {
  // Only a pane that is STAYING down is refused. One still rising can be
  // stopped — that cancels the wake — and it matters: a pane whose wake is
  // waiting on a slow probe would otherwise be unparkable for as long as the
  // probe takes.
  if (idleReadsAsStopped(pane.idle, blocked)) return "stopped";
  if (pane.provisioning) return "provisioning";
  if (paneIsRemoteFresh(pane)) return "remote";
  return null;
}

/**
 * What is true of a pane BEFORE anything situational is asked about it, or
 * null when nothing is.
 *
 * The three answers every surface has to reach the same way and in the same
 * order: a pane with no directory yet cannot be acted on at all, a pane whose
 * agent no plugin provides explains itself whatever else is true, and a pane
 * carrying an idle marker is down by a decision someone made.
 *
 * Shared because both ladders that consume it — [`paneRunIntent`] and
 * [`paneBody`] — had this prefix written out separately, each restating the
 * order and the reasons in a comment. They diverge legitimately AFTER it (one
 * asks whether a process belongs, the other what the user sees, and a running
 * background pane needs opposite answers), so only the head is shared.
 */
export type PaneBlock =
  | { kind: "provisioning" }
  | { kind: "agent-unavailable"; agent: AgentType }
  | { kind: "stopped"; by: PaneIdle };

export function paneBlock(pane: Pane, agentAvailable: boolean): PaneBlock | null {
  if (pane.provisioning) return { kind: "provisioning" };
  if (!agentAvailable) {
    return { kind: "agent-unavailable", agent: paneAgentType(pane) };
  }
  return pane.idle ? { kind: "stopped", by: pane.idle } : null;
}

/**
 * Which pane holds a recorded session, and whether it reads as running or
 * stopped — or null when no pane holds it.
 *
 * A session runs in at most one pane, ever, and three surfaces need to say so
 * in agreement: the picker dims a claimed row, a resume refuses with a
 * sentence naming where to go instead, and the flow re-checks after its
 * build. All three matched on `session?.id` by hand and composed the stopped
 * reading themselves, from two different blocked-map channels — so a fourth
 * reason to read as stopped would have made the row say "running" while the
 * error said "stopped pane", pointing the user at a card with no button.
 *
 * `blocked` is the sweep's gone-directory verdict, for the reason
 * [`idleReadsAsStopped`] takes it: such a pane is staying down whatever its
 * own marker says.
 */
export function sessionClaimant(
  workspaces: { panes: Pane[] }[],
  sessionId: string,
  blocked: (paneId: string) => boolean,
): { pane: Pane; reads: "running" | "stopped" } | null {
  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      if (pane.session?.id !== sessionId) continue;
      // "Stopped" only for a pane STAYING down: one on its way up will be
      // running in a moment, and sending the user to resume it there points at
      // a card with no button.
      return {
        pane,
        reads: idleReadsAsStopped(pane.idle, blocked(pane.id))
          ? "stopped"
          : "running",
      };
    }
  }
  return null;
}

/**
 * Whether the launch policy may park this pane: still on its way up by the
 * sweep's OWN reasons, never one a user just asked for.
 *
 * A predicate rather than a condition restated at the store boundary, for the
 * reason its sibling [`paneCanSuspend`] is: the decision and the guard that
 * enforces it must not be able to drift, and a fourth `ResumeOrigin` exempt
 * from parking would otherwise have to be remembered in two files. Getting
 * that wrong is silent — the sweep decides `parked` on every pass while the
 * store refuses, and the pane waits on "Waking up…" for a start that is not
 * coming.
 */
export function paneCanPark(pane: Pane | undefined): boolean {
  return pane?.idle?.reason === "waking" && pane.idle.origin !== "manual";
}

/** Whether an idle marker is one the revive sweep acts on by itself: a pane
 *  on its way up, whoever asked. A `suspended` or `parked` one is staying
 *  down until someone says otherwise. Module-private: every consumer asks one
 *  of the `Pane`-shaped questions below, which all funnel through here. */
function idleWakesAutomatically(idle: PaneIdle): boolean {
  return idle.reason === "waking";
}

/** Whether the revive sweep may wake this pane on its own — the boolean form
 *  of [`paneWakeOrigin`], which is what the sweep itself reads (it needs WHO
 *  asked, not just whether). Kept for the callers that only need the yes/no:
 *  the close dialog's "is it starting up" sentence. */
export function paneWakesAutomatically(pane: Pane): boolean {
  return !!pane.idle && idleWakesAutomatically(pane.idle);
}

/** Whether this idle marker OUTLIVES the session that produced it. The one
 *  place the answer lives, because two layers ask it about the same pane and
 *  had a copy each: the codec decides what to write, and the save scheduler
 *  decides what may not wait for the debounce. A reason added to one alone
 *  reaches disk only on the timer, so a quit inside that window loses it —
 *  which is the whole reason the immediate lane exists.
 *
 *  A THIRD site names the same reasons and cannot call this: `readIdle` in
 *  the codec, which validates an `unknown` from disk and so cannot be handed
 *  a `PaneIdle`. Adding a durable reason means editing both — otherwise it is
 *  written on quit and degraded to `parked` on the next launch. */
export function paneIdleIsDurable(idle: PaneIdle | undefined): boolean {
  return idle?.reason === "suspended";
}

/** Whether this pane was explicitly suspended by the user. Kept as a pane
 * question (rather than repeated `idle?.reason` checks) because rendering,
 * hotkey targeting, and notification visibility must all agree when the
 * suspended-agent placement is Tray. */
export function paneIsSuspended(pane: Pane): boolean {
  return pane.idle?.reason === "suspended";
}

/** WHO asked for this pane to come up, or null when it isn't coming up at
 *  all. The sweep's one reader: taking the origin from an accessor rather
 *  than re-deriving `pane.idle?.reason === "waking" ? … : "restore"` at each
 *  site means a future reason that also wakes automatically cannot silently
 *  answer "restore" — the origin that lets a rejected session id become a
 *  different conversation. */
export function paneWakeOrigin(pane: Pane): ResumeOrigin | null {
  return pane.idle?.reason === "waking" ? pane.idle.origin : null;
}

/** Whether a pane READS as stopped to the user — no process, and nothing
 *  bringing it back on its own. One exported rule rather than a boolean
 *  passed down, because two surfaces ask it about the same pane (its tile
 *  dims, its minimized stand-in gets a marker) and they must not be able to
 *  disagree — nor to be handed a combination that contradicts itself.
 *
 *  `blocked` is the sweep's runtime verdict that the pane's directory is
 *  gone: such a pane is technically still rising, but it is stuck there until
 *  someone relocates it, so it reads as stopped like any other. */
export function idleReadsAsStopped(
  idle: PaneIdle | undefined,
  blocked: boolean,
): boolean {
  if (!idle) return false;
  return !idleWakesAutomatically(idle) || blocked;
}

/** The session this pane would come back to, or null when it would start a
 *  new one. One place, because three layers ask it and must agree: the card
 *  that NAMES the session to the user, the sweep that builds the resume plan,
 *  and the restart that picks resume-vs-fresh. A remote pane always answers
 *  null — its conversation lives on the server, so a local resume would be a
 *  different one. */
export function paneResumeSessionId(pane: Pane): string | null {
  return paneIsRemoteFresh(pane) ? null : (pane.session?.id ?? null);
}
