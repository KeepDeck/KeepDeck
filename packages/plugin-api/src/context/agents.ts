import type { Disposable } from "./disposable.ts";
import type { WorkspaceRef } from "./snapshots.ts";
import type { AgentUsage } from "./usage.ts";

/**
 * Agent contributions — teaching KeepDeck a CLI agent. Static identity is
 * data; the CLI-specific logic lives in hooks the host calls at lifecycle
 * points, with serializable input/output mutated in place (the opencode
 * model). Serializable I/O is what lets the same hook run in-process or
 * across the external tier's RPC boundary.
 *
 * FORWARD SURFACE: declared ahead of a consumer on purpose — the CLI agents
 * (claude/codex/opencode) migrate onto this in a later stage. Until then the
 * host's own spawnSpecs/domain/agents is the live spawn path; when the
 * migration lands, reconcile this contract against that mechanism so the two
 * spawn models don't drift.
 */
export interface PluginAgents {
  register(agent: AgentContribution): Disposable;
}

export interface AgentContribution {
  id: string;
  label: string;
  /** The agent's brand mark, shown wherever the host names the agent. */
  icon?: AgentIcon;
  /** How to find the CLI on this machine. */
  detect: { bin: string };
  /** Whether this CLI can run with its permission prompts disabled (YOLO
   * mode). Declares the capability only — the host gates its YOLO toggle on
   * it; the hooks are where `input.yolo` becomes the CLI's actual flag. */
  supportsYolo?: boolean;
  hooks: AgentHooks;
  /** How to read this agent's usage (limits, tokens, context) — see
   * `context/usage.ts`. Absent = the agent reports no usage. */
  usage?: AgentUsage;
  /** Read-only discovery over this agent's session store ([F8] browser).
   * Absent = the agent's sessions don't appear in the global search. */
  history?: AgentHistory;
  /** Declares this agent can run against a REMOTE target, and how. Absent =
   *  local-only: the agent never appears in the "Where" picker's remote
   *  options, and a pane of this agent simply ignores any target. The host
   *  gates the remote UI on this declaration (mirrors `supportsYolo`). */
  remote?: AgentRemote;
}

/** Where a pane's agent should run. Absent = the pane's own machine (local),
 *  the behavior every pane had before remote. The host sets this from the
 *  pane's recorded target; a plugin's `spawn.plan` reads it to emit the
 *  agent's remote-client argv. */
export type SpawnTarget = {
  kind: "nativeServer";
  /** The agent-server endpoint the local thin-client attaches to (e.g.
   *  `ws://127.0.0.1:4500` for codex app-server, reached over an SSH tunnel
   *  the host owns). */
  endpoint: string;
};

/** How an agent runs against a remote target. MVP: `nativeServer` — the agent
 *  has its own client/server split; the host runs the LOCAL thin-client TUI
 *  (a normal PTY pane) pointing at a remote server endpoint. The host owns
 *  provisioning the server on the box and the tunnel; the plugin only fills
 *  the client argv via `spawn.plan`. */
export interface AgentRemote {
  mode: "nativeServer";
}

/** A brand mark as bare SVG path data — data, never markup, so a plugin
 * cannot inject live SVG/HTML into the host chrome, and the icon crosses the
 * external tier's RPC boundary as plain JSON. Multi-tone artwork (e.g. the
 * official OpenCode frame + block cursor) is a stack of layers. */
export interface AgentIcon {
  /** Coordinate space every layer is drawn in, e.g. `"0 0 24 24"`. */
  viewBox: string;
  /** Filled shapes, painted in order; single-color marks are one layer. */
  paths: AgentIconPath[];
}

/** One filled layer of a brand mark. */
export interface AgentIconPath {
  /** Path data; multiple subpaths are filled as one shape. */
  d: string;
  /** This layer's fill; omit to inherit the surrounding text color. */
  color?: string;
  /** Fill rule the artwork was authored for; omit for SVG's default nonzero. */
  fillRule?: "evenodd";
}

export interface AgentHooks {
  /** Fill in how THIS CLI spawns for a pane: args, env, config injection. */
  "spawn.plan"?(
    input: SpawnPlanInput,
    output: SpawnPlanOutput,
  ): void | Promise<void>;
  /** Fill in how to resume a recorded session in a revived pane. */
  "resume.plan"?(
    input: ResumePlanInput,
    output: SpawnPlanOutput,
  ): void | Promise<void>;
  /** Fork the recorded session into `input.cwd` (the TARGET directory): a
   * NEW conversation copy — the original stays resumable where it was. The
   * hook performs its store surgery first (via the plugin's declared
   * `fsWrite`/`exec` capabilities), then fills how the forked session
   * spawns. Rejecting (throwing) must leave the store untouched. */
  "fork.plan"?(
    input: ForkPlanInput,
    output: SpawnPlanOutput,
  ): void | Promise<void>;
}

