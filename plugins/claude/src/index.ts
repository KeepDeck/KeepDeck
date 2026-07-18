/**
 * The Claude Code CLI plugin: identity, detection, and the spawn/resume
 * hooks. Identity is reporter-based, same scheme as every agent: claude
 * mints its own session id and the SessionStart hook posts it back at
 * startup — and again on `/clear`/compaction, which swap the id underneath
 * an otherwise-silent pane (probe-verified on 2.1.205: the startup event
 * carries the self-minted id). Resume REUSES the recorded id (forking is
 * opt-in upstream).
 */
import type {
  KeepDeckPlugin,
  PluginResources,
  SpawnSkillsInput,
} from "@keepdeck/plugin-api";
import { icon } from "./icon";

/** Quote a path for a shell command line (single quotes, `'\''` escaping) —
 * KeepDeck.app can live under a path with spaces. */
const shellQuote = (path: string) => `'${path.split("'").join(`'\\''`)}'`;

/** The `--settings` args arming both reporters — the SessionStart identity
 * hook and the statusLine usage reporter; each degrades independently when
 * its script is missing (`[]` only when neither resolves). The inline JSON
 * MERGES with the user's settings (hooks merge per event; verified on
 * 2.1.198); a user-configured statusLine is overridden INSIDE KeepDeck panes
 * only — the flag never touches config on disk. SessionStart fires on
 * startup/resume/clear/compact; the statusLine command runs event-driven on
 * every status update (rate_limits, cost, context_window on stdin). */
async function hookArgs(resources: PluginResources): Promise<string[]> {
  const session = await resources.path("kd-session-hook.sh");
  const usage = await resources.path("kd-usage-statusline.sh");
  const settings: Record<string, unknown> = {};
  if (session) {
    settings.hooks = {
      SessionStart: [
        {
          hooks: [
            { type: "command", command: `/bin/sh ${shellQuote(session)}` },
          ],
        },
      ],
    };
  }
  if (usage) {
    settings.statusLine = {
      type: "command",
      command: `/bin/sh ${shellQuote(usage)}`,
    };
  }
  if (Object.keys(settings).length === 0) return [];
  return ["--settings", JSON.stringify(settings)];
}

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

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "claude",
      label: "Claude Code",
      icon,
      detect: { bin: "claude" },
      supportsYolo: true,
      hooks: {
        "spawn.plan": async (input, output) => {
          output.args = [
            ...(await hookArgs(ctx.resources)),
            ...skillsArgs(input.skills),
            ...yoloArgs(input.yolo),
          ];
        },
        "resume.plan": async (input, output) => {
          output.args = [
            ...(await hookArgs(ctx.resources)),
            ...skillsArgs(input.skills),
            ...yoloArgs(input.yolo),
            "--resume",
            input.sessionId,
          ];
        },
      },
    });
  },
};

export default plugin;
