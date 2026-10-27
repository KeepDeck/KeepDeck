/**
 * The Codex CLI plugin: identity, detection, and the spawn/resume hooks.
 * codex creates its session id lazily — the SessionStart hook (defined and
 * trusted purely via `-c` overrides, see `trust.ts`) reports it back
 * through the bridge. The `-c` flags are GLOBAL and must precede the
 * `resume` subcommand.
 */
import {
  launchPlans,
  mailAskArgs,
  shellQuote,
  type KeepDeckPlugin,
  type PluginAgents,
  type PluginResources,
  type PluginRpc,
} from "@keepdeck/plugin-api";
import { codexBinding } from "./binding";
import { codexHistory, type HistoryPorts } from "./history";
import { icon } from "./icon";
import { codexPresentation } from "./presentation";
import { mcpArgs } from "./mcp";
import { processArgs } from "./process";
import { cliArgs } from "./trust";
import {
  attributeCodexEvent,
  CODEX_MAIL_CHANNELS,
  normalizeCodexStatus,
  renderCodexMail,
} from "./status";
import { newestRollouts } from "./store";
import { codexTail } from "./tail";
import {
  codexUsageWatches,
  normalizeCodexRateLimits,
  readCodexLimits,
  normalizeCodexRollout,
} from "./usage";

