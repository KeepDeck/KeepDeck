// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDialog } from "./AgentDialog";
import type { AgentDialogResult, AgentDialogTarget, PathProbe } from "../../domain/agents";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The same seams the main suite pins: the worktree ipc behind the resume
// gate, the index manager behind the runtime, and one agent in the catalog
// that can start, resume and fork — so a target that HIDES continuations is
// hiding something the agent offers.
vi.mock("../../ipc/worktree", () => ({
  probeWorktree: vi.fn((_path: string) =>
    Promise.resolve({ exists: true, isWorktree: false, branch: null }),
  ),
}));
const sessionIndex = vi.hoisted(() => {
  const snapshot = { scanning: false, revision: 0 };
  return {
    ensureFresh: vi.fn(),
    snapshot: () => snapshot,
    subscribe: () => () => {},
  };
});
vi.mock("../../app/runtimeContext", () => ({
  useAppRuntime: () => ({ sessionIndex }),
}));
vi.mock("../../app/useAgents", () => ({
  useAgents: () => ({
    agents: [
      {
        id: "claude",
        label: "Claude Code",
        command: "claude",
        features: [
          { id: "session.new", label: "New sessions" },
          { id: "session.resume", label: "Resume" },
          { id: "session.fork", label: "Fork" },
          { id: "session.history", label: "History" },
        ],
        installed: true,
        path: null,
      },
    ],
    loading: false,
  }),
  resetAgentsCache: () => {},
}));

const MISSING: PathProbe = { exists: false, isWorktree: false, empty: false, branch: null };

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

describe("AgentDialog targets", () => {
  let root: Root;
  let confirmed: AgentDialogResult[];

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    confirmed = [];
  });
  afterEach(() => act(() => root.unmount()));

  const mount = (target: AgentDialogTarget, repo: { cwd: string; branch: string | null } | null) =>
    act(async () =>
      root.render(
        createElement(AgentDialog, {
          target,
          defaultAgentType: "claude" as const,
          remoteEnabled: false,
          defaultYolo: false,
          repo,
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => [],
          branchForPath: async () => null,
          occupancyAt: () => null,
          nextFreeLocation: async () => null,
          pickFolder: async () => null,
          searchSessions: async () => ({ rows: [], total: 0 }),
          sessionClaim: () => null,
          liveOutside: async () => ({ ok: true, ids: new Set<string>() }),
          onConfirm: (r: AgentDialogResult) => confirmed.push(r),
          onCancel: () => {},
        }),
      ),
    );

  const text = () => document.body.textContent ?? "";
  const teamNameInput = () =>
    document.querySelector<HTMLInputElement>('input[aria-label="Team name"]');
  const submit = () =>
    act(() => {
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  const type = (el: HTMLInputElement, value: string) =>
    act(() => {
      setValue.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("a new team opens named the way the deck would name it, and the result carries what was typed", async () => {
    await mount({ kind: "new-team", suggestedName: "Team 3" }, { cwd: "/repo", branch: "main" });
    expect(text()).toContain("New team");
    expect(teamNameInput()!.value).toBe("Team 3");
    // The location is the new team's to choose.
    expect(document.querySelector('input[aria-label="Worktree path"]')).not.toBeNull();
    expect(text()).toContain("Start from");

    type(teamNameInput()!, "  docs ");
    submit();
    expect(confirmed[0].teamName).toBe("docs");
    expect(document.querySelector(".form__create")!.textContent).toBe("Create team");
  });

  it("a cleared team name falls back to the suggestion rather than an empty team", async () => {
    await mount({ kind: "new-team", suggestedName: "Team 3" }, null);
    type(teamNameInput()!, "   ");
    submit();
    expect(confirmed[0].teamName).toBe("Team 3");
  });

  it("a member joins the team named in the title, with nothing to choose about where or from what", async () => {
    await mount({ kind: "member", teamId: "team-1", teamName: "api" }, null);
    expect(text()).toContain("New member of “api”");
    expect(teamNameInput()).toBeNull();
    expect(document.querySelector('input[aria-label="Worktree path"]')).toBeNull();
    // A continuation lands where its session was recorded — a team of its
    // own — so it is not offered to a member.
    expect(text()).not.toContain("Start from");
    expect(text()).not.toContain("Resume");
    submit();
    expect(confirmed).toHaveLength(1);
    expect("teamName" in confirmed[0]).toBe(false);
    expect(document.querySelector(".form__create")!.textContent).toBe("Add member");
  });
});
