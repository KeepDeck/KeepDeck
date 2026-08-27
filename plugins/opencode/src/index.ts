/**
 * The OpenCode CLI plugin: identity, detection, and the spawn/resume hooks.
 * opencode creates its session id lazily — the session-reporter plugin
 * (injected per spawn via `OPENCODE_CONFIG_CONTENT`, which MERGES into the
 * user's config; nothing is installed on their side) reports it back
 * through the bridge, catching `/new` typed inside the TUI too.
 */
import type {
  PluginContext,
  KeepDeckPlugin,
  PluginResources,
  SpawnPlanInput,
  SpawnSkillsInput,
} from "@keepdeck/plugin-api";
import { icon } from "./icon";
import { mcpConfigFragment } from "./mcp";
import { opencodeHistory } from "./history";
import { relocatingForkId } from "./fork";
import { renderOpencodeMail } from "./mail";
import { warmConfigDir } from "./warm";
import { normalizeOpencodeStatus } from "./status";
import { normalizeOpencodeUsage } from "./usage";

/**
 * The per-invocation config injecting KeepDeck's own opencode plugins.
 *
 * TWO of them, and they stay two. The reporter talks about this pane —
 * identity, usage, turn lifecycle — and asks for nothing; the courier
 * carries mail INTO the session and is the only one that asks. One file
 * doing both would tie a change in how a message is delivered to the code
 * that reports whether the pane is busy, and those change for different
 * reasons. Either can be missing (a broken install) without taking the
 * other, or the spawn, down with it.
 */
async function sessionConfigEnv(
  resources: PluginResources,
  mcp: SpawnPlanInput["mcp"],
): Promise<[string, string][]> {
  const ours = (
    await Promise.all([
      resources.path("session-reporter.js"),
      resources.path("mail-courier.js"),
    ])
  ).filter((path): path is string => Boolean(path));
  const servers = mcpConfigFragment(mcp);
  // ONE variable carries both: opencode reads `OPENCODE_CONFIG_CONTENT`
  // once, so a second assignment would silently drop the first.
  const config = {
    // The array form is additive (plugin origins concatenate) — nothing in
    // the user's own config is replaced.
    ...(ours.length > 0 ? { plugin: ours } : {}),
    ...(servers ?? {}),
  };
  return Object.keys(config).length > 0
    ? [["OPENCODE_CONFIG_CONTENT", JSON.stringify(config)]]
    : [];
}

/** opencode's YOLO switch: auto-allows every ask prompt while explicit deny
 * rules in the user's own config stay enforced. */
const yoloArgs = (yolo: boolean | undefined): string[] =>
  yolo ? ["--dangerously-skip-permissions"] : [];

/**
 * The same choice, said again where the reporter can hear it.
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
 * in both modes — the flag lives below the config and leaves no trace in any
 * merge layer — and the worker's environment carries nothing about it.
 *
 * Per pane, not per agent: the mode is a choice made at each spawn, and a
 * pane launched normally must go on surfacing the approvals it really waits
 * on.
 *
 * It travels on every launch, and on a REMOTE one it reaches nobody —
 * measured: an `attach` client does not load the plugins its own config
 * names, so a remote pane has no reporter to read this, and no statuses or
 * mail either. The remote path is unfinished; whatever eventually reports
 * from a server will need this mode delivered to it there, not here. */
const permissionModeEnv = (yolo: boolean | undefined): [string, string][] =>
  yolo ? [["KEEPDECK_OPENCODE_SKIPS_APPROVALS", "1"]] : [];

/** The staged shared skills as an EXTRA config directory — opencode loads
 * `OPENCODE_CONFIG_DIR` on top of the global and project ones (additive,
 * probe-verified on 1.18.3), and it composes fine with the reporter's
 * `OPENCODE_CONFIG_CONTENT` above. The host hands us a STABLE per-workspace
 * dir here, never a wiped staging one: opencode treats its config dir as a
 * writable home (plugin node_modules, account/state files — field-verified),
 * so pointing it at a rebuilt-from-scratch directory would destroy those.
 * Delivered as an env DEFAULT, not an override: `OPENCODE_CONFIG_DIR` is a
 * variable the user may legitimately own (their custom config home), and a
 * user-set value must win over skills delivery. */
const skillsEnvDefaults = (skills: SpawnSkillsInput | undefined): [string, string][] =>
  skills ? [["OPENCODE_CONFIG_DIR", skills.opencodeConfigDir]] : [];

/** When the pane targets a remote opencode server, THIS process is the local
 *  `opencode attach` thin client (the agent brain runs in `opencode serve` on
 *  the box). Unlike codex's `--remote`, `attach` is a subcommand that REPLACES
 *  the normal invocation — so remote resume/fork drop the local `-s`/`--fork`
 *  (session continuity is the server's job) and just attach. Returns null when
 *  the pane is local, so the hook falls through to its normal args. */
