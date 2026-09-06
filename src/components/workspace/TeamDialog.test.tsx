// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentInfo } from "../../domain/agents";
import type { Pane, Team, Workspace } from "../../domain/deck";
import { roleById, type TeamPlan } from "../../domain/mail";
import type { PaneActivity } from "../../domain/status";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { TeamDialog } from "./TeamDialog";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS: AgentInfo[] = [
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    features: [
      { id: "session.new", label: "New sessions" },
      { id: "execution.yolo", label: "YOLO mode" },
    ],
    installed: true,
    path: "/c",
  },
];

const api: Team = {
  id: "team-1",
  name: "api",
  location: { kind: "attached", cwd: "/repo/.wt/api", branch: "kd/api" },
};
const web: Team = { id: "team-2", name: "web", location: { kind: "attached", cwd: "/repo/.wt/web" } };

const on = (id: string, teamId: string, role: string): Pane => ({
  id,
  agentType: "claude",
  team: { teamId, role },
});

/** api with pane-1 as lead and pane-2 as impl-1; web with nobody on it. */
const workspace = (panes: Pane[] = [on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "impl-1")]): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: "/repo/.wt",
  teams: [api, web],
  panes,
});

const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

describe("TeamDialog", () => {
  let root: Root;
  let confirmed: TeamPlan[];
  let cancelled: number;

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    confirmed = [];
    cancelled = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const open = (
    ws: Workspace,
    teamId = "team-1",
    activity?: { subscribe(listener: () => void): () => void; of(paneId: string): PaneActivity | undefined },
  ) =>
    act(() =>
      root.render(
        createElement(TeamDialog, {
          workspace: ws,
          agents: AGENTS,
          teamId,
          defaultYolo: false,
          activity,
          onConfirm: (plan: TeamPlan) => {
            confirmed.push(plan);
          },
          onCancel: () => {
            cancelled += 1;
          },
        }),
      ),
    );

  const type = (el: HTMLInputElement, text: string) =>
    act(() => {
      setValue.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

  const all = <T extends HTMLElement>(selector: string) => [
    ...document.querySelectorAll<T>(selector),
  ];
  /** The roster's ADDRESSES, in roster order — `lead`, `impl-1`. What a
   * teammate types, and the column duplicates show up in. */
  const roles = () =>
    all<HTMLElement>(".team__row-address").map((cell) => cell.textContent ?? "");
  const rolePickers = () =>
    all<HTMLButtonElement>(".team__row-role .dropdown__button");
  /** Pick a role for the nth roster row, the way a person does: open the
   * menu, click the option. The address is the deck's to mint from it. */
  const pickRole = (index: number, label: string) => {
    act(() => rolePickers()[index].click());
    const option = all<HTMLButtonElement>('[role="option"]').find(
      (button) => button.textContent === label,
    );
    if (!option) throw new Error(`no role option "${label}"`);
    act(() => option.click());
  };
  const nameField = () => document.querySelector<HTMLInputElement>(".form__input")!;
  const submit = () => document.querySelector<HTMLButtonElement>(".form__create")!;
  const startNew = () => document.querySelector<HTMLButtonElement>(".team__add")!;
  const drops = () => all<HTMLButtonElement>(".team__row-drop");
  const error = () => document.querySelector(".team__error")?.textContent ?? null;

  it("opens on the team's roster — each member under its role — with nothing to save yet", () => {
    open(workspace());
    expect(document.querySelector(".form__title")!.textContent).toBe("Team “api”");
    expect(nameField().value).toBe("api");
    expect(roles()).toEqual(["lead", "impl-1"]);
    // A form confirmed without a change would dispatch a no-op storm and
    // re-brief everyone about it.
    expect(submit().disabled).toBe(true);
    // Nobody is taken off a team here: a member runs where its team runs.
    expect(drops()).toHaveLength(0);
  });

  it("does not scold a dialog nobody has touched yet, and complains once something was attempted", () => {
    open(workspace());
    type(nameField(), "");
    expect(error()).toContain("needs a name");
    expect(submit().disabled).toBe(true);
  });

  it("picks a role and mints its address past the ones held; a swap settles as one plan", () => {
    open(workspace());
    // The lead becomes an implementer: impl-1 is held, so impl-2 is minted —
    // and a team of implementers with no lead is refused in words.
    pickRole(0, roleById("impl")!.label);
    expect(roles()).toEqual(["impl-2", "impl-1"]);
    expect(error()).toContain("lead");
    expect(submit().disabled).toBe(true);
    // The other row takes the lead: the roles have swapped, and the plan
    // carries the whole roster so the deck writes it in one step.
    pickRole(1, roleById("lead")!.label);
    expect(roles()).toEqual(["impl-2", "lead"]);
    expect(error()).toBeNull();
    act(() => submit().click());
    expect(confirmed[0].members).toEqual([
      { paneId: "pane-1", role: "impl-2" },
      { paneId: "pane-2", role: "lead" },
    ]);
  });

  it("hands over a settled plan by team id, the rename included", () => {
    open(workspace());
    type(nameField(), " platform ");
    act(() => submit().click());
    expect(confirmed).toEqual([
      {
        teamId: "team-1",
        name: "platform",
        members: [
          { paneId: "pane-1", role: "lead" },
          { paneId: "pane-2", role: "impl-1" },
        ],
        recruits: [],
      },
    ]);
  });

  it("refuses a rename onto another team's name", () => {
    open(workspace());
    type(nameField(), "WEB");
    expect(error()).toContain("already exists");
    expect(submit().disabled).toBe(true);
  });

  it("starts a new agent ON the team, under a minted address, with its own YOLO answer", () => {
    open(workspace());
    act(() => startNew().click());
    expect(roles()).toEqual(["lead", "impl-1", "impl-2"]);
    // Only an agent that does not exist yet can be dropped from the roster.
    expect(drops()).toHaveLength(1);
    act(() => document.querySelector<HTMLInputElement>(".team__row-yolo input")!.click());
    act(() => submit().click());
    expect(confirmed[0].recruits).toEqual([{ agentType: "claude", role: "impl-2", yolo: true }]);
    expect(confirmed[0].members).toHaveLength(2);
  });

  it("drops a recruit that was not started after all", () => {
    open(workspace());
    act(() => startNew().click());
    act(() => drops()[0].click());
    expect(roles()).toEqual(["lead", "impl-1"]);
    expect(submit().disabled).toBe(true);
  });

  it("quotes a member's briefing in a notice, on demand", () => {
    open(workspace());
    act(() => all<HTMLButtonElement>(".team__row-info")[1].click());
    const notice = document.querySelector("[role='dialog'], .confirm")!;
    expect(notice.textContent).toContain('as "impl-1"');
    expect(notice.textContent).toContain("lead");
  });

  it("marks a member whose role the catalog no longer knows", () => {
    open(workspace([on("pane-1", "team-1", "lead"), on("pane-2", "team-1", "architect")]));
    expect(document.querySelector(".team__row-note")!.textContent).toBe("not in the catalog");
    // The address still works, so the roster keeps it; saving asks for a
    // role the deck knows.
    expect(roles()).toEqual(["lead", "architect"]);
  });

  it("shows each pane's live activity when the deck provides the lane", () => {
    // A STABLE reference per read: the row subscribes through
    // useSyncExternalStore, which re-renders forever on a fresh object.
    const working: PaneActivity = { state: "working", since: 1 };
    const activity = {
      subscribe: () => () => {},
      of: vi.fn((paneId: string) => (paneId === "pane-1" ? working : undefined)),
    };
    open(workspace(), "team-1", activity);
    expect(all(".team__row-activity")).toHaveLength(1);
  });

  it("closes on Escape, like every other dialog here", () => {
    open(workspace());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(cancelled).toBe(1);
  });

  it("closes itself when the team is gone", () => {
    // A disband over MCP under an open dialog: a form over nothing would
    // settle nothing, and closing it says the moment passed.
    open(workspace(), "team-404");
    expect(cancelled).toBe(1);
    expect(document.querySelector(".team-form")).toBeNull();
  });
});
