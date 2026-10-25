/**
 * The Claude Code CLI plugin: identity, detection, and the spawn/resume
 * hooks. Identity is reporter-based, same scheme as every agent: claude
 * mints its own session id and the SessionStart hook posts it back at
 * startup — and again on `/clear`, which swaps the id underneath an
 * otherwise-silent pane (probe-verified on 2.1.205: the startup event
 * carries the self-minted id). Resume REUSES the recorded id (forking is
 * opt-in upstream).
 *
 * Compaction fires SessionStart too, but KEEPS the id and the transcript
 * path — measured on 2.1.222, manual and automatic alike; only `/fork`
 * mints a new one, which is why it has its own `source`. So
 * it rebinds nothing, and the status lane is the only reader that cares:
 * `source: "compact"` is what tells a pane its recorded failure is stale
 * ([`normalizeClaudeStatus`]). Do not "simplify" that edge away on the
 * theory that a rebind already clears the pane — no rebind happens.
 */
import {
  launchPlans,
  mailAskArgs,
  shellQuote,
  type KeepDeckPlugin,
  type PluginAgents,
  type PluginResources,
  type PluginSettings,
  type SpawnPlanInput,
  type SpawnPlanOutput,
  type SpawnSkillsInput,
} from "@keepdeck/plugin-api";
import { ARTIFACTS_FIELD, artifactsEnv } from "./artifacts";
import { icon } from "./icon";
import { mcpArgs } from "./mcp";
import {
  attributeClaudeEvent,
  CLAUDE_MAIL_CHANNELS,
  normalizeClaudeStatus,
  renderClaudeMail,
} from "./status";
import { claudeTail } from "./tail";
import {
  claudeSubagentDirectory,
  claudeUsageWatches,
  normalizeClaudeStatusline,
} from "./usage";
import { forkClaudeSession, type ClaudeForkStore } from "./fork";
import { claudeHistory, type HistoryPorts } from "./history";
import { claudeLiveSessions, type LiveSessionsPorts } from "./liveSessions";

/**
 * How long claude may let one of our hooks run, in seconds.
 *
 * Stated rather than left to claude's default, which is not something this
 * deck gets to know: the reporter's own wait for the deck's answer is ~2s,
 * and a limit under that would kill it mid-wait. What is lost then is not a
 * status edge — it is MAIL, because the deck hands messages over before the
 * answer is written, so they land in the pane's inbox and never in its
 * context. That failure is silent on both sides, which is exactly why the
 * number is ours and not theirs.
 *
 * Five times the wait: enough that a slow round trip still lands, short
 * enough that a genuinely stuck hook does not hold a turn open.
 */
const HOOK_TIMEOUT_SECONDS = 10;

/** The `--settings` args arming both reporters — the SessionStart identity
 * hook and the statusLine usage reporter; each degrades independently when
 * its script is missing (`[]` only when neither resolves). The inline JSON
 * MERGES with the user's settings (hooks merge per event; verified on
 * 2.1.198), but `statusLine` is a single object with no merge story and
 * `--settings` outranks every settings file a user edits (a managed policy
 * still wins) — so this TAKES the statusLine slot. The reporter gives it back
 * by resolving the user's own statusLine at runtime and delegating to it
 * (kd-usage-statusline.sh); nothing on disk is ever touched. SessionStart
 * fires on startup/resume/clear/compact; the statusLine command runs
 * event-driven on every status update (rate_limits, cost, context_window on
 * stdin). */
