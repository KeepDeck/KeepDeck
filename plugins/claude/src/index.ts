/**
 * The Claude Code CLI plugin: identity, detection, and the spawn/resume
 * hooks. claude's session id is ASSIGNED — a fresh spawn adopts the host's
 * pre-minted id via `--session-id` (no discovery, ever) and resume REUSES
 * the recorded one (forking is opt-in upstream). The SessionStart hook
 * rides along as the reporter for mid-life session swaps — `/clear` and
 * compaction change the session id underneath an otherwise-silent pane.
 */
import type { KeepDeckPlugin, PluginResources } from "@keepdeck/plugin-api";

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
      detect: { bin: "claude" },
      hooks: {
        "spawn.plan": async (input, output) => {
          output.args = [
            ...(await hookArgs(ctx.resources)),
            "--session-id",
            input.sessionId,
          ];
          // Adopted — the host binds it immediately, no discovery.
          output.sessionId = input.sessionId;
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
