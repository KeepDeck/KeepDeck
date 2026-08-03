import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import {
  initActivityNotifications,
  initUpdateNotifications,
  notifyAgentCrashed,
  notifyAgentSpawnFailed,
  pluginNotificationSource,
  resetUpdateNotifications,
} from "./notificationProducers";
import { createAgentStatusTracker } from "./agentStatusTracker";
import { normalizeClaudeStatus } from "../../plugins/claude/src/status";

const center = vi.hoisted(() => ({
  notify: vi.fn(),
  retractNotification: vi.fn(),
}));
vi.mock("./notificationCenter", () => center);

const settings = vi.hoisted(() => ({
  enabled: true,
}));
vi.mock("./settingsManager", () => ({
  getSettings: () => ({
    notifications: { enabled: settings.enabled, mode: "system-and-app", mutedPlugins: [] },
  }),
}));

const updates = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    state: { phase: "idle", version: null as string | null },
    subscribeUpdates: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getUpdateState: () => updates.state,
    fire(phase: string, version: string | null) {
      updates.state = { phase, version };
      for (const listener of [...listeners]) listener();
    },
  };
});
vi.mock("./updateManager", () => ({
  subscribeUpdates: updates.subscribeUpdates,
  getUpdateState: updates.getUpdateState,
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

function deckWith(paneName?: string): Workspace[] {
  return [
    {
      id: "ws-1",
      instance: workspaceInstance,
      name: "Alpha",
      cwd: "/repo",
      panes: [
        {
          id: "pane-1",
          agentType: "claude",
          ...(paneName !== undefined ? { name: paneName } : {}),
        },
      ],
    } as unknown as Workspace,
  ];
}

describe("pane producers", () => {
  beforeEach(() => center.notify.mockClear());

  it("crash: titles by the pane's display title, tags by the pane", () => {
    notifyAgentCrashed(deckWith(), "ws-1", "pane-1", 137, agents);
    expect(center.notify).toHaveBeenCalledWith({
      title: "Claude 1 crashed",
      body: "Exit code 137 · Alpha",
      severity: "error",
      source: {
        type: "pane",
        workspace: { id: "ws-1", instance: workspaceInstance },
        paneId: "pane-1",
      },
      tag: "pane:pane-1:crash",
    });
  });

  it("crash: a null code reads as terminated; manual names win the title", () => {
    notifyAgentCrashed(deckWith("builder"), "ws-1", "pane-1", null, agents);
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "builder crashed",
        body: "Terminated · Alpha",
      }),
    );
  });

  it("crash: silent when the pane is already gone", () => {
    notifyAgentCrashed(deckWith(), "ws-1", "missing", 1, agents);
    notifyAgentCrashed([], "ws-1", "pane-1", 1, agents);
    expect(center.notify).not.toHaveBeenCalled();
  });

  it("spawn failure carries the message", () => {
    notifyAgentSpawnFailed(deckWith(), "ws-1", "pane-1", "ENOENT", agents);
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Claude 1 failed to start",
        body: "ENOENT · Alpha",
        tag: "pane:pane-1:spawn",
      }),
    );
  });
});

describe("plugin notification source", () => {
  it("captures the current workspace lifetime", () => {
    expect(
      pluginNotificationSource(
        "git",
        { id: "ws-1", instance: workspaceInstance },
        "changes",
      ),
    ).toEqual({
      type: "plugin",
      pluginId: "git",
      workspace: { id: "ws-1", instance: workspaceInstance },
      dockTab: "changes",
    });
  });

  it("preserves a stale lifetime instead of resolving by reusable id", () => {
    expect(
      pluginNotificationSource("git", {
        id: "ws-1",
        instance: workspaceInstance,
      }),
    ).toEqual({
      type: "plugin",
      pluginId: "git",
      workspace: { id: "ws-1", instance: workspaceInstance },
    });
  });
});

