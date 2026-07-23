/**
 * The Codex CLI plugin: identity, detection, and the spawn/resume hooks.
 * codex creates its session id lazily — the SessionStart hook (defined and
 * trusted purely via `-c` overrides, see `trust.ts`) reports it back
 * through the bridge. The `-c` flags are GLOBAL and must precede the
 * `resume` subcommand.
 */
import type { KeepDeckPlugin, PluginResources } from "@keepdeck/plugin-api";
import { codexHistory } from "./history";
import { icon } from "./icon";
import { cliArgs, shellQuote } from "./trust";
import { normalizeCodexRateLimits, normalizeCodexRollout } from "./usage";

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

/** codex's PasteBurst heuristic collapses fast UNBRACKETED input beyond
 * ~1000 chars into a non-editable [Pasted Content N chars] placeholder. It
 * exists for terminals that don't surface bracketed paste — KeepDeck's xterm
 * does, so the fallback is redundant here; disabling it keeps voice dictation
 * (raw TYPE keystrokes via pane.write mode:"type") inline and editable past
 * the threshold. Spawn task delivery is unaffected — it uses the PASTE
 * channel, which PasteBurst never gates. Same `-c` override as the hook args,
 * same forward-compat (an unknown key is ignored), and global, so it precedes
 * the `resume`/`fork` subcommand. */
const disablePasteBurstArgs: string[] = ["-c", "disable_paste_burst=true"];

// Shared skills need NO code here: codex has no flag/env/config door
// (openai/codex#15149, #22869), but it reads `.agents/skills` from its
// starting cwd at session start — and the host's staging arms every pane
// spawn cwd with a symlink to the staged view before the spawn
// (src-tauri/src/skills.rs, arm_roots). The filesystem is the delivery;
// argv/env stay untouched. `input.skills` still arrives for the day codex
// grows a real injection flag.

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "codex",
      label: "Codex",
      icon,
      detect: { bin: "codex" },
      supportsYolo: true,
      // Per-pane tokens/context stay in the rollout; current account limits
      // come from the host's one shared official app-server manager.
      usage: {
        capabilities: ["paneTelemetry", "accountLimits"],
        normalize: normalizeCodexRollout,
        tail: "codex",
        limits: {
          poll: "codex-app-server",
          normalize: normalizeCodexRateLimits,
        },
      },
      history: codexHistory(ctx),
      hooks: {
        "spawn.plan": async (input, output) => {
          output.args = [
            ...(await hookArgs(ctx.resources)),
            ...disablePasteBurstArgs,
            ...yoloArgs(input.yolo),
          ];
        },
        "resume.plan": async (input, output) => {
          output.args = [
            ...(await hookArgs(ctx.resources)),
            ...disablePasteBurstArgs,
            ...yoloArgs(input.yolo),
            "resume",
            input.sessionId,
          ];
        },
        // codex forks natively: `codex fork <id>` resolves the session by
        // its GLOBAL id (no cwd filter), mints a NEW session id, copies the
        // history, and binds the fork to the invocation dir — no store
        // surgery at all (probe-verified, RESUME_ANY_HISTORY.md §2).
        "fork.plan": async (input, output) => {
          output.args = [
            ...(await hookArgs(ctx.resources)),
            ...disablePasteBurstArgs,
            ...yoloArgs(input.yolo),
            "fork",
            input.sessionId,
          ];
        },
      },
    });
  },
};

export default plugin;
