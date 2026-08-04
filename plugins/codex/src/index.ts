/**
 * The Codex CLI plugin: identity, detection, and the spawn/resume hooks.
 * codex creates its session id lazily — the SessionStart hook (defined and
 * trusted purely via `-c` overrides, see `trust.ts`) reports it back
 * through the bridge. The `-c` flags are GLOBAL and must precede the
 * `resume` subcommand.
 */
import type {
  KeepDeckPlugin,
  PluginResources,
  SpawnPlanInput,
} from "@keepdeck/plugin-api";
import { codexHistory } from "./history";
import { icon } from "./icon";
import { mcpArgs } from "./mcp";
import { cliArgs, shellQuote } from "./trust";
import { normalizeCodexStatus } from "./status";
import { normalizeCodexRateLimits, normalizeCodexRollout } from "./usage";

/** The `-c` override args arming the reporters — SessionStart identity plus
 * the turn-lifecycle events; `[]` when neither script resolves. All rules
 * ride ONE cliArgs call because their trust shares a single `hooks.state`
 * table (a second `-c hooks.state=` would replace the first). On a codex
 * without hooks these overrides are inert (unknown `-c` keys are ignored),
 * so no version gate is needed; such a pane just stays unbound and revives
 * via its recorded binding.
 *
 * codex has no Notification and no StopFailure: PermissionRequest is its
 * only waiting edge, and an API-error turn is invisible to hooks (the
 * rollout tail supplies the interrupt edge; failures stay a known gap).
 * PostToolUse is the approval-resolution BACKSTOP — codex has no reply
 * hook either, and its completion lands only when the approved command
 * does; the host reads the user's own answer instead, so the amber no
 * longer waits out the command. See `status.ts` for the measured
 * sequence, and for why arming PreToolUse would not help (it fires
 * BEFORE the ask).
 *
 * SessionStart's `source` was live-verified on 0.146 and speaks claude's
 * vocabulary — `startup` on a boot, `resume` on `codex exec resume --last`.
 * That is what lets the deck read a codex rebind as a continuation rather
 * than a second fresh session; a codex whose words drifted would have its
 * mid-life session changes refused, silently, so this is worth re-measuring
 * when the payload changes. Captured payload:
 *   {"session_id":…,"transcript_path":…,"cwd":…,
 *    "hook_event_name":"SessionStart","model":…,
 *    "permission_mode":…,"source":"startup"} */
async function hookArgs(resources: PluginResources): Promise<string[]> {
  const session = await resources.path("kd-session-hook.sh");
  const status = await resources.path("kd-status-hook.sh");
  const rules = [
    ...(session
      ? [
          {
            event: "SessionStart",
            command: `/bin/sh ${shellQuote(session)} codex`,
          },
        ]
      : []),
    ...(status
      ? ["UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse"].map(
          (event) => ({
            event,
            command: `/bin/sh ${shellQuote(status)} codex`,
          }),
        )
      : []),
  ];
  if (rules.length === 0) return [];
  return cliArgs(rules);
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

/** The remote-client flag: when the pane targets a native-server endpoint,
 * codex runs HERE as a local thin client attached to a server provisioned on
 * the box by the host (the agent brain, files and tool calls execute there).
 * `--remote` is a global flag like `-c`/yolo, so it precedes the resume/fork
 * subcommand; it is supported on `codex`, `codex resume`, and `codex fork`. */
const remoteArgs = (target: SpawnPlanInput["target"]): string[] =>
  target?.kind === "nativeServer" ? ["--remote", target.endpoint] : [];

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
      // Remote support and its ws/wss schemes are declared once in the
      // manifest; this hook is only the implementation that consumes target.
      // Per-pane tokens/context stay in the rollout; current account limits
      // come from the host's one shared official app-server manager.
      usage: {
        normalize: normalizeCodexRollout,
        tail: "codex",
        limits: {
          poll: "codex-app-server",
          normalize: normalizeCodexRateLimits,
        },
      },
      status: { normalize: normalizeCodexStatus },
      history: codexHistory(ctx),
      hooks: {
        "spawn.plan": async (input, output) => {
          output.args = [
            ...remoteArgs(input.target),
            ...(await hookArgs(ctx.resources)),
            ...mcpArgs(input.mcp),
            ...disablePasteBurstArgs,
            ...yoloArgs(input.yolo),
          ];
        },
        "resume.plan": async (input, output) => {
          output.args = [
            ...remoteArgs(input.target),
            ...(await hookArgs(ctx.resources)),
            ...mcpArgs(input.mcp),
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
            ...remoteArgs(input.target),
            ...(await hookArgs(ctx.resources)),
            ...mcpArgs(input.mcp),
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