describe("update producer", () => {
  beforeEach(() => {
    center.notify.mockClear();
    settings.enabled = true;
    resetUpdateNotifications();
  });

  it("a version found while notifications are off is announced after re-enabling", () => {
    const stop = initUpdateNotifications();
    settings.enabled = false;
    updates.fire("available", "1.2.3");
    expect(center.notify).not.toHaveBeenCalled();

    // Re-enabled: the version was NOT burned as announced — the next check
    // (periodic or manual) surfaces it.
    settings.enabled = true;
    updates.fire("available", "1.2.3");
    expect(center.notify).toHaveBeenCalledTimes(1);
    stop();
  });

  it("announces a found version once across repeated checks", () => {
    const stop = initUpdateNotifications();
    updates.fire("available", "1.2.3");
    updates.fire("idle", null); // dismissed
    updates.fire("available", "1.2.3"); // 4-hourly re-check finds it again
    expect(center.notify).toHaveBeenCalledTimes(1);
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "KeepDeck 1.2.3 is available",
        source: { type: "app" },
        tag: "app:update",
      }),
    );
    stop();
  });

  it("a newer version is news again", () => {
    const stop = initUpdateNotifications();
    updates.fire("available", "1.2.3");
    updates.fire("available", "1.3.0");
    expect(center.notify).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ignores every other phase", () => {
    const stop = initUpdateNotifications();
    updates.fire("checking", null);
    updates.fire("downloading", "1.2.3");
    expect(center.notify).not.toHaveBeenCalled();
    stop();
  });
});

