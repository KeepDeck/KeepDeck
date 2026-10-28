/**
 * Building ONE plan: the agent hook that fills in argv and env, and the host
 * facts that are not the hook's to decide (staged skills in, bridge arming
 * out).
 */
import {
  isApiVersion,
  MCP_HTTP_API,
  type AgentContribution,
  type ForkPlanInput,
  type McpServerSpec,
  type SpawnArmOutput,
  type SpawnPlanInput,
  type SpawnPlanOutput,
  errorMessage,
} from "@keepdeck/plugin-api";
import type { ResumeOrigin } from "../../domain/agents";
import type { InstalledPlugin } from "../../plugins/model/installed";
import {
  BRIDGE_PROTOCOL_VERSION,
  type SpawnPlan,
  type SpawnPlanContext,
} from "./plans";
import { log } from "../../ipc/log";
import { execCovers } from "../../plugins/capabilities/execCovers";
import { fsWritePaths } from "../../plugins/capabilities/gate";
import { pluginsFsWriteRemove } from "../../ipc/pluginsFsWrite";
import { mintBridgeToken, mintMcpToken } from "../ids";
import { postbackCount } from "../postbacks";
import { peekPaneSpawnSpec } from "./cache";
import type { SpawnPluginAccess } from "./index";
import type { CwdArmRequest } from "../worktrees";

/** The host facts this consumer needs from a spawning MCP feature. Structural
 * on purpose: the feature's richer object remains assignable without making
 * this plan builder import the feature module. */
export interface McpAccess {
  /** Each server with what the pane's environment must carry for it — the
   * values its spec only NAMES, kept off argv by design. One entry, so that
   * dropping a server here drops its values with it. */
  entries: { spec: McpServerSpec; env: [string, string][] }[];
}

export interface McpAccessTarget {
  agentType: string;
  cwd: string;
  workspaceId: string;
  client: string;
}

export type McpAccessAsk = (target: McpAccessTarget) => Promise<McpAccess>;

/** The staged views this consumer needs from the worktree owner. */
export interface StagedSkillsViews {
  claudePluginDir: string;
  opencodeConfigDir: string;
  skillsDir: string;
  dir: string;
  skills: { name: string; content: string }[];
}

/** The pane-side facts a plan is built from — the hook input's shape minus
 * the resume session (that arrives with the resume request, not the pane). */
export interface PaneSpawnFacts extends SpawnPlanInput {
  /** This workspace's staged shared skills, resolved by whoever owns the
   * worktrees — asked for here, never computed here. A build path that worked
   * out the arming set itself is how a directory being deleted got armed, so
   * the set is deliberately not expressible in these facts. Absent = this
   * build has no skills source and the hook input stays sparse.
   *
   * Named apart from the hook input's own `skills` (which carries the resolved
   * views) because this is the QUESTION, not the answer. */
  stagedSkills?: () => Promise<StagedSkillsViews | null>;
  /** This pane's MCP access, asked for the same way and for the same reason:
   * the answer moves (the transport toggles, the user's set changes), so it
   * is a QUESTION the build asks, not a value the caller carries.
   *
   * It answers with BOTH halves — the servers for the hook and the on-disk
   * delivery for a CLI that takes none — because only this build knows when
   * the plan is settled enough to write anything. */
  mcpAccess?: McpAccessAsk;
  /** Where the plantings an agent's plugin declares for this cwd
   * (`arm.plan`) are put — after the plan is settled, like the MCP delivery,
   * and for the same reason. Absent = this build plants nothing. */
  armCwd?: CwdArmAsk;
}

/** Plant one plugin's complete set in a pane's cwd, and say what could not
 * be planted, under the agent's name. Never rejects: a planting that failed
 * costs the pane what it was for, never its process. */
export type CwdArmAsk = (agentId: string, request: CwdArmRequest) => Promise<void>;

/**
 * One built plan, and the on-disk half it still owes.
 *
 * The two are separate because "is this plan settled?" has TWO halves and
 * this module can only see one. It knows the hook did not throw; the CACHE
 * knows whether the build's generation still holds, and a build invalidated
 * mid-flight is discarded. Writing here would plant a config for a plan
 * nobody kept, naming a secret that then resolves to no pane. So the write
 * is handed to whoever installs the plan — see [`buildAndCache`].
 */
