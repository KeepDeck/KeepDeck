/**
 * What a pane's PTY spawn needs beyond the pane itself, and the per-install
 * constants it is built against.
 *
 * Application shapes, deliberately here and not in the domain. A plan is
 * argv, environment and two process credentials; the context is the bridge's
 * address and directory; the protocol version mirrors a constant in the Rust
 * bridge.
 * Every one of those changes when a MECHANISM changes — a CLI's flags, the
 * bridge's envelope — never when a product rule does, and no domain module
 * consumes any of them. (They were in `domain/agents` because they are plain
 * data with no imports; purity is not what makes something domain.)
 *
 * `ResumeOrigin` stays behind in the domain, and belongs there: WHO asked for
 * a resume decides whether a session that refuses may silently become a
 * different conversation, which is a product rule that survives replacing the
 * UI with a CLI.
 */
import type { ResumeOrigin, UnconnectedLaunch } from "../../domain/agents";
import type { SpawnSecrets } from "../../ipc/session";

/** Bridge protocol version this app speaks — a plain change counter over the
 * env schema AND the envelope schema.
 *
 * One number, three languages, and nothing but a comment held them together
 * until `scripts/reporterScripts.test.mjs` started pinning them. It said
 * "mirrors wire.rs" while wire.rs had moved on: the deck refused every
 * version but 2, this armed panes with 1, and it went unnoticed because
 * nothing reads the field — reporters carry the version in the envelope
 * themselves. A var that lies about its own protocol is a var the first
 * reporter to check it would refuse.
 *
 * 3: the bridge answers on a unix socket, named by `socket` where `url`
 * stood. */
export const BRIDGE_PROTOCOL_VERSION = 3;

/** Per-install constants, resolved once at boot (`session_spawn_context`). */
export interface SpawnPlanContext {
  /** This run's bridge directory — the root the panes' own live under;
   * "" = bridge unavailable, identity mechanisms off. */
  bridgeDir: string;
  /** Where this run's bridge door answers — its unix socket — and the only
   * lane a reporter has. "" = unavailable, and a pane is then armed with
   * nothing at all: a reporter with no address has nowhere to report, and
   * arming one anyway would leave it looking alive for its whole life. */
  bridgeSocket: string;
  /** Create (or reuse) the directory belonging to ONE pane and answer its
   * path. It carries the deck's doorbell — the one thing still travelling as
   * a file, because it runs deck-to-pane and the surface cannot push. Asked
   * per spawn, because it has to exist before the agent that watches it. */
  paneBridgeDir(paneId: string): Promise<string>;
}

/** A context with the bridge off — safe boot fallback. */
export const EMPTY_SPAWN_CONTEXT: SpawnPlanContext = {
  bridgeDir: "",
  bridgeSocket: "",
  paneBridgeDir: () => Promise.reject(new Error("the bridge is unavailable")),
};

