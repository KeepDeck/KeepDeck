/**
 * The OpenCode CLI plugin: identity, detection, and the spawn/resume hooks.
 * opencode creates its session id lazily — the session-reporter plugin
 * (injected per spawn via `OPENCODE_CONFIG_CONTENT`, which MERGES into the
 * user's config; nothing is installed on their side) reports it back
 * through the bridge, catching `/new` typed inside the TUI too.
 */
import type {
  KeepDeckPlugin,
  PluginResources,
  SpawnPlanInput,
  SpawnSkillsInput,
} from "@keepdeck/plugin-api";
import { icon } from "./icon";
import { opencodeHistory } from "./history";
import { relocatingForkId } from "./fork";
import { normalizeOpencodeUsage } from "./usage";

/** The per-invocation config injecting the reporter; `[]` when the reporter
 * file is missing (identity off, the spawn itself still fine). */
async function reporterEnv(
  resources: PluginResources,
): Promise<[string, string][]> {
  const reporter = await resources.path("session-reporter.js");
  if (!reporter) return [];
  // The array form is additive (plugin origins concatenate) — nothing in
  // the user's own config is replaced.
  return [["OPENCODE_CONFIG_CONTENT", JSON.stringify({ plugin: [reporter] })]];
}

/** opencode's YOLO switch: auto-allows every ask prompt while explicit deny
 * rules in the user's own config stay enforced. */
const yoloArgs = (yolo: boolean | undefined): string[] =>
  yolo ? ["--dangerously-skip-permissions"] : [];

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

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "opencode",
      label: "OpenCode",
      icon,
      detect: { bin: "opencode" },
      supportsYolo: true,
      // opencode has a native client/server split: the host can run this pane
      // as a local `opencode attach <ep>` thin client against an `opencode
      // serve` on a VPS. Declared as a capability so the host gates the remote
      // UI on it (mirrors codex; claude/kimi don't declare it). opencode's
      // serve speaks HTTP.
      remote: { mode: "nativeServer", schemes: ["http", "https"] },
      history: opencodeHistory(ctx),
      // Pane usage from the injected reporter's `message.updated` envelopes.
      // No account windows — opencode exposes none (see [`normalizeOpencodeUsage`]).
      usage: {
        capabilities: ["paneTelemetry"],
        normalize: normalizeOpencodeUsage,
      },
      hooks: {
        "spawn.plan": async (input, output) => {
          output.env.push(...(await reporterEnv(ctx.resources)));
          (output.envDefaults ??= []).push(...skillsEnvDefaults(input.skills));
          const remote = remoteAttachArgs(input.target, input.yolo);
          if (remote) {
            output.args = remote;
            return;
          }
          output.args = yoloArgs(input.yolo);
        },
        "resume.plan": async (input, output) => {
          output.env.push(...(await reporterEnv(ctx.resources)));
          (output.envDefaults ??= []).push(...skillsEnvDefaults(input.skills));
          const remote = remoteAttachArgs(input.target, input.yolo);
          if (remote) {
            output.args = remote;
            return;
          }
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
          output.env.push(...(await reporterEnv(ctx.resources)));
          (output.envDefaults ??= []).push(...skillsEnvDefaults(input.skills));
          const remote = remoteAttachArgs(input.target, input.yolo);
          if (remote) {
            output.args = remote;
            return;
          }
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
