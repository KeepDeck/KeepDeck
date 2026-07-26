import type { ResumeOrigin } from "../agents";
import {
  paneAgentType,
  paneResumeSessionId,
  type Pane,
  type PaneStopped,
} from "./panes";
import type { AgentType } from "../agents";

/**
 * Whether a pane MAY have a process behind it right now, and when it may not,
 * why. One question, one answer — it was previously re-derived at every site
 * that needed it (the revive sweep's four-condition gate, the render's
 * card ladder, the suspend guard), each with its own order, which is how the
 * same pane came to read as running to one surface and stopped to another.
 *
 * This is the PROCESS question only. How a pane PRESENTS itself — dimmed,
 * marked in the tray, which card it shows — is a separate question with a
 * deliberately different shape: a suspended pane whose plugin was disabled is
 * both stopped by its user and unavailable, and the two facts are shown
 * together. Presentation reads `pane.idle` directly; do not derive it from
 * here.
 *
 * Pure: everything that is observed rather than recorded arrives in
 * [`PaneRunEnv`], so the decision is testable without a probe, a plugin host
 * or a render.
 */
export type PaneRunIntent =
  /** A process should be behind this pane. `resume` names the conversation it
   * must come back to, or null to start a new one. */
  | { kind: "run"; resume: PaneResume | null }
  /** No process, and why not. */
  | { kind: "hold"; reason: PaneHoldReason };

/** The recorded session a pane comes back to, and who asked — the origin is
 * what decides whether a rejected id may quietly become a new conversation. */
export interface PaneResume {
  sessionId: string;
  origin: ResumeOrigin;
}

export type PaneHoldReason =
  /** Its worktree is still being created (or failed): there is no directory to
   * run in yet, and spawning would land in somebody else's. */
  | { kind: "provisioning" }
  /** No installed plugin provides this pane's agent. Spawning would run the
   * bare agent id as a command, and the session-presence check would answer
   * "absent" for a store it cannot read and wipe a binding that resumes fine
   * once the plugin is back. */
  | { kind: "agent-unavailable"; agent: AgentType }
  /** It is down by a decision — the user's (`suspended`, dated) or the launch
   * policy's (`parked`). The marker is carried whole rather than flattened to
   * a flag: a wake that fails has to put the pane back exactly where it was. */
  | { kind: "stopped"; by: PaneStopped }
  /** Its directory is gone. It needs relocating, not retrying. */
  | { kind: "worktree-missing"; dir: string }
  /** Its workspace is not on screen. Deliberate economy, not laziness for its
   * own sake: a workspace nobody has opened may never be used, and starting
   * its agents costs memory, CPU and API budget for nothing. It applies to
   * EVERY pane that has no process yet, not only to restored ones — a pane
   * minted moments before the user switched away is as unopened as any other,
   * and gating on the restore marker left that hole.
   *
   * A pane asked for BY NAME (a clicked Resume, `agent.resume` with a
   * workspace argument) is exempt: that request must reach a pane off screen,
   * or it strands it in a state that is neither running nor durably stopped.
   *
   * NOT a reason to end anything. A pane already running when its workspace
   * leaves the screen holds here and keeps running — reading this as "must not
   * have a process" would kill every background agent on a switch. */
  | { kind: "workspace-inactive" };

/** What the decision cannot read off the pane itself. */
export interface PaneRunEnv {
  /** A plugin currently provides this pane's agent. */
  agentAvailable: boolean;
  /** The probe's verdict that the pane's directory is gone, else null. */
  missingDir: string | null;
  /** This pane's workspace is the one on screen. */
  workspaceActive: boolean;
  /** The launch policy: restored agents come back stopped rather than
   * resuming. Read LIVE and asked HERE, not applied once to the deck at
   * hydration — a pane that has not started yet is exactly what the setting
   * governs, whether it was restored a second ago or has been waiting in an
   * unopened workspace since the app booted. */
  parkOnLaunch: boolean;
}

export function paneRunIntent(pane: Pane, env: PaneRunEnv): PaneRunIntent {
  // Ordered by what makes the others moot. Provisioning first: without a
  // directory nothing else can be acted on. Availability next, matching the
  // card ladder — a pane whose agent no plugin provides explains THAT, whatever
  // else is also true of it.
  if (pane.provisioning) return hold({ kind: "provisioning" });
  if (!env.agentAvailable) {
    return hold({ kind: "agent-unavailable", agent: paneAgentType(pane) });
  }
  const idle = pane.idle;
  // No marker: nothing about this pane says it should stay down. It may still
  // have to wait for its workspace — whether a process ALREADY exists is the
  // caller's half of the comparison, and an existing one is never disturbed by
  // a hold.
  if (!idle) {
    return env.workspaceActive
      ? { kind: "run", resume: null }
      : hold({ kind: "workspace-inactive" });
  }
  if (idle.reason !== "waking") return hold({ kind: "stopped", by: idle });
  // The launch policy, before anything that describes HOW the pane would come
  // up: a pane it holds is not starting, so whether its directory still exists
  // and which workspace is on screen are questions about a start that is not
  // happening. A pane asked for BY NAME is exempt — the policy governs what
  // rises on its own, not what a user just asked for.
  if (env.parkOnLaunch && idle.origin !== "manual") {
    return hold({ kind: "stopped", by: { reason: "parked" } });
  }
  if (env.missingDir !== null) {
    return hold({ kind: "worktree-missing", dir: env.missingDir });
  }
  if (!env.workspaceActive && idle.origin !== "manual") {
    return hold({ kind: "workspace-inactive" });
  }
  // A remote pane answers null here (its conversation lives on the server, so
  // a local resume would be a different one) — the one predicate, not a second
  // copy of the rule.
  const sessionId = paneResumeSessionId(pane);
  return {
    kind: "run",
    resume: sessionId ? { sessionId, origin: idle.origin } : null,
  };
}

function hold(reason: PaneHoldReason): PaneRunIntent {
  return { kind: "hold", reason };
}
