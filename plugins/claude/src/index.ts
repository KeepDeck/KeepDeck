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
import { normalizeClaudeStatusline } from "./usage";
import { claudeHistory } from "./history";

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
      // Also re-run on a timer: event-driven updates go quiet on an idle
      // session, freezing the chip's "Updated" at the last turn.
      refreshInterval: 60,
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

/** Claude encodes a session's project dir into the store path:
 * `~/.claude/projects/<slug>/<sessionId>.jsonl`, slug = the absolute cwd
 * with `/`, `.` and `_` each replaced by `-`. `--resume` searches ONLY the
 * current cwd's slug dir (the `--cwd` flag request was closed not-planned),
 * so a cross-directory fork copies the transcript into the TARGET's slug
 * dir first — the community-verified relocation recipe. */
const projectSlug = (cwd: string): string => cwd.replace(/[/._]/g, "-");

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "claude",
      label: "Claude Code",
      icon,
      detect: { bin: "claude" },
      supportsYolo: true,
      // The statusLine reporter pushes; no tail, no poll.
      usage: { normalize: normalizeClaudeStatusline },
      history: claudeHistory(ctx),
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
        /** Cross-directory fork: copy the recorded transcript into the
         * target cwd's slug dir, then spawn `--resume <id> --fork-session`
         * THERE — claude finds the copy, and --fork-session mints a fresh
         * session id for the continuation, leaving the original resumable
         * where it was (no duplicate-id ambiguity). The copy lands inside
         * `~/.claude/projects` only — exactly the manifest's fsWrite scope. */
        "fork.plan": async (input, output) => {
          const source = input.transcriptPath;
          if (!source) {
            // Without the reporter-delivered path there is nothing safe to
            // copy — guessing the source slug would be store archaeology.
            throw new Error(
              `claude fork of ${input.sessionId}: no recorded transcript path`,
            );
          }
          if (!/\.jsonl$/.test(source)) {
            throw new Error(
              `claude fork of ${input.sessionId}: transcript is not a .jsonl (${source})`,
            );
          }
          // The projects root comes from the transcript itself — no home
          // lookup, and a layout change breaks LOUDLY here instead of
          // copying into a wrong tree.
          const marker = "/projects/";
          const at = source.lastIndexOf(marker);
          if (at < 0) {
            throw new Error(
              `claude fork of ${input.sessionId}: unexpected store layout (${source})`,
            );
          }
          const projectsRoot = source.slice(0, at + marker.length - 1);
          const target = `${projectsRoot}/${projectSlug(input.cwd)}/${input.sessionId}.jsonl`;
          await ctx.services.fsWrite.copyFile(source, target);
          output.args = [
            ...(await hookArgs(ctx.resources)),
            ...skillsArgs(input.skills),
            ...yoloArgs(input.yolo),
            "--resume",
            input.sessionId,
            "--fork-session",
          ];
        },
      },
    });
  },
};

export default plugin;