export interface BuiltPlan {
  plan: SpawnPlan;
  /** Plant what the agent's plugin declared for the pane's cwd (`arm.plan`).
   * Never rejects — a planting that failed costs the pane what it was for,
   * never its process. */
  deliver(): Promise<void>;
  /** A fork plan's scaffolding, to be removed once the fork starts or once
   * it is clear it never will — absent when the plan declared none. */
  discard?: PlanDiscard;
}

/** The two ends a fork's scaffolding can meet; each never rejects. */
export interface PlanDiscard {
  onceStarted(): Promise<void>;
  ifNeverStarted(): Promise<void>;
}

/** Remove what a fork plan declared, inside its plugin's own write
 * prefixes — the containment the plugin's own calls get. A failure is
 * logged, never thrown: a leftover is a defect to see, not a reason to fail
 * the pane that left it. */
function planDiscard(
  agentId: string,
  roots: readonly string[],
  declared: NonNullable<SpawnPlanOutput["discard"]>,
): PlanDiscard | undefined {
  const onceStarted = declared.onceStarted ?? [];
  const ifNeverStarted = declared.ifNeverStarted ?? [];
  if (onceStarted.length === 0 && ifNeverStarted.length === 0) return undefined;
  const removeAll = async (paths: readonly string[]) => {
    for (const path of paths) {
      await pluginsFsWriteRemove(path, roots).catch((error: unknown) =>
        log.warn(
          "web:agents",
          `${agentId}: fork scaffolding ${path} was not removed: ${errorMessage(error)}`,
        ),
      );
    }
  };
  return {
    onceStarted: () => removeAll(onceStarted),
    ifNeverStarted: () => removeAll(ifNeverStarted),
  };
}

/**
 * The servers a plugin can be trusted to render.
 *
 * A plugin built against a contract older than the remote arm has a
 * `mapMcpServers` that throws on it, and a throwing spawn hook degrades the
 * pane to a bare spawn — so one remote server would cost an older plugin
 * every server it DID know how to render. A built-in moves with the host; an
 * external plugin is judged by its declared floor, and one with no usable
 * floor counts as old (the gate fails closed, like the manifest gate does).
 */
function renderableBy(
  entries: McpAccess["entries"],
  owner: Pick<InstalledPlugin, "source" | "manifest"> | undefined,
  agentId: string,
): McpAccess["entries"] {
  if (!owner || owner.source !== "external") return entries;
  const floor = owner.manifest.minApiVersion;
  if (isApiVersion(floor) && floor >= MCP_HTTP_API) return entries;
  const withheld = entries.filter(({ spec }) => spec.transport !== "stdio");
  if (withheld.length > 0) {
    log.warn(
      "web:agents",
      `${agentId}: ${owner.manifest.id} predates API ${MCP_HTTP_API} — remote MCP servers withheld: ${withheld.map(({ spec }) => spec.name).join(", ")}`,
    );
  }
  // The whole entry goes, values included: a server this pane never hears of
  // must not leave its token in the pane's environment either.
  return entries.filter(({ spec }) => spec.transport === "stdio");
}

/**
 * The pane's environment, assembled in the order of who owns what. A
 * library server's variables come FIRST so the plugin's own and the host's
 * bridge variable win over them: those carry the pane's identity and config,
 * and a server whose file names `PATH` or the plugin's config variable must
 * not displace them for the whole pane. The PTY applies pairs last-wins.
 */
function paneEnv(
  agentId: string,
  mcpEnv: [string, string][],
  pluginEnv: [string, string][],
  bridge: [string, string][],
): [string, string][] {
  const owned = new Set([...pluginEnv, ...bridge].map(([name]) => name));
  for (const [name] of mcpEnv) {
    if (owned.has(name)) {
      log.warn(
        "web:agents",
        `${agentId}: an MCP server sets ${name}, which the pane already owns — the pane's value wins`,
      );
    }
  }
  return [...mcpEnv, ...pluginEnv, ...bridge];
}

