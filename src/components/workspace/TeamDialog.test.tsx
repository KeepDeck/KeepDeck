// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentInfo } from "../../domain/agents";
import type { Pane, Workspace } from "../../domain/deck";
import type { TeamPlan } from "../../domain/mail";
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
    features: [{ id: "session.new", label: "New sessions" }],
    installed: true,
    path: "/c",
  },
];

const pane = (id: string, team?: { name: string; role: string }): Pane =>
  ({ id, agentType: "claude", ...(team ? { team } : {}) }) as Pane;

const workspace = (panes: Pane[]): Workspace =>
  ({
    id: "ws-1",
    instance: createWorkspaceInstance(),
    name: "web",
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
  }) as Workspace;

const setValue = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

describe("TeamDialog", () => {
  let root: Root;
  let confirmed: TeamPlan[];

  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
    confirmed = [];
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  const open = (ws: Workspace, editing: string | null = null) =>
    act(() =>
      root.render(
        createElement(TeamDialog, {
          workspace: ws,
          agents: AGENTS,
          editing,
          onConfirm: (plan: TeamPlan) => confirmed.push(plan),
          onCancel: () => {},
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
  /** The pool's "Add" controls — one per agent NOT on the team. */
  const adds = () => all<HTMLButtonElement>(".team__row-take");
  /** The roster's role fields, in roster order. */
  const roles = () => all<HTMLInputElement>(".team__row-role");
  const drops = () => all<HTMLButtonElement>(".team__row-drop");
  const nameField = () => document.querySelector<HTMLInputElement>(".form__input")!;
  const submit = () => document.querySelector<HTMLButtonElement>(".form__create")!;
  const startNew = () => document.querySelector<HTMLButtonElement>(".team__add")!;

  it("starts with an empty team and everyone in the pool", () => {
    open(workspace([pane("pane-1"), pane("pane-2")]));
    // The roster IS the team, so an empty one has no rows at all — nothing
    // to decode, unlike a list of unticked boxes.
    expect(roles()).toHaveLength(0);
    expect(adds()).toHaveLength(2);
    expect(document.body.textContent).toContain("Nobody yet");
    // Nothing to do is not confirmable.
    expect(submit().disabled).toBe(true);
  });

  it("moves an agent out of the pool as it joins the team", () => {
    // Each agent appears exactly once, and WHERE it appears is the answer.
    open(workspace([pane("pane-1"), pane("pane-2")]));
    act(() => adds()[0].click());
    expect(roles()).toHaveLength(1);
    expect(adds()).toHaveLength(1);
    act(() => drops()[0].click());
    expect(roles()).toHaveLength(0);
    expect(adds()).toHaveLength(2);
  });

  it("suggests lead first, then numbers the rest", () => {
    open(workspace([pane("pane-1"), pane("pane-2")]));
    act(() => adds()[0].click());
    act(() => adds()[0].click());
    expect(roles().map((field) => field.value)).toEqual(["lead", "impl-1"]);
  });

  it("does not scold a dialog nobody has touched yet", () => {
    open(workspace([pane("pane-1")]));
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(nameField().value).toBe("");
    // The placeholder must not be mistakable for a value.
    expect(nameField().placeholder.startsWith("e.g.")).toBe(true);
  });

  it("complains only once something has been attempted, and in the refusal style", () => {
    open(workspace([pane("pane-1")]));
    act(() => adds()[0].click());
    const alert = document.querySelector<HTMLElement>('[role="alert"]')!;
    expect(alert.textContent).toContain("name");
    // NOT the git hint's class: that one is green, and a refusal in the
    // colour of a positive result reads as one.
    expect(alert.className).toContain("form__error");
    expect(alert.className).not.toContain("form__git");
  });

  it("tells two identically-titled panes apart", () => {
    // Titles come from the terminal, so several panes legitimately read
    // "Workspace" at once. A row that cannot be told from its neighbour is
    // a row that cannot be used.
    const first = pane("pane-1");
    const second = pane("pane-2");
    (first as { branch?: string }).branch = "kd/api/1";
    (second as { cwd?: string }).cwd = "/repo/worktrees/kd-api-2";
    open(workspace([first, second]));
    expect(all(".team__row-where").map((el) => el.textContent)).toEqual([
      "kd/api/1",
      "kd-api-2",
    ]);
  });

  it("refuses to confirm two members sharing a role, and says which", () => {
    // The question a per-pane surface can never answer, because it never
    // sees the whole roster.
    open(workspace([pane("pane-1"), pane("pane-2")]));
    type(nameField(), "api");
    act(() => adds()[0].click());
    act(() => adds()[0].click());
    type(roles()[1], "lead");
    expect(submit().disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("lead");
  });

  it("hands over a settled plan, including who is leaving", () => {
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
    ]);
    open(ws, "api");
    // Opens with the team already assembled, roles filled, pool empty.
    expect(roles().map((field) => field.value)).toEqual(["lead", "impl-1"]);
    expect(adds()).toHaveLength(0);
    act(() => drops()[1].click());
    act(() => submit().click());
    expect(confirmed).toEqual([
      {
        name: "api",
        members: [{ paneId: "pane-1", role: "lead" }],
        released: ["pane-2"],
        recruits: [],
      },
    ]);
  });

  it("keeps a re-added member's own role instead of renaming it", () => {
    const ws = workspace([pane("pane-1", { name: "api", role: "reviewer" })]);
    open(ws, "api");
    act(() => drops()[0].click());
    act(() => adds()[0].click());
    expect(roles()[0].value).toBe("reviewer");
  });

  it("renders no system control anywhere", () => {
    // The window draws every other interaction itself, so a native select
    // popup — or a system checkbox — is foreign chrome sitting in the
    // middle of it. `Dropdown` exists for exactly this and says so.
    open(workspace([pane("pane-1")]));
    act(() => adds()[0].click());
    act(() => startNew().click());
    expect(document.querySelector("select")).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('input[type="radio"]')).toBeNull();
    // ...and the agent picker is genuinely there, in the app's own form.
    expect(document.querySelector(".team__row-agent")).not.toBeNull();
  });

  it("shows an agent still to be started as a member, not as a footnote", () => {
    // It is on the team the moment it is asked for; the only difference
    // from the others is that it does not exist yet.
    open(workspace([pane("pane-1")]));
    type(nameField(), "api");
    act(() => adds()[0].click());
    act(() => startNew().click());
    expect(roles()).toHaveLength(2);
    type(roles()[1], "impl-1");
    act(() => submit().click());
    expect(confirmed[0].recruits).toEqual([{ agentType: "claude", role: "impl-1" }]);
  });

  it("counts a role an unstarted agent will take as already used", () => {
    open(workspace([pane("pane-1")]));
    type(nameField(), "api");
    act(() => adds()[0].click());
    act(() => startNew().click());
    type(roles()[1], "lead");
    expect(submit().disabled).toBe(true);
  });

  it("says when a pooled pane already answers to another team", () => {
    const ws = workspace([pane("pane-1", { name: "web", role: "lead" })]);
    open(ws);
    type(nameField(), "api");
    expect(document.querySelector(".team__row-note")!.textContent).toContain("web");
    // Once taken, the plan already moves it — the note would describe a
    // state the person just changed.
    act(() => adds()[0].click());
    expect(document.querySelector(".team__row-note")).toBeNull();
  });
});
