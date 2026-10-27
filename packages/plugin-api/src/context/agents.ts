import { isJsonRecord } from "../json.ts";
import { hasUnsafeText } from "../manifest/text.ts";
import type { Disposable } from "./disposable.ts";
import type { WorkspaceRef } from "./snapshots.ts";
import type { AgentStatus } from "./status.ts";
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
  /** How to find the CLI on this machine. When the manifest declares the
   * agent's `bin` statically (contributes.agents[].bin), this must match it
   * exactly — the host's availability gate reads the declaration before any
   * plugin code runs and rejects a drift at registration. */
  detect: { bin: string };
  hooks: AgentHooks;
  /** How to read this agent's usage (limits, tokens, context) — see
   * `context/usage.ts`. Absent = the agent reports no usage. */
  usage?: AgentUsage;
  /** How to read this agent's turn lifecycle (working / waiting / done /
   * failed) — see `context/status.ts`. Absent = the agent reports no
   * status and its pane shows none. */
  status?: AgentStatus;
  /** How to read this agent's session bindings, where its words differ from
   * the shared ones (API 63). Absent = the shared reading. */
  binding?: AgentBinding;
  /** What this agent's in-process companion takes over once it announces
   * itself from the pane's own process (API 61) — absent when the agent has
   * none. */
  companion?: AgentCompanion;
  /** How the host shows this agent where its CLI's habits matter (API 70):
   * decoration on its terminal titles, words for its own failure codes, its
   * colour in charts. Absent = the generic presentation. */
  presentation?: AgentPresentation;
  /** Read-only discovery over this agent's session store ([F8] browser).
   * Absent = the agent's sessions don't appear in the global search. */
  history?: AgentHistory;
  /** Which of this agent's sessions are LIVE right now — held by a process
   * (an interactive run elsewhere, a background agent owned by the CLI's
   * daemon), not by one of our panes. A snapshot, not a watch: the host
   * asks before acting on a resume refusal and when a picker opens.
   *
   * The QUESTION here is about live processes, not about the store — which
   * is why this is a sibling of `usage`/`status`/`history` and not a
   * history method. Absent = the agent cannot say, and a refused resume
   * keeps its old meaning. */
  liveSessions?: AgentLiveSessions;
}

/** Static presentation data — values the host reads, never code. */
export interface AgentPresentation {
  /** Glyphs the CLI puts at the start of its terminal titles as decoration
   * (each followed by whitespace). The host strips one from the pane's
   * title; another agent's leading glyph is left alone. */
  oscLeadingGlyphs?: readonly string[];
  /** Words for this CLI's own failure codes, beside the shared ones the host
   * already names (rate limits, overload, authentication). An unnamed code
   * is shown as `Failed: <code>`. */
  failureLabels?: Readonly<Record<string, string>>;
  /** This agent's series colour in usage charts, `#RRGGBB`. Without one the
   * host gives it a spare colour. */
  chartColor?: string;
}

/** The limits a presentation must keep: it is shown as it is, so it must be
 * small, plain text, and a colour the charts can draw. */
const PRESENTATION_TEXT_MAX = 64;
const CHART_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Whether `value` is a well-formed presentation — what the host checks on
 * every agent registration, in-process or across the external tier. */
export function isAgentPresentation(value: unknown): value is AgentPresentation {
  if (!isJsonRecord(value)) return false;
  const { oscLeadingGlyphs, failureLabels, chartColor } = value;
  const shortText = (text: unknown) =>
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= PRESENTATION_TEXT_MAX &&
    !hasUnsafeText(text);
  if (oscLeadingGlyphs !== undefined && !(Array.isArray(oscLeadingGlyphs) && oscLeadingGlyphs.every(shortText)))
    return false;
  if (
    failureLabels !== undefined &&
    !(isJsonRecord(failureLabels) && Object.entries(failureLabels).every(([code, label]) => shortText(code) && shortText(label)))
  )
    return false;
  return chartColor === undefined || (typeof chartColor === "string" && CHART_COLOR.test(chartColor));
}

/** One session binding as the agent's reporter stated it. */
export interface AgentBindingReport {
  /** The CLI's own word for why the session started, verbatim. */
  source?: string;
  /** What the reporter added about the session, string values only — what
   * the CLI recorded about who created it, for instance. Empty when it added
   * nothing. */
  facts: Readonly<Record<string, string>>;
}

/**
 * The one judgement about a binding only the agent can make.
 *
 * A second FRESH session from the pane's own, already bound process is
 * refused by default: for claude that is an in-process teammate, a full
 * session of its own the user is not having. Some CLIs report their `/new`
 * the same way — a fresh start, from the same process — and have no such
 * teammates. Only the agent knows which one it is looking at.
 */
