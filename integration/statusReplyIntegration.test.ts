import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStatus } from "@keepdeck/plugin-api";
import {
  attributeClaudeEvent,
  CLAUDE_MAIL_CHANNELS,
  normalizeClaudeStatus,
  renderClaudeMail,
} from "../plugins/claude/src/status";
import {
  attributeCodexEvent,
  CODEX_MAIL_CHANNELS,
  normalizeCodexStatus,
  renderCodexMail,
} from "../plugins/codex/src/status";
import { createAgentStatusTracker } from "../src/app/agentStatusTracker";
import {
  createAgentStatusChannel,
  type StatusDeclarationsPort,
} from "../src/app/agentStatusChannel";
import { createPaneAttribution } from "../src/app/paneAttribution";
import { deckStoreOf } from "../src/app/deckStore.testSupport";
import type { PaneReportEvent } from "../src/app/verifiedPaneReports";
import { createMailManager } from "../src/app/mail/mailManager";
import { createHookReplies, type HookReplyDeps } from "../src/app/mail/hookReply";

const ipc = vi.hoisted(() => ({ handler: undefined as ((report: PaneReportEvent) => void) | undefined }));
vi.mock("../src/ipc/status", () => ({ onAgentStatus: async (fn: typeof ipc.handler) => {
  ipc.handler = fn;
  return () => {};
} }));
vi.mock("../src/app/ptyManager", () => ({ paneSessionState: () => ({ kind: "live" }) }));

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const CLAUDE: AgentStatus = {
  normalize: normalizeClaudeStatus,
  attribute: attributeClaudeEvent,
  mail: { channels: CLAUDE_MAIL_CHANNELS, render: renderClaudeMail },
};
const CODEX: AgentStatus = {
  normalize: normalizeCodexStatus,
  attribute: attributeCodexEvent,
  mail: { channels: CODEX_MAIL_CHANNELS, render: renderCodexMail },
};
const dialects: { agent: string; status: AgentStatus; version: string }[] = [
  { agent: "claude", status: CLAUDE, version: "2.1.266" },
  { agent: "codex", status: CODEX, version: "0.153.2" },
  { agent: "codex", status: CODEX, version: "0.146.0" },
];

async function setup(dialect = dialects[0]) {
  let now = 100;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const tracker = createAgentStatusTracker();
  const activity = () => tracker.getSnapshot().panes.get("pane");
  const manager = createMailManager({
    activityOf: activity, subscribeActivity: tracker.subscribe,
    subscribeChannels: () => () => {}, wake: () => false,
    asksAtTurnEnd: () => true, now: () => now, schedule: () => () => {},
  });
  let resolve!: (delivered: boolean) => void;
  let reject!: (error: Error) => void;
  const delivery = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
  const reply = vi.fn<HookReplyDeps["reply"]>(() => delivery);
  const replies = createHookReplies({ mail: () => manager,
    statusFor: () => dialect.status, versionOf: () => dialect.version, reply,
    teamOf: () => null });
  const deck = deckStoreOf([{ id: "pane", agentType: dialect.agent }]);
  const agents: StatusDeclarationsPort = {
    list: () => [{ entry: { id: dialect.agent, status: dialect.status } }],
    subscribe: () => () => {},
  };
  const released = vi.fn();
  let live = true;
  const channel = createAgentStatusChannel(deck, agents, tracker,
    { state: () => ({ kind: live ? "live" : "exited" }), subscribe: () => () => {} },
    createPaneAttribution({ workspaces: () => deck.getSnapshot().workspaces, secretOf: () => "tok" }),
    { subscribe: () => () => {} }, replies.answer, () => released);
  disposers.push(() => { channel.dispose(); manager.dispose(); });
  await Promise.resolve();
  const emit = (name: string, at: number, ask = false, extra: Record<string, unknown> = {}) => {
    now = at;
    ipc.handler!({ paneId: "pane", token: "tok", payload: {
      agent: dialect.agent, ...(ask ? { reply: "correlation" } : {}),
      event: { hook_event_name: name, session_id: "s1", notification_type: "permission_prompt", ...extra },
    } });
  };
  emit("UserPromptSubmit", 100);
  released.mockClear();
  const states: string[] = [];
  tracker.subscribe(() => states.push(activity()?.state ?? "absent"));
  const send = () => manager.send({ from: { paneId: "lead", workspaceId: "ws", label: "Lead" },
    toPaneId: "pane", kind: "task", body: "Check the parser" });
  return { tracker, activity, manager, reply, emit, states, send, resolve, reject,
    released, channel, die: () => { live = false; } };
}

