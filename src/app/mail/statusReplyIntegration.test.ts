import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentContribution, AgentStatus } from "@keepdeck/plugin-api";
import { normalizeClaudeStatus, renderClaudeMail } from "../../../plugins/claude/src/status";
import { normalizeCodexStatus, renderCodexMail } from "../../../plugins/codex/src/status";
import { createAgentStatusTracker } from "../agentStatusTracker";
import { createAgentStatusChannel } from "../agentStatusChannel";
import { createPaneAttribution } from "../paneAttribution";
import type { DeckStore } from "../deckStore";
import type { PaneReportEvent } from "../verifiedPaneReports";
import type { ContributionRegistry } from "../../plugins/registries/contributions";
import { createMailManager } from "./mailManager";
import { createHookReplies } from "./hookReply";

const ipc = vi.hoisted(() => ({ handler: undefined as ((report: PaneReportEvent) => void) | undefined }));
vi.mock("../../ipc/status", () => ({ onAgentStatus: async (fn: typeof ipc.handler) => {
  ipc.handler = fn;
  return () => {};
} }));
vi.mock("../ptyManager", () => ({ paneSessionState: () => ({ kind: "live" }) }));

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const dialects: { agent: string; status: AgentStatus; version: string }[] = [
  { agent: "claude", status: { normalize: normalizeClaudeStatus, renderMail: renderClaudeMail }, version: "2.1.266" },
  { agent: "codex", status: { normalize: normalizeCodexStatus, renderMail: renderCodexMail }, version: "0.153.2" },
  { agent: "codex", status: { normalize: normalizeCodexStatus, renderMail: renderCodexMail }, version: "0.146.0" },
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
  const reply = vi.fn(() => delivery);
  const replies = createHookReplies({ mail: () => manager,
    rendererFor: () => dialect.status.renderMail, versionOf: () => dialect.version, reply });
  const deck = { getSnapshot: () => ({ workspaces: [{ id: "ws", panes: [
    { id: "pane", agentType: dialect.agent },
  ] }] }), subscribe: () => () => {} } as unknown as DeckStore;
  const agents = { list: () => [{ entry: { id: dialect.agent, status: dialect.status } }],
    subscribe: () => () => {} } as unknown as ContributionRegistry<AgentContribution>;
  const released = vi.fn();
  let live = true;
  const channel = createAgentStatusChannel(deck, agents, tracker,
    { state: () => ({ kind: live ? "live" : "exited" }), subscribe: () => () => {} },
    createPaneAttribution({ workspaces: () => deck.getSnapshot().workspaces, secretOf: () => "tok" }),
    { subscribe: () => () => {} }, replies.answer, () => released);
  disposers.push(() => { channel.dispose(); manager.dispose(); });
  await Promise.resolve();
  const emit = (name: string, at: number, ask = false) => {
    now = at;
    ipc.handler!({ paneId: "pane", token: "tok", payload: {
      agent: dialect.agent, ...(ask ? { reply: "correlation" } : {}),
      event: { hook_event_name: name, notification_type: "permission_prompt" },
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