/**
 * The bare argv of this agent: what its own binary is started with when the
 * plugin's plan is not used — because `spawn.plan` threw, or because an
 * external plugin's plan named a program its manifest does not cover. Both
 * are the same launch, so both carry what the plugin declared as its floor
 * (`bare.plan`), and nothing when it declared none. Which flags those are is
 * the plugin's knowledge; the host only applies them. A floor that throws is
 * logged and costs the launch its floor, not its pane.
 */
async function bareArgs(
  entry: AgentContribution,
  input: SpawnPlanInput,
): Promise<string[]> {
  const floor = entry.hooks["bare.plan"];
  if (typeof floor !== "function") return [];
  const output: SpawnPlanOutput = { command: entry.detect.bin, args: [], env: [] };
  try {
    await floor(input, output);
  } catch (e) {
    log.warn(
      "web:agents",
      `${entry.id} bare.plan failed — bare launch with no arguments: ${errorMessage(e)}`,
    );
    return [];
  }
  return output.args;
}

/** What a plan is FOR — fresh spawn, resume, or fork. Resume/fork carry
 * their session facts; the hook that runs is the variant's. */
type PlanVariant =
  | { kind: "spawn" }
  | {
      kind: "resume";
      sessionId: string;
      origin: ResumeOrigin;
      retry?: boolean;
    }
  | { kind: "fork"; sessionId: string; sourceCwd: string; transcriptPath?: string };

/** Build one plan through the agent's hook. A throwing SPAWN hook degrades
 * to a bare spawn (no identity, only the plugin's declared floor) rather
 * than a dead pane; a throwing resume
 * or fork hook REJECTS — degrading a requested continuation (or a fork whose
 * surgery failed) into a fresh conversation would be silent data loss. */