export interface AgentBinding {
  /** The CLI's words for a session that CONTINUES the pane's conversation
   * (resumed, cleared, compacted, forked…) rather than starting one (API
   * 70). A word not listed — or none at all — reads as a fresh start, the
   * strict side: an unknown word can never overwrite a pane's identity. */
  swapSources?: readonly string[];
  /** Whether this fresh session, from the pane's own process, is the user
   * starting a new conversation. Asked only for that case; the process rules
   * are never the agent's to waive. Absent means not. */
  restartsConversation?(report: AgentBindingReport): boolean;
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
  /** The floor of a BARE launch (API 66): the arguments this CLI must still
   * carry when the host starts it without a plan — because `spawn.plan`
   * threw, or because an external plugin's plan named a program its `exec`
   * capability does not cover and the host clamped it to the agent's own
   * binary. Only `output.args` is read — a bare launch runs that binary with
   * nothing else of a plan — and the hook gets the same input the unused
   * plan did, so a floor can depend on the release (`cliVersion`). Keep it to what a launch cannot go without; a floor that
   * throws, or is absent, leaves the launch with no arguments at all. */
  "bare.plan"?(
    input: SpawnPlanInput,
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
  /** The MCP servers this pane's agent should be given: a hook renders them
   * in its CLI's dialect. Absent when there is nothing to inject (the
   * KeepDeck transport is off, or the user's set is empty) and on hosts
   * older than API 31. */
  mcp?: SpawnMcpInput;
  /** Where the agent should run. Absent = local (and absent on hosts older
   * than API 27); a supporting agent's `spawn.plan` reads `kind`/`endpoint`
   * to emit its remote-client argv. A non-remote agent ignores it. */
  target?: SpawnTarget;
  /** The version this agent's CLI prints for `--version` — the first dotted
   * number in its answer (`2.1.2` for `opencode v2.1.2`) — so a hook can
   * pick the flags its RELEASE accepts (opencode 2.x needs `--standalone`).
   * Asked anew for every launch, so a CLI swapped while the app runs is
   * launched as what it now is. Absent when it could not be asked or
   * answered, and on hosts older than API 62: a hook reads absence as "the
   * release this plugin was written against". */
  cliVersion?: string;
}

/** One staged skill as text: its SKILL.md byte for byte (API 71). A plugin
 * that builds its CLI's own layout writes it as it is, and reads it — when it
 * must — with this package's SKILL.md codec. */
export interface SpawnSkill {
  name: string;
  content: string;
}

/** The workspace's shared skills — staged under KeepDeck's own home
 * (absolute paths), never the user's dotfiles or repo.
 *
 * `dir` and `skills` are the generic source (API 71): a plugin points a CLI
 * that takes a skills directory at `dir`, and builds any other layout its CLI
 * reads from `skills`, in its own workspace directory (`ctx.workspaces`).
 * The three CLI-shaped views beside them are the host's older renderings,
 * kept until every agent builds its own. */
export interface SpawnSkillsInput {
  /** The bare standard layout: `<dir>/<name>/SKILL.md`. */
  dir: string;
  /** The same skills as text, alphabetical by name. Never empty: with no
   * skill to hand out, `skills` itself is absent from the plan input. */
  skills: SpawnSkill[];
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

/** The MCP servers to declare to one spawning agent.
 *
 * A LIST, never one server: KeepDeck's own transport is the first member and
 * the user's library follows, so a hook RENDERS EACH — a dialect that
 * hardcodes one entry silently drops the rest.
 *
 * Two arms: a process the CLI spawns (`stdio`) and an endpoint it reaches
 * (`http`). A hook renders both through [`mapMcpServers`], which is what
 * makes a third arm a compile error in every dialect rather than a server
 * silently missing from one of them. */
export interface SpawnMcpInput {
  servers: McpServerSpec[];
}

/** One locally spawned (stdio) MCP server, as the host declares it. */
export interface McpStdioServerSpec {
  /** The key the CLI files this server under, and the prefix its tools carry
   * (`mcp__<name>__…`); constrained to `[A-Za-z0-9_-]`. */
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  /** Names of variables the server process must receive from the PANE's
   * environment, where the host has already set them. The ONLY way a server
   * is given a variable: a literal map written into the config would land on
   * argv for the CLIs that take their config there, where `ps` reads it.
   * Only the CLI that filters its children's environment (codex) has
   * anything to render; the others inherit and render nothing. */
  envPassthrough?: string[];
}

/** One remote (streamable http) MCP server, as the host declares it. */
export interface McpHttpServerSpec {
  name: string;
  transport: "http";
  url: string;
  /** Literal request headers. Not for secrets, for the reason `env` is not. */
  headers?: Record<string, string>;
  /** The variable in the pane's environment holding the bearer token. Sent as
   * `Authorization: Bearer …`, in whatever env-reference syntax the CLI
   * resolves itself (see [`mcpHttpHeaders`]) or through its native
   * token-from-env field; it wins over a literal `Authorization` header. */
  bearerTokenEnv?: string;
}

export type McpServerSpec = McpStdioServerSpec | McpHttpServerSpec;

/** The contract revision that introduced the `http` arm. A host hands remote
 * servers only to a plugin whose floor reaches it: an older plugin's renderer
 * throws on the arm, and a throwing spawn hook costs the pane every server it
 * DID know how to render. A fact of history, NEVER moved with `API_VERSION`:
 * it names the revision the arm appeared in, and every later one includes it. */
export const MCP_HTTP_API = 45;

/**
 * Render each injected server by transport, in order.
 *
 * The one place a CLI dialect fans out over transports: a renderer that has
 * not been taught an arm stops compiling here instead of quietly emitting a
 * config with the server missing.
 */
export function mapMcpServers<T>(
  servers: readonly McpServerSpec[],
  visit: {
    stdio(server: McpStdioServerSpec): T;
    http(server: McpHttpServerSpec): T;
  },
): T[] {
  return servers.map((server) => {
    switch (server.transport) {
      case "stdio":
        return visit.stdio(server);
      case "http":
        return visit.http(server);
      default: {
        const unsupported: never = server;
        throw new Error(
          `unsupported MCP transport: ${String((unsupported as { transport: unknown }).transport)}`,
        );
      }
    }
  });
}

/**
 * The headers a remote server is sent, with its bearer token folded in as
 * `Authorization` — spelled with `envRef`, the CLI's own syntax for "read
 * this from my environment", because the token's VALUE lives in the pane's
 * environment and never in a config. For a CLI with a native token-from-env
 * field the renderer uses that instead and passes only the literal headers.
 *
 * The bearer wins over a literal `Authorization` header: two spellings of one
 * credential would otherwise reach the CLI in whichever order the map keeps.
 * `undefined` when there is nothing to send, so a renderer can leave the key
 * out rather than emit an empty map.
 */
export function mcpHttpHeaders(
  server: Pick<McpHttpServerSpec, "headers" | "bearerTokenEnv">,
  envRef: (name: string) => string,
): Record<string, string> | undefined {
  const headers = {
    ...server.headers,
    ...(server.bearerTokenEnv
      ? { Authorization: `Bearer ${envRef(server.bearerTokenEnv)}` }
      : {}),
  };
  return Object.keys(headers).length > 0 ? headers : undefined;
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

/** Why an answer is shorter than what exists. The measure is the domain's
 * own vocabulary — a file is measured in bytes, a conversation in turns —
 * so each kind carries ITS numbers, never one field repurposed across
 * domains. An ARRAY because one read can fall short two ways at once (a
 * loop that drops unreadable parts and then hits the size ceiling reports
 * both). NEVER empty: an empty array would be a second spelling of
 * "complete", and two spellings of one truth drift apart. Absent means no
 * shortfall — AT THE TYPE LEVEL. On the Facts field the same absence means
 * more (the reading may never have touched what it could have fallen short
 * of); that finer signature lives on the FIELD's comment — do not merge the
 * two wordings, the field's one is the load-bearing half. */
export type Shortfall =
  | { kind: "bytes"; size: number; readBytes: number }
  | { kind: "turns"; total: number; returned: number }
  | { kind: "parts"; unreadableParts: number }
  /** A store read the host stopped: this many rows arrived and there were
   * more. Alone among these forms it names no total — a reading cut at a
   * budget cannot know what it did not reach, and a second query to find out
   * would be the very cost the budget refused. Saying "more than this" is
   * the whole of what is known, and it is worth saying: a page cut in the
   * middle otherwise looks exactly like a conversation that ended. */
  | { kind: "rows"; returned: number };

/** The fields worth OPENING a session for — fetched only for new/changed
 * stubs. */
export interface AgentSessionFacts {
  cwd: string;
  title?: string;
  /** The session's transcript file, when the store has one — carried
   * explicitly so consumers never infer it from the ref's shape. */
  transcriptPath?: string;
  /** About the reading THIS describe made — never about the session as a
   * whole. A fast-path describe that never read the body has nothing to say
   * about it: absent means "this reading was complete OR stayed silent
   * about what it did not do". A consumer who needs to tell those apart
   * must know which reading it asked for. */
  shortfall?: Shortfall[];
}

export interface AgentTranscriptEntry {
  role: "user" | "assistant" | "other";
  text: string;
}

/** One live session held by a process OUTSIDE our panes — the CLI's own
 * interactive run or a background agent of its daemon. Identity is the
 * SESSION (the id a resume would refuse), and the rest is what a person
 * needs to recognize the conversation: its kind, its name, its state. */
export interface AgentLiveSession {
  /** The agent's own session id — the resume key this entry makes refuse. */
  sessionId: string;
  /** How the process holds it — the CLI's own vocabulary
   * (e.g. "interactive" | "background"). */
  kind: string;
  /** The conversation's name, when the CLI knows one. */
  name?: string;
  /** The CLI's own liveness state (e.g. "working" | "blocked" | "done"),
   * when it reports one. */
  state?: string;
}

/** A snapshot of the agent's live sessions — see
 * `AgentContribution.liveSessions`. */
export interface AgentLiveSessions {
  /** Every session currently held by an outside process. Refusing (a broken
   * CLI, a dead daemon, a timeout) is a legitimate answer the caller treats
   * as UNKNOWN — never as an empty list, which would read as "nothing is
   * live" and green-light exactly the action it must not take. */
  list(): Promise<AgentLiveSession[]>;
}

/** Read-only discovery over the agent's own store ([F8] global browser):
 * the plugin enumerates and parses (its format, its capability — fs or
 * sqliteReadonly); the host diffs, indexes and searches. Every method is
 * read-only by construction. */
export interface AgentHistory {  /** Enumerate the whole store — stat-level, no content reads. */
  list(): Promise<AgentSessionStub[]>;
  /** Enumerate the whole store WITH an integrity signal: `complete` is
   * false when any part of the store could not be read — an unreadable
   * directory is skipped and named in the log, never fatal to the walk.
   * The host prunes ONLY on `complete === true`; a plugin without this
   * method keeps the legacy `list()` contract, whose successful read has
   * always meant "complete enough to prune". Two honest contracts, not
   * an old one and its replacement. */
  listing?(): Promise<{ stubs: AgentSessionStub[]; complete: boolean }>;
  /** The facts worth indexing, for one (new/changed) session. */
  describe(ref: string): Promise<AgentSessionFacts>;
  /** The searchable text (user+assistant turns) — feeds the FTS index. */
  content(ref: string): Promise<string>;
  /** One transcript page for the read-only viewer. */
  transcript(
    ref: string,
    page: { offset: number; limit: number },
  ): Promise<AgentTranscriptEntry[]>;
  /** One transcript page WITH its shortfall — the viewer shows the mark of
   * ITS OWN reading, not a session-wide inherited one (a scan-born mark
   * would describe yesterday's file). The legacy `transcript()` stays
   * honest on its own — two honest contracts, not an old one and its
   * replacement. No `complete` field on purpose: completeness is DERIVED
   * (no shortfall ⇒ the page is whole), and a stored duplicate of a derived
   * truth invites the two to disagree. Do not add it back. */
  transcriptPage?(
    ref: string,
    page: { offset: number; limit: number },
  ): Promise<{ entries: AgentTranscriptEntry[]; shortfall?: Shortfall[] }>;
}

/**
 * A reporter that runs INSIDE the agent (a mod, a plugin of the CLI's own)
 * and announces itself once, with a `companion.hello` envelope from the
 * agent's own process. Hooks stay the lane for everything they report; a
 * companion covers what they cannot.
 *
 * ONE source per process, by construction: what a companion covers is not
 * read twice and then reconciled — the host stops the other source for that
 * process when the hello lands. A process that never says hello keeps every
 * fallback it has today.
 */
export interface AgentCompanion {
  covers: readonly CompanionCover[];
}

/**
 * - `status-records`: the status lane of the agent's store tail. The
 *   companion states those facts itself, as they happen, so the host arms
 *   the tail with the usage watches alone.
 */
export type CompanionCover = "status-records";

export interface ForkPlanInput extends SpawnPlanInput {
  /** The source session being forked. */
  sessionId: string;
  /** The directory the session was recorded in. It may no longer exist —
   * recipes operate on the agent's store, never on the original dir. */
  sourceCwd: string;
  /** The session's transcript/rollout file — the exact source file for
   * copy-based recipes. The host answers it from the binding report, else
   * from the session index (walking the agent's store again on a miss);
   * absent only when neither knows it, which a recipe that copies refuses. */
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
  /** What a `fork.plan`'s surgery made that only the start needs (API 60):
   * paths the HOST removes through this plugin's `fsWrite` capability —
   * `onceStarted` when the forked session reports its id, `ifNeverStarted`
   * when the pane goes away before it does (closed, its plan dropped, the
   * build discarded). A fork that leaves its scaffolding behind leaves the
   * store wrong, and only the host sees the moment it stops being needed.
   * Read only from a fork plan. */
  discard?: ForkDiscard;
}

export interface ForkDiscard {
  onceStarted?: string[];
  ifNeverStarted?: string[];
}
