// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_SPAWN_CONTEXT } from "../domain/agents";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Deck } from "./useDeck";
import { useDeck } from "./useDeck";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const plans = vi.hoisted(() => {
  type Spec = {
    args: string[];
    env: [string, string][];
    token?: string;
    resumeOf?: string;
    resumeOrigin?: "restore" | "manual";
    postbackMark?: number;
  };
  const specs = new Map<string, Spec>();
  return {
    specs,
    buildResumeSpec: vi.fn(
      async (
        _plugins: unknown,
        _agentType: string,
        facts: { paneId: string },
        _ctx: unknown,
        resumeId: string,
        origin: "restore" | "manual",
      ) => {
        specs.set(facts.paneId, {
          args: ["resume", resumeId],
          env: [],
          token: `token-${origin}`,
          resumeOf: resumeId,
          resumeOrigin: origin,
          postbackMark: 0,
        });
        return true;
      },
    ),
    dropPaneSpawnSpec: vi.fn((paneId: string) => specs.delete(paneId)),
    peekPaneSpawnSpec: (paneId: string) => specs.get(paneId),
    resumeDiedSilently: (spec: Spec | undefined, count: number) =>
      spec?.resumeOrigin === "restore" &&
      !!spec.resumeOf &&
      spec.postbackMark === count,
  };
});
vi.mock("./spawnSpecs", () => plans);
vi.mock("./runtimeContext", () => ({
  useAppRuntime: () => ({ plugins: {} }),
}));

const pty = vi.hoisted(() => ({
  closePane: vi.fn<(paneId: string) => Promise<void>>(() => Promise.resolve()),
}));
vi.mock("./ptyManager", () => pty);

const postbacks = vi.hoisted(() => ({ postbackCount: vi.fn(() => 0) }));
vi.mock("./postbacks", () => postbacks);

vi.mock("../ipc/log", () => ({
  log: { info: vi.fn(), warn: vi.fn() },
  describeError: (error: unknown) => String(error),
}));

import { useAgentRestart, type AgentRestartApi } from "./useAgentRestart";

let deck: Deck;
let restart: AgentRestartApi;
const ctx = { ...EMPTY_SPAWN_CONTEXT, bridgeDir: "/bridge/run-1" };

function Probe() {
  deck = useDeck();
  restart = useAgentRestart(deck, ctx);
  return null;
}

function seed(sessionId: string | null = "session-old") {
  act(() => {
    deck.createWorkspace({
      id: "ws-1",
      instance: createWorkspaceInstance(),
      name: "ws",
      cwd: "/repo",
      worktreeBaseDir: null,
      panes: [
        {
          id: "pane-1",
          agentType: "codex",
          cwd: "/worktree",
          branch: "feature/restart",
          yolo: true,
          ...(sessionId
            ? { session: { id: sessionId, boundAt: "2026-07-11T00:00:00Z" } }
            : {}),
        },
      ],
    });
  });
}

const pane = () => deck.workspaces[0].panes[0];