/** What a pane's PTY spawn needs beyond the pane itself. */
export interface SpawnPlan {
  /** Program to run — the hook's word (prefilled with the detected binary;
   * `null` = the user's shell). Absent only on degraded bare plans. */
  command?: string | null;
  args: string[];
  env: [string, string][];
  /** Env pairs applied only when the key is NOT already inherited — a
   * user-owned variable beats a plugin's default (see SpawnPlanOutput). */
  envDefaults?: [string, string][];
  /** The plan starts the agent in YOLO, as its plugin says
   * (`SpawnPlanOutput.yolo`) — what the pane runs in until the agent reports
   * its own mode. Absent = not in YOLO. */
  yolo?: boolean;
  /** The PER-PANE bridge secret — NOT per build. A reporter must name it in
   * its envelope, and the bridge's door counts it only from the pane's own
   * terminal, while its session is live: reaching the door is not enough to
   * speak for a pane.
   *
   * INVARIANT: rebuilding a plan for a pane whose process is still alive
   * must REUSE the cached token (`buildPlan` does; any new plan-building
   * path must too) — the session was registered with the secret its process
   * was spawned with, and the tail lane keeps following under it. Only an
   * explicit restart, which drops the spec first, mints fresh. */
  token?: string;
  /** The PER-PANE MCP secret, minted and retired exactly like `token`: the
   * one an injected MCP server greets the deck's socket with. Both secrets
   * go to the spawn and are bound to the pane's terminal session, and the
   * socket door admits a caller that names EITHER of them from that
   * terminal while its session is live — the terminal decides the pane, the
   * secret only proves the caller came from it. Absent when nothing was
   * injected for this pane.
   *
   * The secret dies with the session, so a lingering MCP child of a dead
   * pane is refused instead of acting for whoever runs in that pane now.
   *
   * Minted for EVERY plan, whether or not anything was injected: kimi's
   * servers arrive as a file, so a pane can have a live client and no `mcp`
   * key here. Optional only because plans built before this existed have
   * none — it never answers "was MCP injected for this pane?". */
  mcpToken?: string;
  /** Host bookkeeping: the recorded session this plan tries to RESUME. Set
   * only on resume plans — the resume-failure detector keys off it. */
  resumeOf?: string;
  /** Host bookkeeping: this plan IS the one quiet retry a refused resume
   * earned. Its own silent death is then the SECOND, and the pane goes the
   * way `decideRejectedResume` says for a resume already retried. */
  resumeRetry?: boolean;
  /** Host bookkeeping: the source session cloned by a FORK plan. */
  forkOf?: string;
  /** The first accepted local session binding emitted by that fork — the
   * mark that the fork has started, so what only its start needed is
   * settled once and a later `/new` in the same process is not taken for
   * it. */
  forkSessionId?: string;
  /** Host bookkeeping: who requested this resume. The origin determines
   * whether a silent refusal is eligible for the one-shot fresh fallback. */
  resumeOrigin?: ResumeOrigin;
  /** Host bookkeeping: the pane's accepted-postback count when this plan
   * was built. An exit with the count still here means the resume never
   * became a session (see [`resumeDiedSilently`]). */
  postbackMark?: number;
  /** Why the deck cannot hear this plan's agent — set on a launch that fell
   * back to the bare floor (the plugin's plan threw, or an external plan
   * named a program it may not run), and on one given no bridge to report
   * through, whose setup it otherwise has. Absent = connected. */
  unconnected?: UnconnectedLaunch;
}

/** The variable a pane's reporters read the deck's address and secret from —
 * the bridge, as a plan arms it. */
export const BRIDGE_ENV = "KEEPDECK_BRIDGE";

/** Whether a plan's process can report to the deck at all: its environment
 * carries the bridge. A bare launch (task-572) does not, and neither does a
 * plan whose pane directory could not be made — a token alone is no lane.
 * Beside the shape it reads, like [`resumeDiedSilently`]. */
export function planReports(plan: SpawnPlan | undefined): boolean {
  return plan?.env.some(([key]) => key === BRIDGE_ENV) ?? false;
}

/** The secrets a plan's process tree is given, one per door, for the
 * sessions machine to judge its callers by: whoever names one a door counts,
 * from the pane's terminal, speaks for the pane. The MCP door counts either
 * — see [`SpawnPlan.mcpToken`] — the bridge only its own. Handed over as the
 * plan holds them: what counts as a secret at all — an empty one does not —
 * is the sessions machine's to say. */
export function planSecrets(plan: SpawnPlan): SpawnSecrets {
  return { mcp: plan.mcpToken, bridge: plan.token };
}

/** Whether a pane's RESUME died before ever becoming a session: its plan is
 * a resume, and not one accepted postback has arrived since it was built — a
 * working resume always reports first (every agent's startup hook posts
 * through the bridge). Such an exit is the CLI refusing the recorded id, for
 * good (deleted, GC'd, never materialized) or for a moment: what follows is
 * `decideRejectedResume`'s, by who asked for the resume. A stop the deck
 * itself asked for never reads as one: the machine drops the pane's plan
 * before each stop, so its exit finds no resume plan here.
 *
 * Here, beside the shape it reads, rather than in the cache's barrel: it holds
 * no cache state, and living there meant every suite that mocks the barrel had
 * to hand-copy it — so they went on asserting that auto-recovery is wired to a
 * rule the production code could have changed underneath them. */
export function resumeDiedSilently(
  spec: SpawnPlan | undefined,
  currentPostbacks: number,
): boolean {
  return !!spec?.resumeOf && spec.postbackMark === currentPostbacks;
}
