import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/domain/deck";
import { createWorkspaceInstance } from "../src/domain/workspaceInstance";
import { initActivityNotifications } from "../src/app/notificationProducers";
import { createAgentStatusTracker } from "../src/app/agentStatusTracker";
import { normalizeClaudeStatus } from "../plugins/claude/src/status";

const center = vi.hoisted(() => ({
  notify: vi.fn(),
}));
vi.mock("../src/app/notificationCenter", () => center);
vi.mock("../src/app/settingsManager", () => ({
  getSettings: () => ({
    notifications: { enabled: true, mode: "system-and-app", mutedPlugins: [] },
  }),
}));
vi.mock("../src/app/updateManager", () => ({
  subscribeUpdates: () => () => {},
  getUpdateState: () => ({ phase: "idle", version: null }),
}));

const agents = [
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    features: [],
    installed: true,
    path: null,
  },
];
const workspaceInstance = createWorkspaceInstance();

function deckWith(): Workspace[] {
  return [
    {
      id: "ws-1",
      instance: workspaceInstance,
      name: "Alpha",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [{ id: "pane-1", agentType: "claude" }],
    },
  ];
}

/**
 * The whole claude lane end to end — the REAL normalizer driving the real
 * tracker and the real announce table. The unit tests either side of the
 * seam prove their own rules; only a replayed trace proves the rules COMPOSE, and this
 * one is the trace a background agent actually produces (captured from claude
 * 2.1.220 with every hook dumped to disk).
 */