describe("useAgentRestart", () => {
  let root: Root;

  beforeEach(() => {
    plans.specs.clear();
    plans.buildResumeSpec.mockClear();
    plans.dropPaneSpawnSpec.mockClear();
    pty.closePane.mockReset().mockResolvedValue(undefined);
    postbacks.postbackCount.mockReset().mockReturnValue(0);
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    act(() => root.render(createElement(Probe)));
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it("manually resumes the exact binding with a new plan and keeps pane facts", async () => {
    seed();

    await act(async () => restart.restart("ws-1", "pane-1", "resume"));

    expect(plans.buildResumeSpec).toHaveBeenCalledWith(
      expect.anything(),
      "codex",
      {
        paneId: "pane-1",
        wsId: "ws-1",
        cwd: "/worktree",
        branch: "feature/restart",
        yolo: true,
      },
      ctx,
      "session-old",
      "manual",
    );
    expect(pty.closePane).toHaveBeenCalledWith("pane-1");
    expect(restart.epochs.get("pane-1")).toBe(1);
    expect(pane()).toMatchObject({
      cwd: "/worktree",
      branch: "feature/restart",
      session: { id: "session-old" },
    });
  });

  it("starts fresh only on click, clearing the binding but keeping the worktree", async () => {
    seed();

    await act(async () => restart.restart("ws-1", "pane-1", "fresh"));

    expect(plans.buildResumeSpec).not.toHaveBeenCalled();
    expect(pty.closePane).toHaveBeenCalledOnce();
    expect(pane()).toMatchObject({
      cwd: "/worktree",
      branch: "feature/restart",
    });
    expect(pane().session).toBeUndefined();
    expect(restart.epochs.get("pane-1")).toBe(1);
  });

  it("falls back to fresh safely when resume was requested without a binding", async () => {
    seed(null);

    await act(async () => restart.restart("ws-1", "pane-1", "resume"));

    expect(plans.buildResumeSpec).not.toHaveBeenCalled();
    expect(pty.closePane).toHaveBeenCalledOnce();
    expect(restart.epochs.get("pane-1")).toBe(1);
  });

  it("coalesces repeated clicks while one restart is in flight", async () => {
    seed();
    let release!: () => void;
    pty.closePane.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    let first!: Promise<void>;
    act(() => {
      first = restart.restart("ws-1", "pane-1", "fresh");
      void restart.restart("ws-1", "pane-1", "fresh");
    });
    expect(pty.closePane).toHaveBeenCalledOnce();
    await act(async () => {
      release();
      await first;
    });
    expect(restart.epochs.get("pane-1")).toBe(1);
  });

  it("does not resurrect a pane closed while its resume plan is building", async () => {
    seed();
    let release!: () => void;
    plans.buildResumeSpec.mockImplementationOnce(
      async (_plugins, _agent, facts, _ctx, resumeId) => {
        await new Promise<void>((resolve) => (release = resolve));
        plans.specs.set(facts.paneId, {
          args: ["resume", resumeId],
          env: [],
          resumeOf: resumeId,
          resumeOrigin: "manual",
          postbackMark: 0,
        });
        return true;
      },
    );

    let pending!: Promise<void>;
    act(() => {
      pending = restart.restart("ws-1", "pane-1", "resume");
    });
    act(() => deck.closeAgent("ws-1", "pane-1"));
    await act(async () => {
      release();
      await pending;
    });

    expect(pty.closePane).not.toHaveBeenCalled();
    expect(plans.specs.has("pane-1")).toBe(false);
    expect(restart.epochs.has("pane-1")).toBe(false);
  });

  it("keeps the pane exited when a manual resume plan cannot be prepared", async () => {
    seed();
    plans.buildResumeSpec.mockImplementationOnce(async () => false);

    await expect(
      act(async () => restart.restart("ws-1", "pane-1", "resume")),
    ).rejects.toThrow("could not prepare a resume plan");

    expect(pty.closePane).not.toHaveBeenCalled();
    expect(restart.epochs.has("pane-1")).toBe(false);
    expect(pane().session?.id).toBe("session-old");
  });

  it("auto-recovers a rejected restore resume exactly once", async () => {
    seed();
    plans.specs.set("pane-1", {
      args: ["resume", "session-old"],
      env: [],
      resumeOf: "session-old",
      resumeOrigin: "restore",
      postbackMark: 0,
    });

    act(() => restart.recoverRejectedResume("ws-1", "pane-1", 1));
    await act(async () => {});

    expect(pty.closePane).toHaveBeenCalledOnce();
    expect(pane().session).toBeUndefined();
    expect(restart.epochs.get("pane-1")).toBe(1);
    restart.recoverRejectedResume("ws-1", "pane-1", 1);
    expect(pty.closePane).toHaveBeenCalledOnce();
  });

  it("never auto-recovers an ordinary exit or a rejected manual resume", () => {
    seed();
    plans.specs.set("pane-1", {
      args: ["resume", "session-old"],
      env: [],
      resumeOf: "session-old",
      resumeOrigin: "manual",
      postbackMark: 0,
    });

    act(() => restart.recoverRejectedResume("ws-1", "pane-1", 1));
    expect(pty.closePane).not.toHaveBeenCalled();
    expect(restart.epochs.has("pane-1")).toBe(false);
    expect(pane().session?.id).toBe("session-old");
  });
});