describe("activity notifications", () => {
  const edgeNormalizer = (payload: unknown) =>
    (payload as { edge?: import("@keepdeck/plugin-api").AgentStatusEvent })
      .edge ?? null;
  let tracker: ReturnType<typeof createAgentStatusTracker>;
  let stop: () => void;

  beforeEach(() => {
    center.notify.mockClear();
    center.retractNotification.mockClear();
    // The factory's whole point: each test builds its own tracker.
    tracker = createAgentStatusTracker();
    tracker.registerNormalizer("claude", edgeNormalizer);
    stop = initActivityNotifications(tracker, () => ({
      workspaces: deckWith(),
      agents,
    }));
  });

  afterEach(() => stop());

  const edge = (e: Record<string, unknown>) =>
    tracker.report("pane-1", { agent: "claude", edge: e });

  it("announces a wait once; a re-assert is silent, a changed question replaces", () => {
    edge({ kind: "waiting", at: 100, reason: "permission" });
    expect(center.notify).toHaveBeenCalledWith({
      title: "Claude 1 — needs approval",
      body: "Alpha",
      severity: "warning",
      source: {
        type: "pane",
        workspace: { id: "ws-1", instance: workspaceInstance },
        paneId: "pane-1",
      },
      tag: "pane:pane-1:activity",
    });
    // Same question again (claude's idle nudge repeats): nothing to say.
    edge({ kind: "waiting", at: 200, reason: "permission" });
    expect(center.notify).toHaveBeenCalledTimes(1);
    // A DIFFERENT question re-announces under the same tag, so the bell's
    // text stops lying about which prompt is up (replace, not stack).
    edge({ kind: "waiting", at: 300, reason: "question" });
    expect(center.notify).toHaveBeenCalledTimes(2);
    expect(center.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Claude 1 — needs your input",
        tag: "pane:pane-1:activity",
      }),
    );
  });

  it("announces a finished turn, but never one the user cut themselves", () => {
    edge({ kind: "turn-start", at: 100 });
    edge({ kind: "turn-end", at: 200 });
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Claude 1 finished",
        body: "Alpha",
        tag: "pane:pane-1:activity",
      }),
    );

    center.notify.mockClear();
    edge({ kind: "turn-start", at: 300 });
    edge({ kind: "interrupted", at: 400 });
    expect(center.notify).not.toHaveBeenCalled();
  });

  it("a done with no running turn behind it announces nothing", () => {
    edge({ kind: "turn-end", at: 100 });
    expect(center.notify).not.toHaveBeenCalled();
  });

  it("retracts an answered wait — resumed turn or the user's own interrupt", () => {
    edge({ kind: "waiting", at: 100, reason: "permission" });
    expect(center.notify).toHaveBeenCalledTimes(1);
    edge({ kind: "resumed", at: 200 });
    expect(center.retractNotification).toHaveBeenCalledWith(
      "pane:pane-1:activity",
    );
    // Answering announced nothing new.
    expect(center.notify).toHaveBeenCalledTimes(1);

    center.retractNotification.mockClear();
    edge({ kind: "waiting", at: 300, reason: "question" });
    edge({ kind: "interrupted", at: 400 });
    expect(center.retractNotification).toHaveBeenCalledWith(
      "pane:pane-1:activity",
    );
  });

  it("a pane leaving the store withdraws its standing wait — and only a wait", () => {
    edge({ kind: "waiting", at: 100, reason: "permission" });
    expect(center.notify).toHaveBeenCalledTimes(1);
    // The pane's process retires (suspend/close/crash): its activity is
    // cleared, and the standing "needs approval" must go with it.
    tracker.clear("pane-1");
    expect(center.retractNotification).toHaveBeenCalledWith(
      "pane:pane-1:activity",
    );

    // A finished pane's entry is history — history may stand.
    center.retractNotification.mockClear();
    edge({ kind: "turn-start", at: 200 });
    edge({ kind: "turn-end", at: 300 });
    tracker.clear("pane-1");
    expect(center.retractNotification).not.toHaveBeenCalled();
  });

  it("retention sweeps withdraw waits the same way a clear does", () => {
    edge({ kind: "waiting", at: 100, reason: "permission" });
    tracker.retain(new Set(["some-other-pane"]));
    expect(center.retractNotification).toHaveBeenCalledWith(
      "pane:pane-1:activity",
    );
  });

  it("a wait that ends in an announcement replaces, never retracts", () => {
    edge({ kind: "waiting", at: 100, reason: "permission" });
    edge({ kind: "turn-end", at: 200 });
    expect(center.retractNotification).not.toHaveBeenCalled();
    expect(center.notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: "Claude 1 finished",
        tag: "pane:pane-1:activity",
      }),
    );
  });

  it("announces a failed turn with its prose", () => {
    edge({ kind: "turn-start", at: 100 });
    center.notify.mockClear();
    edge({
      kind: "turn-failed",
      at: 200,
      error: "rate_limit",
      detail: "Weekly limit reached",
    });
    expect(center.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Claude 1 — rate limited",
        body: "Weekly limit reached · Alpha",
        severity: "error",
      }),
    );
  });

  it("stays silent for a pane the deck no longer names", () => {
    stop();
    stop = initActivityNotifications(tracker, () => ({
      workspaces: [],
      agents,
    }));
    edge({ kind: "waiting", at: 100, reason: "permission" });
    expect(center.notify).not.toHaveBeenCalled();
  });
});

/**
 * The whole claude lane end to end — the REAL normalizer driving the real
 * tracker and the real announce table, the way `usageManager.test.ts` drives
 * `normalizeClaudeStatusline`. The unit tests either side of the seam prove
 * their own rules; only a replayed trace proves the rules COMPOSE, and this
 * one is the trace a background agent actually produces (captured from claude
 * 2.1.220 with every hook dumped to disk).
 */
describe("claude background agents, replayed end to end", () => {
  let tracker: ReturnType<typeof createAgentStatusTracker>;
  let stop: () => void;

  beforeEach(() => {
    center.notify.mockClear();
    center.retractNotification.mockClear();
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

    // Esc pushes no hook — the edge comes from the transcript tailer, which
    // polls, so it is stamped with the MARKER's own time rather than
    // receipt. Parking makes the phase arbitrarily long, so this is the
    // stale-marker surface the guard has to hold open across.
    tracker.report(
      "pane-1",
      { agent: "claude", kind: "session.interrupt", sourceMtimeMs: 300 },
      350,
    );
    expect(activity()).toEqual({ state: "done", at: 300, interrupted: true });
    // The user's own hand — nothing to announce.
    expect(center.notify).not.toHaveBeenCalled();
  });
});
