/**
 * How a pane's opencode is launched — one interface, a whole launch per
 * generation, each composed from parts.
 *
 * It used to be one function deciding everything in turn — the plugin, the
 * servers, the permission mode, the skills dialect, the config dir, the
 * warm-up, the flags — with the version and the remote target tested in
 * several places on the way. Each new carrier added another test of the
 * same two facts. Here a part knows nothing of versions: it is simply in a
 * generation's launch or not, and [`launchFor`] is the one place that reads
 * the version and the target.
 *
 * The draft holds only what EVERY launch carries. Whatever one generation
 * needs (a config dir, a flag) is a part of that generation's launch, never a
 * field of the draft.
 */
import type {
  PluginContext,
  ResumeLaunch,
  SpawnPlanInput,
  SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import { mcpConfigFragment } from "./mcp";
import { opencodeGeneration } from "./version";
import { warmConfigDir } from "./warm";

/** What a launch is decided from. */
export type LaunchInput = Pick<
  SpawnPlanInput,
  "mcp" | "skills" | "target" | "yolo" | "cliVersion"
>;

/** What every launch of opencode carries, while it is being assembled. */
export interface LaunchDraft {
  /** Becomes ONE `OPENCODE_CONFIG_CONTENT`: opencode reads it once, so a
   * second assignment would silently drop the first. */
  config: Record<string, unknown>;
  env: [string, string][];
  envDefaults: [string, string][];
  args: string[];
}

/** One way to prepare a launch: a whole generation's, or one part of it. */
export interface OpencodeLaunch {
  prepare(input: LaunchInput, draft: LaunchDraft): Promise<void>;
}

/** Parts in order — itself a launch. */
export const composed = (...parts: OpencodeLaunch[]): OpencodeLaunch => ({
  async prepare(input, draft) {
    for (const part of parts) await part.prepare(input, draft);
  },
});

/** A part that needs nothing awaited. */
const part = (prepare: (input: LaunchInput, draft: LaunchDraft) => void): OpencodeLaunch => ({
  async prepare(input, draft) {
    prepare(input, draft);
  },
});

/**
 * KeepDeck's own opencode plugin, by absolute path under the legacy `plugin`
 * key — the one shape both generations load (task-425): 1.x finds its
 * `index.js`, 2.x migrates the key and refuses a FILE path. The array form is
 * additive (plugin origins concatenate), so nothing in the user's own config
 * is replaced. Its reporter and courier stay separate components inside it
 * (resources/keepdeck-plugin/index.js says why they are one entry).
 */
const keepdeckServerPlugin = (ctx: PluginContext): OpencodeLaunch => ({
  async prepare(_input, draft) {
    // `resources.path` answers about files, so the directory is found through
    // its entry — which also keeps a bundle missing the entry from injecting
    // a directory opencode cannot load.
    const entry = await ctx.resources.path("keepdeck-plugin/index.js");
    if (entry) draft.config.plugin = [entry.slice(0, -"/index.js".length)];
  },
});

/** The MCP servers, in the same config variable as the plugin. */
const mcpServers = part((input, draft) => {
  Object.assign(draft.config, mcpConfigFragment(input.mcp) ?? {});
});

/**
 * The pane's approval mode, said where the reporter can hear it.
 *
 * With approvals skipped, opencode answers its own prompts within
 * milliseconds — measured, 715 of 732 pairs inside one second — and its reply
 * carries the same "once" a person's would. So nothing on the wire tells an
 * automatic approval from a human one, and the deck announced "needs
 * approval" for prompts nobody was ever going to see.
 *
 * The deck STATES the mode rather than the reporter discovering it, because
 * discovery was measured impossible: the TUI runs plugins in a worker whose
 * argv is the worker's own, the effective config is identical leaf for leaf
 * in both modes, and the worker's environment carries nothing about it.
 *
 * Per pane, not per agent: the mode is a choice made at each spawn. On a
 * REMOTE pane it reaches nobody — an `attach` client does not load the
 * plugins its own config names.
 *
 * The flag itself is not here: it belongs to each launch's arguments, in the
 * place that launch has always put it.
 */
const permissionMode = part((input, draft) => {
  if (input.yolo) draft.env.push(["KEEPDECK_OPENCODE_SKIPS_APPROVALS", "1"]);
});

/** opencode's YOLO switch: auto-allows every ask prompt while explicit deny
 * rules in the user's own config stay enforced. */
const yoloArgs = (yolo: boolean | undefined): string[] =>
  yolo ? ["--dangerously-skip-permissions"] : [];

/**
 * 1.x: the staged skills as an EXTRA config directory — opencode loads
 * `OPENCODE_CONFIG_DIR` on top of the global and project ones (additive,
 * probe-verified on 1.18.3). The host hands over a STABLE per-workspace dir,
 * never a wiped staging one: opencode treats its config dir as a writable
 * home (plugin node_modules, account/state files — field-verified), so a
 * rebuilt-from-scratch directory would destroy those.
 *
 * An env DEFAULT, not an override: `OPENCODE_CONFIG_DIR` is a variable the
 * user may legitimately own (their custom config home), and a user-set value
 * must win over skills delivery.
 *
 * Then bootstrapped, so the dependency install does not happen inside the
 * pane's own boot (see warm.ts).
 */
const stagedConfigDir = (ctx: PluginContext): OpencodeLaunch => ({
  async prepare(input, draft) {
    const dir = input.skills?.opencodeConfigDir;
    if (!dir) return;
    draft.envDefaults.push(["OPENCODE_CONFIG_DIR", dir]);
    await warmConfigDir(ctx, dir);
  },
});

/**
 * 1.x: KeepDeck's TUI plugin (resources/keepdeck-plugin/route-observer.js),
 * which tells the server half which session the user is looking at — `/new`
 * and `/sessions` move only the TUI, and mail followed a session nobody could
 * see (task-435).
 *
 * NOT named `tui.*`: opencode 2.x resolves a plugin directory's TUI entry by
 * the bare name `tui`, found a `tui.json` there, and refused it — "1 plugin
 * failed" on every 2.x pane (task-448, measured).
 *
 * Through a file that ships beside it, `tui-v1.json` = `{"plugin":
 * ["./route-observer.js"]}`: a relative spec resolves against the file
 * (config/plugin.ts:42-54 at v1.19.3; verified live), so nothing is written at
 * launch. opencode reads `OPENCODE_TUI_CONFIG` ON TOP of the user's own TUI
 * config, and the file holds nothing but `plugin`, so their theme and keys
 * stay theirs (verified live).
 *
 * Kept apart from the skills' config dir on purpose (user decision): each
 * rides its own variable, so a user who owns one of them loses only that one.
 * An env DEFAULT, for the same reason as the config dir: a user-set value
 * wins, and the pane then simply has no observer — mail behaves as it did
 * before there was one.
 */
const tuiObserver = (ctx: PluginContext): OpencodeLaunch => ({
  async prepare(_input, draft) {
    const config = await ctx.resources.path("keepdeck-plugin/tui-v1.json");
    if (config) draft.envDefaults.push(["OPENCODE_TUI_CONFIG", config]);
  },
});

/**
 * 2.x: extra skill paths in the config — the bare `<skill>/SKILL.md` layout it
 * scans (config/plugin/skill-scan.ts), listed under its own `/skills`.
 *
 * Never `OPENCODE_CONFIG_DIR` here: on 2.x it REPLACES the user's global
 * config instead of adding to it (util/src/global.ts at v2.1.2; verified
 * live, task-425), so a pane would lose the user's providers, plugins and
 * instructions.
 */
const skillsInConfig = part((input, draft) => {
  if (input.skills) draft.config.skills = [input.skills.skillsDir];
});

/** 1.x arguments. */
const invocationV1 = part((input, draft) => {
  draft.args.push(...yoloArgs(input.yolo));
});

/**
 * 2.x arguments: `--standalone` first.
 *
 * Without it every 2.x process on the machine joins one background service,
 * which loads KeepDeck's plugin once, with the environment of whichever pane
 * started it — so every other pane's reports would carry that pane's bridge.
 * 1.x has no such flag and EXITS on it (1.19.3, measured).
 */
const invocationV2 = part((input, draft) => {
  draft.args.push("--standalone", ...yoloArgs(input.yolo));
});

/**
 * A remote pane: THIS process is the local `opencode attach` thin client (the
 * agent runs in `opencode serve` on the box). `attach` is a subcommand that
 * REPLACES the normal invocation, so the launch is settled here — no `-s`,
 * no fork surgery: session continuity is the server's job.
 *
 * It gets nothing local: no config dir, no skills, no warm-up — `attach`
 * loads none of them, so they would only be a directory warmed for nothing.
 */
const remoteAttach = (endpoint: string) =>
  part((input, draft) => {
    draft.args.push("attach", endpoint, ...yoloArgs(input.yolo));
  });

/** How a recorded session opens: `-s`, on every generation. */
const resumeV1 = (sessionId: string): ResumeLaunch => ["-s", sessionId];

/**
 * 2.x: `-s`, and the same id in the environment.
 *
 * Under `--standalone` KeepDeck's plugin runs in the child `opencode serve`
 * the TUI starts, whose arguments carry no `-s` — but the environment passes
 * through (measured, task-382). Without it the pane stays unbound until the
 * resumed session says something, and the deck's ring delivers nothing in
 * the meantime: mail waits for the user's own turn.
 */
export const OPENCODE_SESSION_ENV = "KEEPDECK_OPENCODE_SESSION";
const resumeV2 = (sessionId: string): ResumeLaunch => ({
  args: ["-s", sessionId],
  env: [[OPENCODE_SESSION_ENV, sessionId]],
});

/** Which launch this pane gets, whether it settles the invocation whole, and
 * how it opens a recorded session — THE place the version and the target are
 * read. An unknown version runs as 1.x: 1.x exits on 2.x's flags, while 2.x
 * merely lacks 1.x's extras. */
export function launchFor(
  ctx: PluginContext,
  input: LaunchInput,
): { launch: OpencodeLaunch; settles: boolean; resume: (sessionId: string) => ResumeLaunch } {
  const shared = [keepdeckServerPlugin(ctx), mcpServers, permissionMode];
  if (input.target?.kind === "nativeServer") {
    return {
      launch: composed(...shared, remoteAttach(input.target.endpoint)),
      settles: true,
      resume: resumeV1,
    };
  }
  if (opencodeGeneration(input.cliVersion) === 2) {
    return {
      launch: composed(...shared, skillsInConfig, invocationV2),
      settles: false,
      resume: resumeV2,
    };
  }
  return {
    launch: composed(...shared, stagedConfigDir(ctx), tuiObserver(ctx), invocationV1),
    settles: false,
    resume: resumeV1,
  };
}

/** The draft onto the hook's output: the config as ONE variable, ahead of the
 * rest of the environment. */
export function render(draft: LaunchDraft, output: SpawnPlanOutput): void {
  if (Object.keys(draft.config).length > 0) {
    output.env.push(["OPENCODE_CONFIG_CONTENT", JSON.stringify(draft.config)]);
  }
  output.env.push(...draft.env);
  (output.envDefaults ??= []).push(...draft.envDefaults);
  output.args.push(...draft.args);
}

/** Everything a launch of this CLI carries before a session is named; true
 * when the launch is settled whole (remote attach). */
export async function stageLaunch(
  ctx: PluginContext,
  input: LaunchInput,
  output: SpawnPlanOutput,
): Promise<boolean> {
  const { launch, settles } = launchFor(ctx, input);
  const draft: LaunchDraft = { config: {}, env: [], envDefaults: [], args: [] };
  await launch.prepare(input, draft);
  render(draft, output);
  return settles;
}
