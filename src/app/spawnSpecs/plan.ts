/**
 * Building ONE plan: the agent hook that fills in argv and env, and the host
 * facts that are not the hook's to decide (staged skills in, bridge arming
 * out).
 */
import type {
  AgentContribution,
  ForkPlanInput,
  SpawnPlanInput,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import type { ResumeOrigin } from "../../domain/agents";
import {
  BRIDGE_PROTOCOL_VERSION,
  type SpawnPlan,
  type SpawnPlanContext,
} from "./plans";
import { describeError, log } from "../../ipc/log";
import type { SkillsStagingViews } from "../../ipc/skills";
import type { McpAccess, McpAccessAsk } from "../mcp";
import { execCovers } from "../../plugins/capabilities/execCovers";
import { mintBridgeToken, mintMcpToken } from "../ids";
import { postbackCount } from "../postbacks";
import { peekPaneSpawnSpec } from "./cache";
import type { SpawnPluginAccess } from "./index";

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
  stagedSkills?: () => Promise<SkillsStagingViews | null>;
  /** This pane's MCP access, asked for the same way and for the same reason:
   * the answer moves (the transport toggles, the user's set changes), so it
   * is a QUESTION the build asks, not a value the caller carries.
   *
   * It answers with BOTH halves — the servers for the hook and the on-disk
   * delivery for a CLI that takes none — because only this build knows when
   * the plan is settled enough to write anything. */
  mcpAccess?: McpAccessAsk;
}

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
  /** Put the file-delivered half on disk. A no-op for the argv CLIs, and
   * never rejects — a failed delivery leaves the pane serverless, never
   * unspawned. */
  deliver(): Promise<void>;
}

/** What a plan is FOR — fresh spawn, resume, or fork. Resume/fork carry
 * their session facts; the hook that runs is the variant's. */
type PlanVariant =
  | { kind: "spawn" }
  | { kind: "resume"; sessionId: string; origin: ResumeOrigin }
  | { kind: "fork"; sessionId: string; sourceCwd: string; transcriptPath?: string };

/** Build one plan through the agent's hook. A throwing SPAWN hook degrades
 * to a bare spawn (no identity) rather than a dead pane; a throwing resume
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
  const mcpServers = access?.servers ?? [];
  /** Owed by every exit that produces a plan, and by none that throws: a
   * rejected resume or fork must plant nothing. */
  const deliver = () => access?.deliver() ?? Promise.resolve();
  const base: SpawnPlanInput = {
    paneId,
    workspace: facts.workspace,
    cwd: facts.cwd,
    ...(facts.branch ? { branch: facts.branch } : {}),
    ...(facts.yolo ? { yolo: true } : {}),
    ...(skills ? { skills } : {}),
    ...(mcpServers.length > 0 ? { mcp: { servers: mcpServers } } : {}),
    ...(facts.target ? { target: facts.target } : {}),
  };
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
      `${entry.id} spawn.plan failed — bare spawn: ${describeError(e)}`,
    );
    // A bare spawn still RUNS the CLI, so the file-fed half is still owed:
    // kimi reads its cwd whatever argv it was given, and skipping the write
    // would leave exactly the panes whose hook failed without servers. The
    // secret rides along for the same reason — the planted config names it,
    // and dropping it would resolve that pane's every call to nobody.
    return {
      plan: { command: entry.detect.bin, args: [], env: [], mcpToken },
      deliver,
    };
  }
  // The hook's command must be covered by its plugin's exec capability —
  // warn for a trusted built-in (a bug to fix), CLAMP for an external
  // (falling back to the agent's own binary, which the registration gate
  // proved covered): a sandboxed plugin must not pick the program.
  const owner = plugins.pluginHost
    .getInstalled()
    .find((installed) => installed.manifest.id === pluginId);
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
      output.args = [];
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
  const env: [string, string][] = token
    ? [
        ...output.env,
        [
          "KEEPDECK_BRIDGE",
          JSON.stringify({
            v: BRIDGE_PROTOCOL_VERSION,
            dir: ctx.bridgeDir,
            pane: paneId,
            token,
          }),
        ],
      ]
    : output.env;
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
          }
        : variant.kind === "fork"
          ? { forkOf: variant.sessionId }
          : {}),
    },
    deliver,
  };
}

export function findAgent(
  plugins: SpawnPluginAccess,
  agentType: string,
): { entry: AgentContribution; pluginId: string } | undefined {
  return plugins.pluginRegistries.agents
    .list()
    .find((c) => c.entry.id === agentType);
}