const remoteAttachArgs = (
  target: SpawnPlanInput["target"],
  yolo: boolean | undefined,
): string[] | null =>
  target?.kind === "nativeServer"
    ? ["attach", target.endpoint, ...yoloArgs(yolo)]
    : null;

/** Everything a launch of this CLI carries before its arguments are chosen —
 *  the injected plugins and MCP servers, the shared skills directory — and
 *  whether the remote path has already settled those arguments.
 *
 *  One place, because it was three. The same lines stood in `spawn.plan`,
 *  `resume.plan` and `fork.plan`, held in step by whoever remembered. A
 *  carrier added to one and forgotten in another is not a visible mistake: a
 *  forked pane would simply come up without its reporter, or without its
 *  skills, and go on looking like the ones that have them. */
async function stageLaunch(
  ctx: PluginContext,
  input: Pick<SpawnPlanInput, "mcp" | "skills" | "target" | "yolo">,
  output: { env: [string, string][]; envDefaults?: [string, string][]; args: string[] },
): Promise<boolean> {
  output.env.push(...(await sessionConfigEnv(ctx.resources, input.mcp)));
  output.env.push(...permissionModeEnv(input.yolo));
  (output.envDefaults ??= []).push(...skillsEnvDefaults(input.skills));
  const remote = remoteAttachArgs(input.target, input.yolo);
  if (remote) {
    // Remote settles the arguments AND ends the local story: the agent runs
    // on the server, this process is a thin client, and the config dir below
    // is one nothing will read. Warming it would be a minute spent on a
    // directory this pane never opens.
    output.args = remote;
    return true;
  }
  // Only now, with the pane known to be local: bootstrap the dir it is about
  // to boot against, so the install does not happen inside its own boot.
  if (input.skills) await warmConfigDir(ctx, input.skills.opencodeConfigDir);
  return false;
}

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "opencode",
      label: "OpenCode",
      icon,
      detect: { bin: "opencode" },
      // opencode has a native client/server split: the host can run this pane
      // as a local `opencode attach <ep>` thin client against an `opencode
      // serve` on a VPS. Support and http/https schemes are declared once in
      // the manifest; the hooks only implement the behavior.
      history: opencodeHistory(ctx),
      // Pane usage from the injected reporter's `message.updated` envelopes.
      // No account windows — opencode exposes none (see [`normalizeOpencodeUsage`]).
      usage: {
        normalize: normalizeOpencodeUsage,
      },
      // Turn lifecycle from the same reporter's bus subscription — which is
      // why this agent needs no transcript recovery: an interrupt is stated
      // on the bus like everything else. It is stated as an ERROR, though,
      // named `MessageAbortedError` and published before the idle behind it,
      // so what tells an interrupted turn from a broken one is the name and
      // not the shape (see [`normalizeOpencodeStatus`]).
      //
      // The other two edges no other agent gives us: permission.replied
      // resolves an approval, and question.asked is the only word anywhere
      // for a turn standing on a choice put in front of the user.
      //
      // Mail is the courier's half: it asks, and what it gets back it puts
      // straight into the session — with a turn for somebody's words,
      // without one for standing context. Which is also why this pane is
      // never woken by typing at it: `wake: "bridge"` sends the deck's nudge
      // to the courier, which is already inside the process and can start a
      // turn properly. Declared statically, so an install missing
      // mail-courier.js leaves mail to expire rather than fall back to the
      // terminal — a broken install should look broken, not different.
      status: {
        normalize: normalizeOpencodeStatus,
        renderMail: renderOpencodeMail,
        wake: "bridge",
      },
      hooks: {
        "spawn.plan": async (input, output) => {
          if (await stageLaunch(ctx, input, output)) return;
          output.args = yoloArgs(input.yolo);
        },
        "resume.plan": async (input, output) => {
          if (await stageLaunch(ctx, input, output)) return;
          output.args = [...yoloArgs(input.yolo), "-s", input.sessionId];
        },
        // Native `-s <id> --fork` re-homes the fork to the SOURCE session's
        // directory, ignoring the target (probe-verified, 1.18.4). So a
        // RELOCATING fork goes through export→rekey→import (see `fork.ts`),
        // binding the new session's directory to the target. `relocatingForkId`
        // returns the relocated session's id, or null (native `--fork`
        // fallback) for a not-yet-provisioned worktree OR any recipe failure.
        // Remote short-circuits all of this: attach to the server, where the
        // fork runs server-side.
        "fork.plan": async (input, output) => {
          if (await stageLaunch(ctx, input, output)) return;
          const relocated = await relocatingForkId(ctx, input);
          output.args = relocated
            ? [...yoloArgs(input.yolo), "-s", relocated]
            : [...yoloArgs(input.yolo), "-s", input.sessionId, "--fork"];
        },
      },
    });
  },
};

export default plugin;
