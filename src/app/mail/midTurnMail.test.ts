import { collectsAtTurnEnd, type MailChannel } from "@keepdeck/plugin-api";
import { describe, expect, it } from "vitest";
import { CLAUDE_MAIL_CHANNELS } from "../../../plugins/claude/src/status";
import { CODEX_MAIL_CHANNELS } from "../../../plugins/codex/src/status";
import { KIMI_MAIL_CHANNELS } from "../../../plugins/kimi/src/status";
import { OPENCODE_MAIL_CHANNELS } from "../../../plugins/opencode/src/mail";
import { decideDelivery } from "../../domain/mail/policy";
import type { Mail } from "../../domain/mail/message";
import type { PaneActivity } from "../../domain/status";

/**
 * How a message reaches each built-in agent WHILE ITS TURN RUNS — a fact no
 * single module owns. The deck decides (decideDelivery), each agent declares
 * where it asks (its mail channels), and the agent's own reporter asks there.
 *
 * Each of those was tested on its own when opencode lost its only mid-turn
 * path: a rewrite of the deck's rule stopped waking a working pane, the
 * courier's doorbell test stayed green, and nothing failed (task-427). So
 * this pins the outcome per agent, from each agent's REAL declarations: a
 * working pane is either woken, or held for a channel that runs mid-turn.
 */
const AGENTS: { name: string; channels: readonly MailChannel[]; midTurn: string | "wake" }[] = [
  { name: "claude", channels: CLAUDE_MAIL_CHANNELS, midTurn: "PostToolBatch" },
  { name: "codex", channels: CODEX_MAIL_CHANNELS, midTurn: "PostToolUse" },
  // No channel at a turn's end, so a working pane is woken instead.
  { name: "kimi", channels: KIMI_MAIL_CHANNELS, midTurn: "wake" },
  { name: "opencode", channels: OPENCODE_MAIL_CHANNELS, midTurn: "mail.ask.tool" },
];

const working: PaneActivity = { state: "working", since: 1 };
const task: Mail = {
  id: "mail-1",
  kind: "task",
  body: "stop and rebase first",
  from: { kind: "pane", pane: { paneId: "pane-1", workspaceId: "ws-1", label: "lead" } },
  toPaneId: "pane-2",
  at: 1,
};

describe("mail for a pane whose turn is running", () => {
  it.each(AGENTS)("reaches $name before the turn ends", ({ channels, midTurn }) => {
    const verdict = decideDelivery(task, working, collectsAtTurnEnd({ channels, render: () => null }));

    if (midTurn === "wake") {
      expect(verdict).toEqual({ kind: "wake" });
      return;
    }
    // Held — which is only a delivery if something collects before the end.
    expect(verdict.kind).toBe("hold");
    expect(channels).toContainEqual({ event: midTurn, atTurnEnd: false });
  });
});
