// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDialog } from "./AgentDialog";
import { ROLE_WORDS, roleChoiceView } from "../../presentation/roleChoiceView";
import { forkPickLine } from "../../presentation/sessionResumeView";
import type { AgentDialogResult, AgentDialogTarget, PathProbe, SessionPreset } from "../../domain/agents";
import { roleById } from "../../domain/mail";
import { NO_AGENT_MESSAGE } from "../../domain/deck";
import { agentPickNotice } from "../../presentation/agentPickView";
import { present } from "@keepdeck/plugin-api/testing";

// The same seams the main suite pins: the worktree ipc behind the resume
// gate, the index manager behind the runtime, and one agent in the catalog
// that can start, resume and fork — so a target that HIDES continuations is
// hiding something the agent offers.
const worktreeIpc = vi.hoisted(() => ({
  probeWorktree: vi.fn((_path: string) =>
    Promise.resolve({ exists: true, isWorktree: false, branch: null }),
  ),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);
const sessionIndex = vi.hoisted(() => {
  const snapshot = { scanning: false, revision: 0 };
  return {
    ensureFresh: vi.fn(),
    snapshot: () => snapshot,
    subscribe: () => () => {},
  };
});
vi.mock("../../app/runtimeContext", async () =>
  (await import("../../app/runtimeContext.test-support")).runtimePartsModule({
    sessionIndex,
    directoryProbe: worktreeIpc,
  }));
const CLAUDE = {
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
};
// The catalog the dialog reads — one agent, unless a test empties it.
const catalog = vi.hoisted(() => ({ agents: [] as unknown[], loading: false }));
vi.mock("../../app/useAgents", () => ({
  useAgents: () => catalog,
  resetAgentsCache: () => {},
}));

const MISSING: PathProbe = { exists: false, isWorktree: false, empty: false, branch: null };

const setValue = present(present(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"), "input value property descriptor").set, "input value setter");

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
    root = createRoot(present(document.getElementById("host"), "element \"host\""));
    confirmed = [];
    catalog.agents = [CLAUDE];
    catalog.loading = false;
    defaultAgentType = "claude";
  });
  afterEach(() => act(() => root.unmount()));
  let defaultAgentType: AgentDialogResult["agentType"];

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
          defaultAgentType,
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
      present(document
        .querySelector("form"), "element \"form\"")
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
    act(() => present(rolePicker(), "role picker").click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (button) => button.textContent === label,
    );
    if (!option) throw new Error(`no role option "${label}"`);
    act(() => option.click());
  };
  const roleAddress = () => document.querySelector(".form__role-address")?.textContent ?? null;
  const createBtn = () => present(document.querySelector<HTMLButtonElement>(".form__create"), "element \".form__create\"");

  it("a new team is a name and a directory — no agent, so none of the agent's questions", async () => {
    await mount({ kind: "new-team", suggestedName: "Team 3" }, { cwd: "/repo", branch: "main" });
    expect(text()).toContain("New team");
    expect(present(byLabel("Team name"), "Team name field").value).toBe("Team 3");
    expect(byLabel("Worktree path")).not.toBeNull();
    expect(byLabel("Agent name")).toBeNull();
    expect(text()).not.toContain("Start from");
    expect(text()).not.toContain("YOLO");
    expect(rolePicker()).toBeNull();
    expect(createBtn().textContent).toBe("Create team");

    type(present(byLabel("Team name"), "Team name field"), "  docs ");
    submit();
    expect(confirmed[0]).toMatchObject({ teamName: "docs", location: { kind: "main" } });
    expect("role" in confirmed[0]).toBe(false);
  });

  it("a new team needs no agent: with none installed it is still made, naming none", async () => {
    catalog.agents = [];
    defaultAgentType = null;
    await mount({ kind: "new-team", suggestedName: "Team 3" }, null);
    expect(createBtn().disabled).toBe(false);
    submit();
    expect(confirmed[0]).toMatchObject({ agentType: null, teamName: "Team 3" });
  });

  it("a member with no agent installed says so in place of the list, and cannot be added", async () => {
    catalog.agents = [];
    defaultAgentType = null;
    await mount(member(), null, ["lead"]);
    pickRole(present(roleById("impl"), "roleById \"impl\"").label);
    expect(text()).toContain(NO_AGENT_MESSAGE);
    expect(document.querySelector(".form__agent-pick")).toBeNull();
    expect(createBtn().disabled).toBe(true);
    submit();
    expect(confirmed).toEqual([]);
  });

  it("a member asked for while the catalog loads waits for it, then takes the first agent", async () => {
    catalog.agents = [];
    catalog.loading = true;
    defaultAgentType = null;
    await mount(member(), null, ["lead"]);
    pickRole(present(roleById("impl"), "roleById \"impl\"").label);
    expect(text()).toContain(agentPickNotice(0, true));
    expect(createBtn().disabled).toBe(true);

    catalog.agents = [CLAUDE];
    catalog.loading = false;
    await mount(member(), null, ["lead"]);
    expect(document.querySelector(".form__agent-pick")).not.toBeNull();
    expect(createBtn().disabled).toBe(false);
    submit();
    expect(confirmed[0]).toMatchObject({ agentType: "claude", role: "impl-1" });
  });

  it("a cleared team name falls back to the suggestion rather than an empty team", async () => {
    await mount({ kind: "new-team", suggestedName: "Team 3" }, null);
    type(present(byLabel("Team name"), "Team name field"), "   ");
    submit();
    expect(confirmed[0].teamName).toBe("Team 3");
  });

  const roleOptions = () => {
    act(() => present(rolePicker(), "role picker").click());
    const labels = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((b) => b.textContent);
    act(() => present(rolePicker(), "role picker").click());
    return labels;
  };

  it("a member joins the team named in the title, picks a role, and chooses no location", async () => {
    await mount(member(), null, ["lead"]);
    expect(text()).toContain("New member of “api”");
    expect(byLabel("Team name")).toBeNull();
    expect(byLabel("Worktree path")).toBeNull();
    // Nothing is picked for the person: no address, and nothing to add yet.
    expect(present(rolePicker(), "role picker").textContent).toContain(ROLE_WORDS.prompt);
    expect(roleAddress()).toBeNull();
    expect(createBtn().disabled).toBe(true);
    pickRole(present(roleById("impl"), "roleById \"impl\"").label);
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
    expect(offered).not.toContain(present(roleById("lead"), "roleById \"lead\"").label);
    expect(offered).not.toContain(present(roleById("peer"), "roleById \"peer\"").label);
    pickRole(present(roleById("impl"), "roleById \"impl\"").label);
    expect(roleAddress()).toBe("impl-2");
    expect(createBtn().disabled).toBe(false);
  });

  it("keeps the role on offer for a continuation — a resumed member is a member", async () => {
    await mount(member(), null, ["lead"]);
    const resume = present([...document.querySelectorAll<HTMLButtonElement>(".form__type")].find(
      (button) => button.textContent === "Resume",
    ), "agent type button \"Resume\"");
    act(() => resume.click());
    pickRole(present(roleById("impl"), "roleById \"impl\"").label);
    expect(roleAddress()).toBe("impl-1");
  });

  it("offers a team with nobody on it a lead or a peer, and picks neither", async () => {
    await mount(member(), null, []);
    expect(roleOptions()).toEqual([ROLE_WORDS.prompt, present(roleById("lead"), "roleById \"lead\"").label, present(roleById("peer"), "roleById \"peer\"").label]);
    expect(roleAddress()).toBeNull();
    pickRole(present(roleById("peer"), "roleById \"peer\"").label);
    expect(roleAddress()).toBe("peer-1");
  });

  it("opens on a card's own session, picked to fork — and still asks for the role", async () => {
    const handle = { agent: "claude" as const, sessionId: "s-9", cwd: "/repo/wt", title: "auth bug" };
    await mount(member(), null, ["lead"], { mode: "fork", handle });
    expect(text()).toContain(forkPickLine(handle));
    expect(createBtn().disabled).toBe(true);
    pickRole(present(roleById("impl"), "roleById \"impl\"").label);
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
