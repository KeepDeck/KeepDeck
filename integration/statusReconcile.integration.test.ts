import { describe, expect, it } from "vitest";
import { watchMatches, watchProject, type StatusNormalizer, type TailWatch } from "@keepdeck/plugin-api";
import { normalizeClaudeStatus } from "../plugins/claude/src/status";
import { claudeTail } from "../plugins/claude/src/tail";
import { normalizeCodexStatus } from "../plugins/codex/src/status";
import { codexRecords } from "../plugins/codex/src/tail";
import { normalizeKimiStatus } from "../plugins/kimi/src/status";
import { kimiRecords } from "../plugins/kimi/src/tail";
import { createAgentStatusTracker } from "../src/app/agentStatusTracker";

/**
 * task-462, through each agent's REAL watches and normalizer: a turn the
 * hook started, whose ending the store recorded before the tail armed. The
 * arm sends the store's latest turn boundaries as one reconcile — the shape
 * the host's router emits — and the pane must end.
 */
function agentPane(agent: string, normalize: StatusNormalizer, watches: readonly TailWatch[]) {
  const tracker = createAgentStatusTracker();
  tracker.registerNormalizer(agent, normalize);
  const hook = (name: string, at: number) =>
    tracker.report("pane", { agent, event: { hook_event_name: name, session_id: "s" } }, at);
  /** What the arm sends: the last record of each status watch, file order. */
  const armAfter = (lines: Record<string, unknown>[], receivedAt: number) => {
    const records = lines.flatMap((line) => {
      const watch = watches.find((candidate) => candidate.lane === "status" && watchMatches(candidate, line));
      return watch ? [watchProject(watch, line)] : [];
    });
    tracker.report("pane", { agent, kind: "store.batch", records, reconcile: true }, receivedAt);
  };
  return { hook, armAfter, activity: () => tracker.getSnapshot().panes.get("pane") };
}

describe("a turn that ended before its tail armed still ends", () => {
  it("kimi: the main wire's turn.ended (kimi 2.3.1, an isolated session)", () => {
    // Times and shapes from a real 2.3.1 main wire; the prompt text is not here.
    const prompt = 1792899993891;
    const ended = 1792899993966;
    const { hook, armAfter, activity } = agentPane("kimi", normalizeKimiStatus, kimiRecords.watches);
    hook("UserPromptSubmit", prompt - 1);
    expect(activity()).toMatchObject({ state: "working" });
    armAfter([
      { type: "turn.prompt", agentId: "main", time: prompt, turnId: 0, input: "not carried" },
      { type: "turn.ended", agentId: "main", time: ended, turnId: 0, reason: "completed" },
    ], ended + 500);
    expect(activity()).toEqual({ state: "done", at: ended, interrupted: false });
  });

  it("claude: an Esc's interrupt marker, which fires no Stop", () => {
    const iso = (at: number) => new Date(at).toISOString();
    const started = Date.parse("2026-10-25T18:00:00.000Z");
    const { hook, armAfter, activity } = agentPane("claude", normalizeClaudeStatus, claudeTail.watches);
    hook("UserPromptSubmit", started);
    armAfter([
      { type: "user", timestamp: iso(started + 4_000), interruptedMessageId: "msg-1", message: { content: "not carried" } },
    ], started + 5_000);
    expect(activity()).toMatchObject({ state: "done", interrupted: true });
  });

  it("codex: a turn_aborted event, which fires no Stop", () => {
    const started = Date.parse("2026-10-25T18:00:00.000Z");
    const { hook, armAfter, activity } = agentPane("codex", normalizeCodexStatus, codexRecords.watches);
    hook("UserPromptSubmit", started);
    armAfter([
      { timestamp: new Date(started + 3_000).toISOString(), type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } },
    ], started + 4_000);
    expect(activity()).toMatchObject({ state: "done", interrupted: true });
  });

  it("and a store whose last turn is still running ends nothing", () => {
    const { hook, armAfter, activity } = agentPane("kimi", normalizeKimiStatus, kimiRecords.watches);
    hook("UserPromptSubmit", 2_000);
    armAfter([
      { type: "turn.ended", agentId: "main", time: 1_500, reason: "completed" },
      { type: "turn.prompt", agentId: "main", time: 2_001 },
    ], 2_500);
    expect(activity()).toMatchObject({ state: "working" });
  });
});