export interface SpawnPlanInput {
  paneId: string;
  workspace: WorkspaceRef;
  cwd: string;
  branch?: string;
  /** The pane runs with permission prompts disabled: a supporting hook adds
   * its CLI's skip-permissions flag. Absent on hosts older than API 20. */
  yolo?: boolean;
  /** The user's staged shared skills for this pane's workspace: a hook adds
   * its CLI's way of loading them. Absent when there is nothing to inject,
   * and on hosts older than API 22. */
  skills?: SpawnSkillsInput;
  /** Where the agent should run. Absent = local (and absent on hosts older
   * than API 27); a supporting agent's `spawn.plan` reads `kind`/`endpoint`
   * to emit its remote-client argv. A non-remote agent ignores it. */
  target?: SpawnTarget;
}

/** One skills library rendered in each CLI's injection dialect — staged
 * directories under KeepDeck's own home (absolute paths), never the user's
 * dotfiles or repo. A hook reads the view its CLI understands. */
export interface SpawnSkillsInput {
  /** Claude-plugin layout (`.claude-plugin/plugin.json` + `skills/`) —
   * made for `claude --plugin-dir`. */
  claudePluginDir: string;
  /** OpenCode config-directory layout — made for the `OPENCODE_CONFIG_DIR`
   * env var. Carries `skills/` AND a generated `command/` subdir (each
   * skill's user-facing `/name` palette command); treat both as the host's
   * to replace, everything else in the dir as opencode's own. */
  opencodeConfigDir: string;
  /** Bare standard layout (`<skill>/SKILL.md` at the top level) — kimi's
   * `--skills-dir`; the shape codex's `.agents/skills` would take once its
   * injection lands. */
  skillsDir: string;
}

export interface ResumePlanInput extends SpawnPlanInput {
  /** The recorded session to resume. */
  sessionId: string;
}

/** A cheap store enumeration entry — everything derivable WITHOUT opening
 * the session's content (ids ride in filenames/db rows). */
export interface AgentSessionStub {
  sessionId: string;
  /** Opaque per-plugin ref (usually the transcript path): the diff key the
   * host's incremental scan compares, and the handle for `describe`/
   * `content`/`transcript`. */
  ref: string;
  /** Last-activity stamp (epoch ms) — with `size`, the change fingerprint. */
  mtime: number;
  size: number;
}

/** The fields worth OPENING a session for — fetched only for new/changed
 * stubs. */
export interface AgentSessionFacts {
  cwd: string;
  title?: string;
  /** The session's transcript file, when the store has one — carried
   * explicitly so consumers never infer it from the ref's shape. */
  transcriptPath?: string;
}

export interface AgentTranscriptEntry {
  role: "user" | "assistant" | "other";
  text: string;
}

/** Read-only discovery over the agent's own store ([F8] global browser):
 * the plugin enumerates and parses (its format, its capability — fs or
 * sqliteReadonly); the host diffs, indexes and searches. Every method is
 * read-only by construction. */
export interface AgentHistory {
  /** Enumerate the whole store — stat-level, no content reads. */
  list(): Promise<AgentSessionStub[]>;
  /** The facts worth indexing, for one (new/changed) session. */
  describe(ref: string): Promise<AgentSessionFacts>;
  /** The searchable text (user+assistant turns) — feeds the FTS index. */
  content(ref: string): Promise<string>;
  /** One transcript page for the read-only viewer. */
  transcript(
    ref: string,
    page: { offset: number; limit: number },
  ): Promise<AgentTranscriptEntry[]>;
}

export interface ForkPlanInput extends SpawnPlanInput {
  /** The source session being forked. */
  sessionId: string;
  /** The directory the session was recorded in. It may no longer exist —
   * recipes operate on the agent's store, never on the original dir. */
  sourceCwd: string;
  /** The session's transcript/rollout file, when the reporter delivered it
   * — the exact source file for copy-based recipes. */
  transcriptPath?: string;
}

/** Mutate-in-place spawn plan: hooks adjust what the host will run. */
export interface SpawnPlanOutput {
  /** Program to run; `null` = the user's shell. */
  command: string | null;
  args: string[];
  env: [string, string][];
  /** Environment DEFAULTS: applied only when the spawned process would not
   * already inherit the key — a value the user set themselves (shell
   * profile, launchctl) always wins over a default. Use for config-home
   * style variables a user may legitimately own; plain `env` always
   * overrides. Prefilled `[]` on hosts of API 23+; push via
   * `(output.envDefaults ??= []).push(...)` to stay safe on older hosts. */
  envDefaults?: [string, string][];
}