/** The `-c` override args arming the reporters — SessionStart identity plus
 * the turn-lifecycle events; `[]` when neither script resolves. All rules
 * ride ONE cliArgs call because their trust shares a single `hooks.state`
 * table (a second `-c hooks.state=` would replace the first). On a codex
 * without hooks these overrides are inert (unknown `-c` keys are ignored),
 * so no version gate is needed; such a pane just stays unbound and revives
 * via its recorded binding.
 *
 * PermissionRequest supplies approval waits; the rollout supplies blocking
 * questions, terminal API failures and the cross-version abort fallback.
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
/** The events whose answer this CLI can act on. Named once, because the
 * arming loop and the renderer have to agree and a drift between them is
 * silent: a hook that asks where nothing is rendered waits out its window
 * every time, and one that renders where nothing asks is never called.
 *
 * `SessionStart` asks too, as a SECOND handler beside the identity
 * reporter. codex's `-c hooks.<Event>=` replaces rather than merges, so the
 * two share one handler group, each trusted on its own (see `trust.ts`).
 * Identity stays handler 0. The ask matters after a compaction: codex runs
 * `SessionStart` with source `compact` before the next model request, inside
 * the running turn for an automatic one, so the re-stated briefing arrives
 * one tool call sooner than `PostToolUse` would bring it.
 *
 * The set itself is declared beside the renderer that has to answer these
 * events ([`CODEX_MAIL_CHANNELS`] in ./status): stated twice, the two drift in
 * silence — armed-but-unrendered burns a two-second wait per fire, and
 * rendered-but-unarmed sends that event's mail to the terminal instead. */

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
      ? ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "PostToolUse", "Interrupt", "PostCompact"].map(
          (event) => ({
            event,
            // Mail rides `additionalContext`, and past ~2500 tokens codex
            // hands the model a head-and-tail preview with the rest in a
            // file. 0 keeps a long message whole on every event that can
            // carry context (trust.ts keeps the field only there); `Stop`
            // ignores it, verified live.
            additionalContextLimit: 0,
            // `--ask` makes the reporter WAIT for the deck and print its
            // answer. Stop blocks and continues; UserPromptSubmit spills
            // extra context into the turn just opened; PostToolUse does the
            // same one boundary earlier, while the turn is still running,
            // which is the only way to reach a working agent without typing
            // into its terminal. It costs a round trip per TOOL CALL, and
            // that is the price of the mid-turn channel — the deck answers
            // in milliseconds when nothing is waiting. PermissionRequest
            // genuinely reads nothing back. Interrupt is the user's Esc,
            // pushed the moment it happens (the rollout's turn_aborted stays
            // the fallback for older codex and other abort reasons); codex
            // gives it one second, which is why trust.ts hashes it so.
            // PostCompact is the context rebuilt: a manual compaction after
            // a failed turn runs no prompt or stop hook at all, and without
            // it the pane keeps showing the failure (verified live, 0.163).
            // SessionStart asks beside the identity reporter (see above).
            command: [
              `/bin/sh ${shellQuote(status)} codex`,
              ...mailAskArgs(CODEX_MAIL_CHANNELS, event),
            ].join(" "),
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

// Shared skills need NO code here: codex has no flag/env/config door
// (openai/codex#15149, #22869), but it reads `.agents/skills` from its
// starting cwd at session start — and the host's staging arms every pane
// spawn cwd with a symlink to the staged view before the spawn
// (src-tauri/src/skills.rs, arm_roots). The filesystem is the delivery;
// argv/env stay untouched. `input.skills` still arrives for the day codex
// grows a real injection flag.

/** What the plugin needs from the host — the parts of its context it uses. */
export type CodexPorts = HistoryPorts & {
  agents: PluginAgents;
  resources: PluginResources;
  services: { rpc: PluginRpc };
};

export function registerCodex(ctx: CodexPorts): void {
  ctx.agents.register({
    id: "codex",
    label: "Codex",
    icon,
    detect: { bin: "codex" },
    presentation: codexPresentation,
    // Remote support and its ws/wss schemes are declared once in the
    // manifest; this hook is only the implementation that consumes target.
    // Per-pane tokens/context stay in the rollout; current account limits
    // come from codex's own app-server, which the host keeps for this plugin.
    usage: {
      normalize: normalizeCodexRollout,
      tail: {
        watches: codexUsageWatches,
        // A rollout records the ACCOUNT's limits, so the newest files on
        // disk are worth reading before any pane exists. Ten because a
        // just-launched session writes its rollout before its first turn:
        // the newest file can be empty of limits while the real last word
        // sits a file or two back.
        sweep: () => newestRollouts(ctx, 10),
      },
      limits: {
        read: () => readCodexLimits(ctx.services.rpc),
        normalize: normalizeCodexRateLimits,
      },
    },
    status: {
      normalize: normalizeCodexStatus,
      attribute: attributeCodexEvent,
      mail: { channels: CODEX_MAIL_CHANNELS, render: renderCodexMail },
      // What a rollout record means, for the turn edge codex pushes no
      // hook for. The host reads the `watch` to know what to carry;
      // `normalize` applies the `read` to what arrives.
      tail: codexTail(ctx),
    },
    // codex reports its `/new` as `startup`; this says when that is the
    // user's new conversation rather than a second session (./binding.ts).
    binding: codexBinding,
    history: codexHistory(ctx),
    hooks: {
      ...launchPlans({
        // Every `-c` flag, the process flag and the yolo switch are GLOBAL:
        // they precede the `resume`/`fork` subcommand the tail adds.
        stage: async (input, output) => {
          output.args.push(
            ...processArgs(input),
            ...(await hookArgs(ctx.resources)),
            ...mcpArgs(input.mcp, ctx.log),
            ...disablePasteBurstArgs,
            ...yoloArgs(input.yolo),
          );
        },
        resume: (input) => ["resume", input.sessionId],
        // codex forks natively: `codex fork <id>` resolves the session by
        // its GLOBAL id (no cwd filter), mints a NEW session id, copies the
        // history, and binds the fork to the invocation dir — no store
        // surgery at all (probe-verified, RESUME_ANY_HISTORY.md §2).
        fork: (input) => ["fork", input.sessionId],
      }),
      // A spawn whose plan failed still runs codex, and without this it
      // would run on the user's daemon: the `-c` that kept it off went with
      // the plan. The same rule as every staged launch, nothing else.
      "bare.plan": (input, output) => {
        output.args.push(...processArgs(input));
      },
    },
  });
}

const plugin: KeepDeckPlugin = {
  activate: (ctx) => registerCodex(ctx),
};

export default plugin;
