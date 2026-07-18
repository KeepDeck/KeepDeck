/**
 * The Codex CLI plugin: identity, detection, and the spawn/resume hooks.
 * codex creates its session id lazily — the SessionStart hook (defined and
 * trusted purely via `-c` overrides, see `trust.ts`) reports it back
 * through the bridge. The `-c` flags are GLOBAL and must precede the
 * `resume` subcommand.
 */
import type { KeepDeckPlugin, PluginResources } from "@keepdeck/plugin-api";
import { icon } from "./icon";
import { cliArgs, shellQuote } from "./trust";

/** The `-c` override args arming the SessionStart reporter; `[]` when the
 * script is missing. On a codex without hooks these overrides are inert
 * (unknown `-c` keys are ignored), so no version gate is needed; such a
 * pane just stays unbound and revives via its recorded binding. */
async function hookArgs(resources: PluginResources): Promise<string[]> {
  const script = await resources.path("kd-session-hook.sh");
  if (!script) return [];
  return cliArgs(`/bin/sh ${shellQuote(script)}`);
}

/** codex's YOLO switch (`--yolo` is its alias). Global like `-c`, so it
 * must precede the `resume` subcommand. */
const yoloArgs = (yolo: boolean | undefined): string[] =>
  yolo ? ["--dangerously-bypass-approvals-and-sandbox"] : [];

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "codex",
      label: "Codex",
      icon,
      detect: { bin: "codex" },
      supportsYolo: true,
      hooks: {
        "spawn.plan": async (input, output) => {
          output.args = [
            ...(await hookArgs(ctx.resources)),
            ...yoloArgs(input.yolo),
          ];
        },
        "resume.plan": async (input, output) => {
          output.args = [
            ...(await hookArgs(ctx.resources)),
            ...yoloArgs(input.yolo),
            "resume",
            input.sessionId,
          ];
        },
      },
    });
  },
};

export default plugin;
