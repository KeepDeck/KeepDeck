/**
 * The Claude Code CLI plugin: identity, detection, and the spawn/resume
 * hooks. Identity is reporter-based, same scheme as every agent: claude
 * mints its own session id and the SessionStart hook posts it back at
 * startup — and again on `/clear`/compaction, which swap the id underneath
 * an otherwise-silent pane (probe-verified on 2.1.205: the startup event
 * carries the self-minted id). Resume REUSES the recorded id (forking is
 * opt-in upstream).
 */
import type { KeepDeckPlugin, PluginResources } from "@keepdeck/plugin-api";
import { icon } from "./icon";

/** Quote a path for a shell command line (single quotes, `'\''` escaping) —
 * KeepDeck.app can live under a path with spaces. */
const shellQuote = (path: string) => `'${path.split("'").join(`'\\''`)}'`;

/** The `--settings` args arming the SessionStart reporter; `[]` when the
 * script is missing (identity off, the spawn itself still fine). The inline
 * JSON MERGES with the user's settings (hooks merge per event; verified on
 * 2.1.198), and SessionStart fires on startup/resume/clear/compact. */
async function hookArgs(resources: PluginResources): Promise<string[]> {
  const script = await resources.path("kd-session-hook.sh");
  if (!script) return [];
  const settings = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            { type: "command", command: `/bin/sh ${shellQuote(script)}` },
          ],
        },
      ],
    },
  };
  return ["--settings", JSON.stringify(settings)];
}

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "claude",
      label: "Claude Code",
      icon,
      detect: { bin: "claude" },
      hooks: {
        "spawn.plan": async (_input, output) => {
          output.args = await hookArgs(ctx.resources);
        },
        "resume.plan": async (input, output) => {
          output.args = [
            ...(await hookArgs(ctx.resources)),
            "--resume",
            input.sessionId,
          ];
        },
      },
    });
  },
};

export default plugin;
