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
  /** Lazy revive: a restored pane in a workspace nobody has opened waits. This
   * is what keeps opening the app from starting every agent at once. A pane
   * asked for BY NAME (a clicked Resume, `agent.resume` with a workspace
   * argument) is not subject to it — that request must reach a pane off
   * screen, or it would strand the pane in a state that is neither running nor
   * durably stopped. */
  | { kind: "workspace-inactive" };

/** What the decision cannot read off the pane itself. */
export interface PaneRunEnv {
  /** A plugin currently provides this pane's agent. */
  agentAvailable: boolean;
  /** The probe's verdict that the pane's directory is gone, else null. */
  missingDir: string | null;
  /** This pane's workspace is the one on screen. */
  workspaceActive: boolean;
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
  // No marker: the deck's own record says a process belongs here. Whether one
  // actually exists is the caller's half of the comparison, not the pane's.
  if (!idle) return { kind: "run", resume: null };
  if (idle.reason !== "waking") return hold({ kind: "stopped", by: idle });
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
