/**
 * The OpenCode CLI plugin: identity, detection, and the spawn/resume hooks.
 * opencode creates its session id lazily — the session-reporter plugin
 * (injected per spawn via `OPENCODE_CONFIG_CONTENT`, which MERGES into the
 * user's config; nothing is installed on their side) reports it back
 * through the bridge, catching `/new` typed inside the TUI too.
 */
import type { KeepDeckPlugin, PluginResources } from "@keepdeck/plugin-api";
import { icon } from "./icon";

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

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "opencode",
      label: "OpenCode",
      icon,
      detect: { bin: "opencode" },
      supportsYolo: true,
      hooks: {
        "spawn.plan": async (input, output) => {
          output.env.push(...(await reporterEnv(ctx.resources)));
          output.args = yoloArgs(input.yolo);
        },
        "resume.plan": async (input, output) => {
          output.env.push(...(await reporterEnv(ctx.resources)));
          output.args = [...yoloArgs(input.yolo), "-s", input.sessionId];
        },
      },
    });
  },
};

export default plugin;
