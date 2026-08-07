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

  const ticks = () =>
    [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const roleFields = () =>
    [...document.querySelectorAll<HTMLInputElement>(".team__member-role")];
  const submit = () =>
    document.querySelector<HTMLButtonElement>(".form__create")!;

  it("lists every agent in the workspace, none on the team until ticked", () => {
    open(workspace([pane("pane-1"), pane("pane-2")]));
    expect(ticks()).toHaveLength(2);
    expect(ticks().every((box) => !box.checked)).toBe(true);
    expect(roleFields()).toHaveLength(0);
    // Nothing to do is not confirmable: a dialog that dispatches a no-op
    // teaches people it did something.
    expect(submit().disabled).toBe(true);
  });

  it("suggests lead for the first pick and numbers the rest", () => {
    open(workspace([pane("pane-1"), pane("pane-2")]));
    act(() => ticks()[0].click());
    act(() => ticks()[1].click());
    expect(roleFields().map((field) => field.value)).toEqual(["lead", "impl-1"]);
  });

  it("refuses to confirm two members sharing a role, and says which", () => {
    // The question a per-pane surface can never answer, because it never
    // sees the whole roster.
    const ws = workspace([pane("pane-1"), pane("pane-2")]);
    open(ws);
    type(document.querySelector<HTMLInputElement>(".form__input")!, "api");
    act(() => ticks()[0].click());
    act(() => ticks()[1].click());
    type(roleFields()[1], "lead");
    expect(submit().disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("lead");
  });

  it("hands over a settled plan, including who is leaving", () => {
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
    ]);
    open(ws, "api");
    // Opens with both already on, roles filled.
    expect(ticks().every((box) => box.checked)).toBe(true);
    expect(roleFields().map((field) => field.value)).toEqual(["lead", "impl-1"]);
    // Drop the second one.
    act(() => ticks()[1].click());
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

  it("keeps a re-ticked member's own role instead of renaming it", () => {
    const ws = workspace([pane("pane-1", { name: "api", role: "reviewer" })]);
    open(ws, "api");
    act(() => ticks()[0].click());
    act(() => ticks()[0].click());
    expect(roleFields()[0].value).toBe("reviewer");
  });

  it("carries agents to start alongside the ones already here", () => {
    const ws = workspace([pane("pane-1")]);
    open(ws);
    type(document.querySelector<HTMLInputElement>(".form__input")!, "api");
    act(() => ticks()[0].click());
    act(() => document.querySelector<HTMLButtonElement>(".form__dir-btn")!.click());
    const recruitRole = roleFields()[1];
    type(recruitRole, "impl-1");
    act(() => submit().click());
    expect(confirmed[0].recruits).toEqual([{ agentType: "claude", role: "impl-1" }]);
  });

  it("counts a role an unspawned recruit will take as already used", () => {
    // Checking only the live half is how a team ends up with two impl-1s
    // the moment the second one starts.
    const ws = workspace([pane("pane-1")]);
    open(ws);
    type(document.querySelector<HTMLInputElement>(".form__input")!, "api");
    act(() => ticks()[0].click());
    act(() => document.querySelector<HTMLButtonElement>(".form__dir-btn")!.click());
    type(roleFields()[1], "lead");
    expect(submit().disabled).toBe(true);
  });

  it("says when a pane already answers to another team", () => {
    const ws = workspace([pane("pane-1", { name: "web", role: "lead" })]);
    open(ws);
    type(document.querySelector<HTMLInputElement>(".form__input")!, "api");
    expect(document.querySelector(".team__member-note")!.textContent).toContain("web");
    // Once ticked the plan already moves it, so the note would be describing
    // a state the person just changed.
    act(() => ticks()[0].click());
    expect(document.querySelector(".team__member-note")).toBeNull();
  });
});