describe("verified status → mail handover → delivered hook reply", () => {
  it.each(dialects)("$agent $version: continuation never announces completion", async (dialect) => {
    const h = await setup(dialect);
    h.send();
    h.emit("Stop", 200, true);
    expect(h.reply).toHaveBeenCalledOnce();
    expect(h.manager.waiting("pane")).toBe(0);
    expect(h.states).toEqual([]);
    expect(h.released).not.toHaveBeenCalled();
    h.resolve(true);
    await flush();
    expect(h.activity()).toEqual({ state: "working", since: 200 });
    expect(h.states).toEqual(["working"]);
    expect(h.released).toHaveBeenCalledOnce();
    h.emit("Stop", 300);
    expect(h.activity()).toEqual({ state: "done", at: 300, interrupted: false });
  });

  it("a codex subagent neither moves the pane nor takes its mail", async () => {
    // Verified live on codex 0.163.0: a subagent's UserPromptSubmit,
    // PermissionRequest and PostToolUse reach the pane's reporter with the
    // root's session id; only agent_id tells them apart.
    const h = await setup(dialects[1]);
    h.emit("PermissionRequest", 150);
    expect(h.activity()?.state).toBe("waiting");
    h.send();
    const child = { agent_id: "019f-child", agent_type: "default" };
    h.emit("UserPromptSubmit", 200, true, child);
    h.emit("PermissionRequest", 210, false, child);
    h.emit("PostToolUse", 220, true, child);
    expect(h.activity()).toMatchObject({ state: "waiting", since: 150 });
    // Each ask is answered — with nothing, so its hook does not wait out a
    // timeout — and the message stays queued.
    const bodies = () => h.reply.mock.calls.map((call) => call[2]);
    expect(bodies()).toEqual(["", ""]);
    expect(h.manager.waiting("pane")).toBe(1);
    // The main agent's own boundary still collects it.
    h.emit("PostToolUse", 230, true);
    expect(bodies()[2]).toContain("Check the parser");
    expect(h.manager.waiting("pane")).toBe(0);
  });

  it("uses the ending preview, not a stale permission wait, for handover", async () => {
    const h = await setup();
    h.emit("Notification", 150);
    h.send();
    h.emit("Stop", 200, true);
    expect(h.manager.waiting("pane")).toBe(0);
    expect(h.activity()?.state).toBe("waiting");
    h.resolve(true);
    await flush();
    expect(h.activity()?.state).toBe("working");
    expect(h.states).not.toContain("done");
  });

  it.each(["lost", "rejected", "empty"])("settles %s delivery without inventing continuation", async (outcome) => {
    const h = await setup();
    if (outcome !== "empty") h.send();
    h.emit("Stop", 200, true);
    if (outcome === "rejected") h.reject(new Error("connection lost"));
    else h.resolve(outcome === "empty");
    await flush();
    expect(h.activity()).toEqual({ state: "done", at: 200, interrupted: false });
    expect(h.manager.waiting("pane")).toBe(outcome === "empty" ? 0 : 1);
    expect(h.released).toHaveBeenCalledOnce();
  });

  it.each(["new-turn", "restart", "dispose", "death"])("ignores an old reply after %s", async (race) => {
    const h = await setup();
    h.send();
    h.emit("Stop", 200, true);
    if (race === "restart") h.tracker.clear("pane");
    if (race === "new-turn" || race === "restart") h.emit("UserPromptSubmit", 300);
    if (race === "dispose") h.channel.dispose();
    if (race === "death") h.die();
    const before = h.tracker.getSnapshot();
    h.resolve(true);
    await flush();
    expect(h.tracker.getSnapshot()).toBe(before);
  });
});