describe("claude background agents, replayed end to end", () => {
  let tracker: ReturnType<typeof createAgentStatusTracker>;
  let stop: () => void;

  beforeEach(() => {
    center.notify.mockClear();
    tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", normalizeClaudeStatus);
    stop = initActivityNotifications(tracker, () => ({
      workspaces: deckWith(),
      agents,
    }));
  });

  afterEach(() => stop());

  /** One hook payload, wrapped as the shell reporter wraps it. */
  const hook = (event: Record<string, unknown>, at: number) =>
    tracker.report("pane-1", { agent: "claude", event }, at);
  const activity = () => tracker.getSnapshot().panes.get("pane-1");

  const runningSubagent = {
    id: "acb5bea0d1b3101fd",
    type: "subagent",
    status: "running",
    description: "Sleep then report",
    agent_type: "general-purpose",
  };

  it("stays working across the whole background window, and finishes once", () => {
    hook({ hook_event_name: "UserPromptSubmit" }, 100);
    expect(activity()).toEqual({ state: "working", since: 100 });

    // The main thread launches the background agent and replies.
    hook({ hook_event_name: "PostToolUse", tool_name: "Agent" }, 200);
    hook(
      {
        hook_event_name: "Stop",
        last_assistant_message: "LAUNCHED",
        background_tasks: [runningSubagent],
      },
      300,
    );
    // THE REGRESSION: this Stop used to read as "Done" and announce a turn
    // that had not finished. The phase must not restart either — the age is
    // "how long since you could have walked away", and the user could not.
    expect(activity()).toEqual({ state: "working", since: 100 });
    expect(center.notify).not.toHaveBeenCalled();

    // The subagent's OWN tool calls reach the armed hook (they carry
    // `agent_id`); they must not disturb the pane either way.
    hook({ hook_event_name: "PostToolUse", agent_id: runningSubagent.id }, 400);
    hook({ hook_event_name: "PostToolUse", agent_id: runningSubagent.id }, 500);
    expect(activity()).toEqual({ state: "working", since: 100 });

    // The finished background work wakes the session — a machine-injected
    // turn, indistinguishable from a typed one at the hook.
    hook({ hook_event_name: "UserPromptSubmit" }, 600);
    expect(activity()).toEqual({ state: "working", since: 600 });

    // Only now, with nothing left in flight, is the turn over.
    hook({ hook_event_name: "Stop", background_tasks: [] }, 700);
    expect(activity()).toEqual({ state: "done", at: 700, interrupted: false });
    expect(center.notify).toHaveBeenCalledTimes(1);
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Claude 1 finished" }),
    );
  });

  it("a question raised inside the background window reaches the user", () => {
    hook({ hook_event_name: "UserPromptSubmit" }, 100);
    hook({ hook_event_name: "Stop", background_tasks: [runningSubagent] }, 200);
    expect(center.notify).not.toHaveBeenCalled();

    // The window runs for minutes, and a background agent that needs
    // approval has a dialog UP that the user can answer — the banner's job
    // is to send them to look. Suppressing it was tried and strands the very
    // work the parking protects, because nothing else can end the window.
    hook(
      { hook_event_name: "Notification", notification_type: "permission_prompt" },
      300,
    );
    expect(activity()).toEqual({
      state: "waiting",
      since: 300,
      reason: "permission",
    });
    expect(center.notify).toHaveBeenCalledTimes(1);
    expect(center.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Claude 1 — needs approval" }),
    );

    // A re-assert of the SAME question is absorbed — the reducer keeps the
    // phase and its identity, so a repeating nudge never re-announces.
    hook(
      { hook_event_name: "Notification", notification_type: "permission_prompt" },
      306,
    );
    expect(center.notify).toHaveBeenCalledTimes(1);
  });

  it("a backgrounded shell task alone does not hold the turn open", () => {
    // The user parked it deliberately and nothing wakes the session when it
    // ends. Parking on it made one `npm run dev` swallow every later
    // "finished" for the rest of the session.
    hook({ hook_event_name: "UserPromptSubmit" }, 100);
    hook(
      {
        hook_event_name: "Stop",
        background_tasks: [
          { id: "s1", type: "shell", status: "running", command: "npm run dev" },
        ],
      },
      200,
    );
    expect(activity()).toEqual({ state: "done", at: 200, interrupted: false });
    expect(center.notify).toHaveBeenCalledTimes(1);
    expect(center.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Claude 1 finished" }),
    );
  });

  it("a failed turn stands against the background noise that follows it", () => {
    hook({ hook_event_name: "UserPromptSubmit" }, 100);
    hook(
      {
        hook_event_name: "StopFailure",
        error: "rate_limit",
        background_tasks: [runningSubagent],
      },
      200,
    );
    const failed = { state: "failed", at: 200, error: "rate_limit" };
    expect(activity()).toEqual(failed);

    // Surviving agents keep reporting; none of it un-fails the turn.
    center.notify.mockClear();
    hook({ hook_event_name: "PostToolUse", agent_id: runningSubagent.id }, 300);
    hook({ hook_event_name: "Stop", background_tasks: [runningSubagent] }, 400);
    hook(
      { hook_event_name: "Notification", notification_type: "agent_needs_input" },
      500,
    );
    expect(activity()).toEqual(failed);
    expect(center.notify).not.toHaveBeenCalled();
  });

  it("an interrupt during the background window ends the turn honestly", () => {
    hook({ hook_event_name: "UserPromptSubmit" }, 100);
    hook({ hook_event_name: "Stop", background_tasks: [runningSubagent] }, 200);
    expect(activity()).toEqual({ state: "working", since: 100 });

    // Esc pushes no hook — the edge comes out of the transcript, carried by
    // the record claude's own dialect asked for and read by that dialect. It
    // is stamped with the RECORD's time rather than receipt, because the
    // tail polls. Parking makes the phase arbitrarily long, so this is the
    // stale-marker surface the guard has to hold open across.
    tracker.report(
      "pane-1",
      {
        agent: "claude",
        kind: "store.record",
        record: {
          type: "user",
          interruptedMessageId: "msg_1",
          timestamp: new Date(300).toISOString(),
        },
      },
      350,
    );
    expect(activity()).toEqual({ state: "done", at: 300, interrupted: true });
    // The user's own hand — nothing to announce.
    expect(center.notify).not.toHaveBeenCalled();
  });
});
