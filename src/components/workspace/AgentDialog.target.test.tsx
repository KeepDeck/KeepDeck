// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDialog } from "./AgentDialog";
import type { AgentDialogResult, AgentDialogTarget, PathProbe } from "../../domain/agents";
import { roleById } from "../../domain/mail";

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

const member = (cwd: string | null = "/repo/wt"): AgentDialogTarget => ({
  kind: "member",
  teamId: "team-1",
  teamName: "api",
  cwd,
});

describe("AgentDialog targets", () => {
  let root: Root;
  let confirmed: AgentDialogResult[];

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    confirmed = [];
  });
  afterEach(() => act(() => root.unmount()));

  const mount = (
    target: AgentDialogTarget,
    repo: { cwd: string; branch: string | null } | null,
    heldRoles: readonly string[] = [],
  ) =>
    act(async () =>
      root.render(
        createElement(AgentDialog, {
          target,
          heldRoles,
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
  const byLabel = (label: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
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
  const rolePicker = () =>
    document.querySelector<HTMLButtonElement>(".form__role-pick .dropdown__button");
  const pickRole = (label: string) => {
    act(() => rolePicker()!.click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (button) => button.textContent === label,
    );
    if (!option) throw new Error(`no role option "${label}"`);
    act(() => option.click());
  };
  const roleAddress = () => document.querySelector(".form__role-address")?.textContent ?? null;
  const createBtn = () => document.querySelector<HTMLButtonElement>(".form__create")!;

  it("a new team is a name and a directory — no agent, so none of the agent's questions", async () => {
    await mount({ kind: "new-team", suggestedName: "Team 3" }, { cwd: "/repo", branch: "main" });
    expect(text()).toContain("New team");
    expect(byLabel("Team name")!.value).toBe("Team 3");
    expect(byLabel("Worktree path")).not.toBeNull();
    expect(byLabel("Agent name")).toBeNull();
    expect(text()).not.toContain("Start from");
    expect(text()).not.toContain("YOLO");
    expect(rolePicker()).toBeNull();
    expect(createBtn().textContent).toBe("Create team");

    type(byLabel("Team name")!, "  docs ");
    submit();
    expect(confirmed[0]).toMatchObject({ teamName: "docs", location: { kind: "main" } });
    expect("role" in confirmed[0]).toBe(false);
  });

  it("a cleared team name falls back to the suggestion rather than an empty team", async () => {
    await mount({ kind: "new-team", suggestedName: "Team 3" }, null);
    type(byLabel("Team name")!, "   ");
    submit();
    expect(confirmed[0].teamName).toBe("Team 3");
  });

  it("a member joins the team named in the title, picks a role, and chooses no location", async () => {
    await mount(member(), null, ["lead"]);
    expect(text()).toContain("New member of “api”");
    expect(byLabel("Team name")).toBeNull();
    expect(byLabel("Worktree path")).toBeNull();
    // The team has its lead: the picker opens on the next implementer, and
    // the address is minted free of what the roster holds.
    expect(rolePicker()!.textContent).toContain(roleById("impl")!.label);
    expect(roleAddress()).toBe("impl-1");
    // A continuation is on offer — the team's directory is there.
    expect(text()).toContain("Start from");
    expect(createBtn().textContent).toBe("Add member");
    submit();
    expect(confirmed[0]).toMatchObject({ role: "impl-1" });
    expect("teamName" in confirmed[0]).toBe(false);
  });

  it("refuses a singleton the team already holds, in words, and mints past a held address", async () => {
    await mount(member(), null, ["lead", "impl-1"]);
    expect(roleAddress()).toBe("impl-2");
    pickRole(roleById("lead")!.label);
    expect(text()).toContain("already on this team");
    expect(createBtn().disabled).toBe(true);
    pickRole(roleById("impl")!.label);
    expect(roleAddress()).toBe("impl-2");
    expect(createBtn().disabled).toBe(false);
  });

  it("keeps the role on offer for a continuation — a resumed member is a member", async () => {
    await mount(member(), null, ["lead"]);
    const resume = [...document.querySelectorAll<HTMLButtonElement>(".form__type")].find(
      (button) => button.textContent === "Resume",
    )!;
    act(() => resume.click());
    expect(rolePicker()).not.toBeNull();
    expect(roleAddress()).toBe("impl-1");
  });

  it("opens on the lead for a team with nobody on it", async () => {
    await mount(member(), null, []);
    expect(rolePicker()!.textContent).toContain(roleById("lead")!.label);
    expect(roleAddress()).toBe("lead");
  });

  it("offers no continuation while the team's directory is still being created", async () => {
    // Nothing to resume in, nothing to fork into — fresh only, until the
    // create lands.
    await mount(member(null), null, []);
    expect(text()).not.toContain("Start from");
    expect(createBtn().textContent).toBe("Add member");
  });
});