export async function buildPlan(
  plugins: SpawnPluginAccess,
  agent: { entry: AgentContribution; pluginId: string },
  facts: PaneSpawnFacts,
  ctx: SpawnPlanContext,
  variant: PlanVariant = { kind: "spawn" },
): Promise<BuiltPlan> {
  const { entry, pluginId } = agent;
  const { paneId } = facts;
  const output: SpawnPlanOutput = {
    // Prefilled with the detected command; a hook may override (null = the
    // user's shell).
    command: entry.detect.bin,
    args: [],
    env: [],
    envDefaults: [],
  };
  // Staged shared skills are a host fact like the bridge — but delivered as
  // hook INPUT, because loading them is per-CLI dialect (a flag here, an env
  // var there), and dialects are exactly what hooks own. WHICH skills, and
  // which directories get armed for them, is the worktree manager's answer:
  // this only asks.
  const skills = facts.stagedSkills ? await facts.stagedSkills() : null;
  // Asked alongside the skills, and delivered the same way: WHICH servers is
  // the MCP owner's answer, and how a CLI is told about them is the hook's.
  // An empty set leaves the input sparse — a hook must not have to tell
  // "nothing to inject" apart from "this host is too old to say".
  // Reused for a pane whose process is still alive, for the same reason the
  // bridge token is: a rebuild must not orphan the secret that process's MCP
  // children already announce. Every path that RETIRES a process drops the
  // spec first, so a genuinely new process gets a fresh one and the dead
  // one's stops resolving.
  const mcpToken = peekPaneSpawnSpec(paneId)?.mcpToken ?? mintMcpToken();
  const access: McpAccess | null = facts.mcpAccess
    ? await facts.mcpAccess({
        agentType: entry.id,
        cwd: facts.cwd,
        workspaceId: facts.workspace.id,
        client: mcpToken,
      })
    : null;
  // The hook's owner, looked up BEFORE the hook runs: its manifest bounds
  // what the hook may be handed (the servers it can render) as well as what
  // it may answer (the command clamp below).
  const owner = plugins.installed(pluginId);
  // The plugin renders every server it is handed — on argv, or in a file it
  // declares for the cwd — so its floor bounds what it is handed.
  const injected = access ? renderableBy(access.entries, owner, entry.id) : [];
  const mcpServers = injected.map((item) => item.spec);
  // Owed by every plan, the bare one included: a file-fed CLI reads its
  // servers from its cwd whatever argv it was given, and their values live
  // nowhere but here.
  const mcpEnv = injected.flatMap((item) => item.env);
  /** Owed by every exit that produces a plan, and by none that throws: a
   * rejected resume or fork must plant nothing. */
  const deliver = () => armCwd();
  // Asked before the hook runs, because what it decides — argv — cannot be
  // corrected once the process has started (opencode 2.x needs a flag 1.x
  // does not have). Remembered per binary, so only an agent's first pane in
  // a run waits for it.
  const cliVersion = await plugins.cliVersion(entry.id);
  const base: SpawnPlanInput = {
    paneId,
    workspace: facts.workspace,
    cwd: facts.cwd,
    ...(facts.branch ? { branch: facts.branch } : {}),
    ...(facts.yolo ? { yolo: true } : {}),
    ...(skills ? { skills } : {}),
    ...(mcpServers.length > 0 ? { mcp: { servers: mcpServers } } : {}),
    ...(facts.target ? { target: facts.target } : {}),
    ...(cliVersion ? { cliVersion } : {}),
  };
  /** What the agent's plugin plants in this cwd, asked once the plan is
   * settled. Never for a REMOTE pane: its agent's directory is on the remote
   * host, and a planting here would be a file nothing reads. A hook that
   * throws plants nothing new and takes nothing back — the earlier set stays,
   * which is the safer of the two wrongs. */
  async function armCwd(): Promise<void> {
    const hook = entry.hooks["arm.plan"];
    if (facts.target || !facts.armCwd || typeof hook !== "function") return;
    const arms: SpawnArmOutput = { cwd: [] };
    try {
      await hook(base, arms);
    } catch (e) {
      log.warn("web:agents", `${entry.id} arm.plan failed — the cwd keeps what it had: ${errorMessage(e)}`);
      return;
    }
    await facts.armCwd(entry.id, {
      pluginId,
      workspaceId: facts.workspace.id,
      cwd: facts.cwd,
      arms: arms.cwd,
      skillsDir: skills?.dir ?? null,
    });
  }
  if (
    variant.kind === "spawn" &&
    facts.target &&
    typeof entry.hooks["spawn.plan"] !== "function"
  ) {
    throw new Error(
      `${entry.id}: remote target requires a spawn.plan implementation`,
    );
  }
  try {
    if (variant.kind === "resume") {
      await entry.hooks["resume.plan"]?.(
        { ...base, sessionId: variant.sessionId },
        output,
      );
    } else if (variant.kind === "fork") {
      const input: ForkPlanInput = {
        ...base,
        sessionId: variant.sessionId,
        sourceCwd: variant.sourceCwd,
        ...(variant.transcriptPath !== undefined && {
          transcriptPath: variant.transcriptPath,
        }),
      };
      await entry.hooks["fork.plan"]?.(input, output);
    } else {
      await entry.hooks["spawn.plan"]?.(base, output);
    }
  } catch (e) {
    // Resume/fork already propagate; a spawn degrades to bare so the pane
    // lives — UNLESS the pane is remote: a bare spawn would run the agent
    // LOCALLY (silently dropping the endpoint), a wrong-target execution the
    // user couldn't tell apart from a working remote pane. Surface it instead.
    if (variant.kind !== "spawn" || facts.target) throw e;
    log.warn(
      "web:agents",
      `${entry.id} spawn.plan failed — bare spawn: ${errorMessage(e)}`,
    );
    // A bare spawn still RUNS the CLI, so the file-fed half is still owed:
    // kimi reads its cwd whatever argv it was given, and skipping the write
    // would leave exactly the panes whose hook failed without servers. The
    // secret rides along for the same reason — the planted config names it,
    // and dropping it would resolve that pane's every call to nobody.
    return {
      plan: {
        command: entry.detect.bin,
        args: await bareArgs(entry, base),
        env: mcpEnv,
        mcpToken,
      },
      deliver,
    };
  }
  // The hook's command must be covered by its plugin's exec capability —
  // warn for a trusted built-in (a bug to fix), CLAMP for an external
  // (falling back to the agent's own binary, which the registration gate
  // proved covered): a sandboxed plugin must not pick the program. The
  // clamped launch is the bare one, so it carries the same declared floor.
  if (
    owner &&
    !execCovers(owner.manifest.capabilities, output.command ?? "$SHELL")
  ) {
    log.warn(
      "web:agents",
      `${entry.id}: plan command "${output.command}" is not exec-covered by ${pluginId}`,
    );
    if (owner.source === "external") {
      output.command = entry.detect.bin;
      output.args = await bareArgs(entry, base);
      output.env = [];
      output.envDefaults = [];
    }
  }
  // Bridge arming is host business: reporters read this var; hooks only
  // make the CLI load a reporter. Armed whenever the bridge exists.
  //
  // The token is PER PANE, not per build: a rebuild while the pane's
  // process is alive (observed: a double-revive rebuilding the resume
  // plan) must not orphan the token that process's reporters echo — every
  // postback would fail verification forever. Every path that RETIRES a
  // process drops the spec first (`dropPaneSpawnSpec` — restart, suspend,
  // close), so a genuinely new process still gets a fresh token and the
  // dead one's credential stops being accepted.
  const token = ctx.bridgeDir
    ? (peekPaneSpawnSpec(paneId)?.token ?? mintBridgeToken())
    : null;
  // The pane's OWN directory under this run's, created before the agent is,
  // so a reporter watches where it was told and never has to know the layout.
  // A failure here disarms the bridge for this spawn rather than arming it
  // with a path that does not exist — an agent that cannot be reached is
  // recoverable, one looking reachable and not being is not.
  const paneDir = token ? await ctx.paneBridgeDir(paneId).catch(() => null) : null;
  // The address is REQUIRED, not additive. It was additive at protocol 1,
  // when a reporter that had never heard of `url` fell back to writing a file
  // — that lane is gone, so a pane armed without an address would run its
  // whole life reporting into nowhere and looking alive doing it. Arming
  // nothing says so instead.
  //
  // Whole, not a port: assembling an address means knowing the route, and a
  // reporter that knew it would have to be told when the route moves.
  const bridge: [string, string][] =
    token && paneDir && ctx.bridgeUrl
      ? [
          [
            "KEEPDECK_BRIDGE",
            JSON.stringify({
              v: BRIDGE_PROTOCOL_VERSION,
              dir: paneDir,
              pane: paneId,
              token,
              url: ctx.bridgeUrl,
            }),
          ],
        ]
      : [];
  const env = paneEnv(entry.id, mcpEnv, output.env, bridge);
  // Only a fork's surgery leaves scaffolding, and only inside what its
  // plugin may write: a spawn or resume that declared some is ignored, and so
  // is a plugin with no write prefixes — the host must not grant by removal
  // what the manifest never granted.
  const roots = owner ? fsWritePaths(owner.manifest.capabilities) : [];
  if (output.discard && (variant.kind !== "fork" || roots.length === 0)) {
    log.warn(
      "web:agents",
      `${entry.id}: ignoring a discard declared outside a fork plan with write access`,
    );
  }
  const discard =
    variant.kind === "fork" && output.discard && roots.length > 0
      ? planDiscard(entry.id, roots, output.discard)
      : undefined;
  return {
    plan: {
      command: output.command,
      args: output.args,
      env,
      ...(output.envDefaults?.length ? { envDefaults: output.envDefaults } : {}),
      ...(token ? { token } : {}),
      // Recorded whether or not anything was injected: kimi's servers are
      // delivered as a file, so the pane has a live client with no `mcp` key in
      // its plan, and its calls must still resolve to it.
      mcpToken,
      ...(variant.kind === "resume"
        ? {
            resumeOf: variant.sessionId,
            resumeOrigin: variant.origin,
            postbackMark: postbackCount(paneId),
            ...(variant.retry ? { resumeRetry: true } : {}),
          }
        : variant.kind === "fork"
          ? { forkOf: variant.sessionId }
          : {}),
    },
    deliver,
    ...(discard && { discard }),
  };
}

export function findAgent(
  plugins: SpawnPluginAccess,
  agentType: string,
): { entry: AgentContribution; pluginId: string } | undefined {
  return plugins.agents().find((c) => c.entry.id === agentType);
}