async function hookArgs(
  resources: PluginResources,
  /** Whether this launch loads KeepDeck's Mod — the settings then keep it on. */
  withMod: boolean,
): Promise<string[]> {
  const session = await resources.path("kd-session-hook.sh");
  const status = await resources.path("kd-status-hook.sh");
  const usage = await resources.path("kd-usage-statusline.sh");
  const settings: Record<string, unknown> = {};
  const hooks: Record<string, unknown[]> = {};
  /** Add one reporter to an event, keeping whatever is already armed on it.
   * `SessionStart` carries BOTH reporters — identity and status read the
   * same event for different facts — and an assignment would silently drop
   * whichever ran second, taking session binding or the status lane with
   * it. claude runs every entry an event has. */
  /**
   * Exec form — the program and its argument list, run without a shell —
   * so nothing in a path (a space, a quote) is ever parsed. claude takes
   * `args` since 2.1.139, older releases being outside what KeepDeck
   * supports: one that ignores `args` runs the bare `/bin/sh`, which then
   * reads the hook's JSON from stdin as a script (measured on 2.1.138).
   * The process tree keeps the reporter's identity: the script's parent is
   * still claude itself (verified on 2.1.303).
   */
  const arm = (event: string, script: string, ask: readonly string[] = []) => {
    (hooks[event] ??= []).push({
      hooks: [
        {
          type: "command",
          command: "/bin/sh",
          args: [script, "claude", ...ask],
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    });
  };
  /** The four events that can carry mail BACK, and the only ones armed to
   * ask. `Stop` hands a teammate's words over while keeping the turn alive
   * to read them, so nothing pays for a fresh wake.
   * `UserPromptSubmit` appends to a turn the user just opened, which is
   * where mail that arrived while the pane sat idle belongs. `SessionStart`
   * is what spares a STARTING pane the terminal: a freshly spawned agent
   * has no turn and reports nothing, so its briefing otherwise waits for a
   * nudge typed into a CLI that has not finished booting.
   *
   * `PostToolBatch` is the mid-turn one, and the reason it is worth a round
   * trip where per-tool `PostToolUse` is not: claude fires it ONCE per batch
   * of tool calls rather than once per call, so the cost is per model
   * request instead of per tool. Its own default timeout is the shortest of
   * the four (15s against 120s for `Stop`); ours is tighter still at
   * [`HOOK_TIMEOUT_SECONDS`], which is what the deck actually has to answer
   * in. Asking on the REST would be a round trip per tool call for an answer
   * none of them can act on.
   *
   * Only the STATUS reporter asks. SessionStart carries the identity
   * reporter too, and that one answers a different question and takes no
   * reply — arming it to ask would make it wait for a file nobody writes.
   *
   * The channels are declared beside the renderer ([`CLAUDE_MAIL_CHANNELS`]),
   * which is the code that has to answer these events: stated twice, the two
   * drift in silence. */
  if (session) {
    // The agent id is the argument, same as the status reporter's: the
    // payload does not name its CLI, and the deck refuses a binding whose
    // agent is not the pane's own.
    arm("SessionStart", session);
  }
  if (status) {
    // The turn-lifecycle reporter: the same script for every event, the
    // agent id as its argument. StopFailure fires INSTEAD of Stop on an API
    // error — arming Stop without it would strand the pane on "working";
    // Notification is filtered to the two waiting types by the normalizer.
    // PostToolUse is the approval-RESOLUTION stand-in: claude has no reply
    // hook, but an approved tool's completion proves the wait resolved —
    // without it the amber "needs approval" survives the answer until Stop.
    // PostToolUseFailure is its other half: an approved tool that then
    // FAILED resolves the wait just as well, and claude routes it to a
    // separate event, the same shape as the Stop/StopFailure pairing.
    // SubagentStart/SubagentStop bracket ONE agent turn beside the main
    // thread; the host counts open brackets to know whether a closing turn
    // is really an ending, which is the only way to read a teammate.
    // SessionStart is the compaction signal: a manual `/compact` runs
    // through no turn, so it is the ONLY event that reports the rebuild
    // that retires a recorded failure — the normalizer keeps just that
    // source and drops the rest. A READABLE oversize request no longer
    // cards at all, which leaves this the backstop for the one arriving too
    // damaged to recognise, and for any other failure the user answers by
    // rebuilding the context.
    // PostToolBatch is armed for MAIL alone — it reports no status edge the
    // other nine do not already carry. It fires once per batch, between the
    // tool results and the next model request, which is the only moment a
    // running turn can be reached without touching the terminal.
    for (const event of [
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "Notification",
      "PostToolUse",
      "PostToolUseFailure",
      "PostToolBatch",
      "SubagentStart",
      "SubagentStop",
      "SessionStart",
    ]) {
      arm(event, status, mailAskArgs(CLAUDE_MAIL_CHANNELS, event));
    }
  }
  if (Object.keys(hooks).length > 0) settings.hooks = hooks;
  if (usage) {
    // A shell string still: claude's statusLine takes no `args` (2.1.303).
    settings.statusLine = {
      type: "command",
      command: `/bin/sh ${shellQuote(usage)}`,
      // Also re-run on a timer: event-driven updates go quiet on an idle
      // session, freezing the chip's "Updated" at the last turn.
      refreshInterval: 60,
    };
  }
  if (withMod) {
    // A user may have switched this inline plugin off; for a KeepDeck pane it
    // is KeepDeck's to keep on. Only OUR plugin, under the exact key claude
    // gives a `--plugin-dir` plugin (the bare name does not override it,
    // verified on 2.1.303): the user's own hooks and modes stay theirs, and a
    // managed policy still wins over any of this.
    settings.enabledPlugins = { [`${MOD_PLUGIN_NAME}@inline`]: true };
  }
  if (Object.keys(settings).length === 0) return [];
  return ["--settings", JSON.stringify(settings)];
}

/** KeepDeck's own Mod (resources/keepdeck-mod), loaded per spawn as a second
 * local plugin — `--plugin-dir` writes nothing into `~/.claude`. It states an
 * interrupt and an accepted prompt as they happen; see `companion` below for
 * what that takes over. Missing from the bundle, the pane simply runs
 * without it and the transcript tail keeps those facts, as before. */
async function modArgs(resources: PluginResources): Promise<string[]> {
  const manifest = await resources.path("keepdeck-mod/.claude-plugin/plugin.json");
  if (!manifest) return [];
  return ["--plugin-dir", manifest.slice(0, -"/.claude-plugin/plugin.json".length)];
}

/** The Mod's plugin name — its `.claude-plugin/plugin.json` says the same,
 * and index.test.ts holds the two in step. */
const MOD_PLUGIN_NAME = "keepdeck-reporter";

/** claude's YOLO switch. First use shows claude's own one-time in-TUI
 * acceptance prompt — expected, it runs interactively in the pane. */
const yoloArgs = (yolo: boolean | undefined): string[] =>
  yolo ? ["--dangerously-skip-permissions"] : [];

/** The staged shared skills, loaded as a per-session LOCAL plugin —
 * `--plugin-dir` is additive next to the user's installed plugins and
 * writes nothing into `~/.claude` (probe-verified on 2.1.214: skills load
 * with no consent prompt, named `keepdeck-skills:<name>`). */
const skillsArgs = (skills: SpawnSkillsInput | undefined): string[] =>
  skills ? ["--plugin-dir", skills.claudePluginDir] : [];

/**
 * Everything a launch of this CLI carries before its own arguments are
 * chosen — the two reporters, the staged skills, the injected MCP servers,
 * the YOLO flag — and the environment the user's deck-side choices ride in
 * (the artifacts switch).
 *
 * One place, because it was three. The same lines stood in `spawn.plan`,
 * `resume.plan` and `fork.plan`, held in step by whoever remembered. A
 * carrier added to one and forgotten in another is not a visible mistake: a
 * forked pane would simply come up without its reporter, or with artifacts
 * its source was denied, and go on looking like the ones that have them.
 * Each hook appends only what makes it that hook — the resume or fork tail.
 *
 * The settings are read per plan, never cached at activation: a plan is
 * built for every spawn, resume and fork, so the next process always
 * carries the current answer. A live one keeps what it started with either
 * way — claude decides at startup.
 */
async function stageLaunch(
  ctx: { resources: PluginResources; settings: Pick<PluginSettings, "read"> },
  input: Pick<SpawnPlanInput, "skills" | "mcp" | "yolo">,
  output: SpawnPlanOutput,
): Promise<void> {
  const mod = await modArgs(ctx.resources);
  output.args.push(
    ...(await hookArgs(ctx.resources, mod.length > 0)),
    ...mod,
    ...skillsArgs(input.skills),
    ...mcpArgs(input.mcp),
    ...yoloArgs(input.yolo),
  );
  output.env.push(...artifactsEnv(await ctx.settings.read()));
}

/** What the plugin needs from the host — the parts of its context it uses. */
export type ClaudePorts = HistoryPorts &
  LiveSessionsPorts & {
    agents: PluginAgents;
    resources: PluginResources;
    settings: Pick<PluginSettings, "registerSection" | "read">;
    services: Pick<ClaudeForkStore, "fs" | "fsWrite">;
  };

export function registerClaude(ctx: ClaudePorts): void {
  ctx.agents.register({
    id: "claude",
    label: "Claude Code",
    icon,
    detect: { bin: "claude" },
    // StatusLine carries provider cost/limits; the transcript tail supplies
    // deduplicated cumulative tokens.
    usage: {
      normalize: normalizeClaudeStatusline,
      tail: {
        watches: claudeUsageWatches,
        siblings: claudeSubagentDirectory,
      },
    },
    // The Mod states the transcript tail's status facts itself, from
    // inside the process: once it says hello, that process's tail carries
    // usage records only — one source per process.
    companion: { covers: ["status-records"] },
    status: {
      normalize: normalizeClaudeStatus,
      attribute: attributeClaudeEvent,
      mail: { channels: CLAUDE_MAIL_CHANNELS, render: renderClaudeMail },
      // Woken through the Mod when this pane's process has it — it starts
      // the turn from inside — and through the terminal when it does not.
      wake: "companion",
      // What a transcript record means, for the one edge claude pushes no
      // hook for. The host reads the `watch` to know which records to
      // carry; `normalize` applies the `read` to what arrives.
      tail: claudeTail,
    },
    history: claudeHistory(ctx),
    liveSessions: claudeLiveSessions(ctx),
    hooks: launchPlans({
      stage: (input, output) => stageLaunch(ctx, input, output),
      resume: (input) => ["--resume", input.sessionId],
      fork: (input) =>
        forkClaudeSession(
          { fs: ctx.services.fs, fsWrite: ctx.services.fsWrite, newId: () => crypto.randomUUID() },
          input,
        ),
    }),
  });
  // The switch for claude's OWN artifacts ([`ARTIFACTS_FIELD`]). The label
  // never reaches the screen — the plugin's page is titled by the manifest
  // name and renders the fields alone — so it repeats that title rather
  // than inventing a name nobody would ever see it under.
  ctx.settings.registerSection({
    label: "Claude Code",
    fields: [ARTIFACTS_FIELD],
  });
}

const plugin: KeepDeckPlugin = {
  activate: (ctx) => registerClaude(ctx),
};

export default plugin;
