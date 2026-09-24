// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDialog } from "./AgentDialog";
import { ROLE_WORDS, roleChoiceView } from "../../presentation/roleChoiceView";
import { forkPickLine } from "../../presentation/sessionResumeView";
import type { AgentDialogResult, AgentDialogTarget, PathProbe, SessionPreset } from "../../domain/agents";
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
    preset?: SessionPreset,
  ) =>
    act(async () =>
      root.render(
        createElement(AgentDialog, {
          target,
          ...(preset && { preset }),
          roles: roleChoiceView(heldRoles),
          defaultAgentType: "claude" as const,
          remoteEnabled: false,
          defaultYolo: false,
          repo,
          suggestedPath: "",
          suggestedBranch: "",
          probePath: async () => MISSING,
          listBranches: async () => [],
          branchForPath: async () => null,
          directoryAt: () => "free" as const,
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

  const roleOptions = () => {
    act(() => rolePicker()!.click());
    const labels = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((b) => b.textContent);
    act(() => rolePicker()!.click());
    return labels;
  };

  it("a member joins the team named in the title, picks a role, and chooses no location", async () => {
    await mount(member(), null, ["lead"]);
    expect(text()).toContain("New member of “api”");
    expect(byLabel("Team name")).toBeNull();
    expect(byLabel("Worktree path")).toBeNull();
    // Nothing is picked for the person: no address, and nothing to add yet.
    expect(rolePicker()!.textContent).toContain(ROLE_WORDS.prompt);
    expect(roleAddress()).toBeNull();
    expect(createBtn().disabled).toBe(true);
    pickRole(roleById("impl")!.label);
    // The address is minted free of what the roster holds, said as what it
    // is — a bare "impl-1" beside "Implementer" read as a duplicate.
    expect(text()).toContain("Teammates write to impl-1");
    // A continuation is on offer — the team's directory is there.
    expect(text()).toContain("Start from");
    expect(createBtn().textContent).toBe("Add member");
    submit();
    expect(confirmed[0]).toMatchObject({ role: "impl-1" });
    expect("teamName" in confirmed[0]).toBe(false);
  });

  it("offers a led team its working roles — never a second lead, never a peer — past the held addresses", async () => {
    await mount(member(), null, ["lead", "impl-1"]);
    const offered = roleOptions();
    expect(offered).not.toContain(roleById("lead")!.label);
    expect(offered).not.toContain(roleById("peer")!.label);
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
    pickRole(roleById("impl")!.label);
    expect(roleAddress()).toBe("impl-1");
  });

  it("offers a team with nobody on it a lead or a peer, and picks neither", async () => {
    await mount(member(), null, []);
    expect(roleOptions()).toEqual([ROLE_WORDS.prompt, roleById("lead")!.label, roleById("peer")!.label]);
    expect(roleAddress()).toBeNull();
    pickRole(roleById("peer")!.label);
    expect(roleAddress()).toBe("peer-1");
  });

  it("opens on a card's own session, picked to fork — and still asks for the role", async () => {
    const handle = { agent: "claude" as const, sessionId: "s-9", cwd: "/repo/wt", title: "auth bug" };
    await mount(member(), null, ["lead"], { mode: "fork", handle });
    expect(text()).toContain(forkPickLine(handle));
    expect(createBtn().disabled).toBe(true);
    pickRole(roleById("impl")!.label);
    submit();
    expect(confirmed[0]).toMatchObject({ role: "impl-1", session: { mode: "fork", handle } });
  });

  it("offers no continuation while the team's directory is still being created", async () => {
    // Nothing to resume in, nothing to fork into — fresh only, until the
    // create lands.
    await mount(member(null), null, []);
    expect(text()).not.toContain("Start from");
    expect(createBtn().textContent).toBe("Add member");
  });
});
