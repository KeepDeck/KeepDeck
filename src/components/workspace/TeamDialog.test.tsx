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
    features: [
      { id: "session.new", label: "New sessions" },
      { id: "execution.yolo", label: "YOLO mode" },
    ],
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
          defaultYolo: false,
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
  /** The roster's ADDRESSES, in roster order — `lead`, `impl-1`. What a
   * teammate types, and the column duplicates show up in. */
  const roles = () =>
    all<HTMLElement>(".team__row-address").map((cell) => cell.textContent ?? "");
  /** The roster's role pickers, in roster order. */
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
    expect(roles()).toEqual(["lead", "impl-1"]);
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
    // The second row is offered the Lead the first one already holds; the
    // deck cannot mint a second address for a singleton, so the duplicate
    // stands and is refused in words rather than swallowed by a dead click.
    pickRole(1, "Lead");
    expect(roles()).toEqual(["lead", "lead"]);
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
    expect(roles()).toEqual(["lead", "impl-1"]);
    expect(adds()).toHaveLength(0);
    act(() => drops()[1].click());
    act(() => submit().click());
    expect(confirmed).toEqual([
      {
        name: "api",
        members: [{ paneId: "pane-1", role: "lead" }],
        released: ["pane-2"],
        closing: [],
        recruits: [],
      },
    ]);
  });

  it("can end a team outright, releasing everyone and starting nobody", () => {
    // It was possible before only as a side effect of emptying the roster,
    // which is not a thing anyone would think to try. Ending a team is a
    // deliberate act and has to be sayable.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
      pane("pane-3", { name: "web", role: "lead" }),
    ]);
    open(ws, "api");
    act(() => document.querySelector<HTMLButtonElement>(".team__disband")!.click());
    expect(confirmed).toEqual([
      {
        name: "api",
        members: [],
        released: ["pane-1", "pane-2"],
        // Roles away, agents untouched: they keep running, keep their panes
        // and keep their work. Ending them is the other button's meaning.
        closing: [],
        recruits: [],
      },
    ]);
    // Another team in the same workspace is none of this one's business.
    expect(confirmed[0].released).not.toContain("pane-3");
  });

  it("ends the agents too when that is asked for, and says so on the button", () => {
    // The thing people actually want when a team is over: the four panes go
    // with it, instead of being closed one at a time afterwards. Asked for
    // explicitly, because a destructive act must not be reachable by the
    // same click as an organisational one — and the button says which it is
    // about to do.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
    ]);
    open(ws, "api");
    const disband = () => document.querySelector<HTMLButtonElement>(".team__disband")!;
    expect(disband().textContent).toBe("Disband");
    const tick = document.querySelector<HTMLInputElement>(
      ".team__disband-close input",
    )!;
    // Off when the dialog opens: the destructive reading is chosen again
    // each time, never inherited from the last team somebody ended.
    expect(tick.checked).toBe(false);
    act(() => tick.click());
    expect(disband().textContent).toBe("Disband & close");
    act(() => disband().click());
    expect(confirmed).toEqual([
      {
        name: "api",
        members: [],
        released: ["pane-1", "pane-2"],
        closing: ["pane-1", "pane-2"],
        recruits: [],
      },
    ]);
  });

  it("releases everyone still on the team, not just who the draft kept", () => {
    // Dropping a member and then disbanding must still let that member go:
    // reading the release list off the DRAFT would leave whoever was
    // dropped first wearing a role on a team that no longer exists.
    const ws = workspace([
      pane("pane-1", { name: "api", role: "lead" }),
      pane("pane-2", { name: "api", role: "impl-1" }),
    ]);
    open(ws, "api");
    act(() => drops()[1].click());
    act(() => document.querySelector<HTMLButtonElement>(".team__disband")!.click());
    expect(confirmed[0].released).toEqual(["pane-1", "pane-2"]);
  });

  it("closes on Escape, like every other dialog here", () => {
    let cancelled = 0;
    act(() =>
      root.render(
        createElement(TeamDialog, {
          workspace: workspace([pane("pane-1")]),
          agents: AGENTS,
          editing: null,
          defaultYolo: false,
          onConfirm: (plan: TeamPlan) => confirmed.push(plan),
          onCancel: () => (cancelled += 1),
        }),
      ),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(cancelled).toBe(1);
    // Nothing was applied on the way out — settling the team as one plan is
    // exactly what makes leaving mid-edit free.
    expect(confirmed).toEqual([]);
  });

  it("takes a held Escape as one dismissal", () => {
    // A repeat would pop whatever dialog queued behind this one, which the
    // person never saw.
    let cancelled = 0;
    act(() =>
      root.render(
        createElement(TeamDialog, {
          workspace: workspace([]),
          agents: AGENTS,
          editing: null,
          defaultYolo: false,
          onConfirm: () => {},
          onCancel: () => (cancelled += 1),
        }),
      ),
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", repeat: true }),
      );
    });
    expect(cancelled).toBe(1);
  });

  it("offers no disband for a team that does not exist yet", () => {
    open(workspace([pane("pane-1")]));
    expect(document.querySelector(".team__disband")).toBeNull();
  });

  it("keeps a re-added member's own role instead of renaming it", () => {
    const ws = workspace([pane("pane-1", { name: "api", role: "reviewer-1" })]);
    open(ws, "api");
    act(() => drops()[0].click());
    act(() => adds()[0].click());
    expect(roles()[0]).toBe("reviewer-1");
  });

  it("opens no system popup, and reuses the shared YOLO field for the rest", () => {
    // A native <select> hands the whole menu to the OS in a window that
    // renders every other interaction itself; `Dropdown` exists for that.
    // The YOLO checkbox is NOT the same thing — it is styled in place and
    // is the anatomy every spawn surface shares, so reproducing it here
    // would be the mistake, not reusing it.
    open(workspace([pane("pane-1")]));
    act(() => adds()[0].click());
    act(() => startNew().click());
    expect(document.querySelector("select")).toBeNull();
    expect(document.querySelector(".team__row-agent")).not.toBeNull();
    expect(document.querySelector(".team__row-yolo")).not.toBeNull();
  });

  it("explains YOLO once for the column, not once per row", () => {
    // The full field printed its two-line rationale under every recruit and
    // turned the roster into a wall of warnings.
    open(workspace([]));
    act(() => startNew().click());
    act(() => startNew().click());
    expect(all(".team__row-yolo")).toHaveLength(2);
    expect(all(".team__yolo-note")).toHaveLength(1);
    expect(document.querySelector(".team__yolo-note")!.textContent).toContain(
      "permission prompts",
    );
    // And nothing repeats that sentence inside the rows.
    expect(
      all(".team__row-yolo").every(
        (cell) => !cell.textContent!.includes("permission"),
      ),
    ).toBe(true);
  });

  it("shows an agent still to be started as a member, not as a footnote", () => {
    // It is on the team the moment it is asked for; the only difference
    // from the others is that it does not exist yet.
    open(workspace([pane("pane-1")]));
    type(nameField(), "api");
    act(() => adds()[0].click());
    act(() => startNew().click());
    expect(roles()).toEqual(["lead", "impl-1"]);
    act(() => submit().click());
    expect(confirmed[0].recruits).toEqual([
      { agentType: "claude", role: "impl-1", yolo: false },
    ]);
  });

  it("asks YOLO per recruit and carries each answer into the plan", () => {
    // A lead reading diffs and an implementer grinding through a refactor
    // want different answers; one setting for the whole team would make the
    // safe choice the expensive one.
    open(workspace([]));
    type(nameField(), "api");
    act(() => startNew().click());
    act(() => startNew().click());
    const toggles = all<HTMLInputElement>('.team__row-yolo input[type="checkbox"]');
    expect(toggles).toHaveLength(2);
    expect(toggles.every((box) => !box.checked)).toBe(true);
    act(() => toggles[1].click());
    expect(
      all<HTMLInputElement>('.team__row-yolo input[type="checkbox"]').map((b) => b.checked),
    ).toEqual([false, true]);
    expect(roles()).toEqual(["lead", "impl-1"]);
    act(() => submit().click());
    expect(confirmed[0].recruits.map((recruit) => recruit.yolo)).toEqual([false, true]);
  });

  it("seeds the toggle from the global preference", () => {
    act(() =>
      root.render(
        createElement(TeamDialog, {
          workspace: workspace([]),
          agents: AGENTS,
          editing: null,
          defaultYolo: true,
          onConfirm: (plan: TeamPlan) => confirmed.push(plan),
          onCancel: () => {},
        }),
      ),
    );
    act(() => startNew().click());
    expect(
      document.querySelector<HTMLInputElement>('.team__row-yolo input[type="checkbox"]')!
        .checked,
    ).toBe(true);
  });

  it("counts a role an unstarted agent will take as already used", () => {
    open(workspace([pane("pane-1")]));
    type(nameField(), "api");
    act(() => adds()[0].click());
    act(() => startNew().click());
    pickRole(1, "Lead");
    expect(submit().disabled).toBe(true);
  });

  it("will not take a pooled pane that already answers to another team", () => {
    // A pane holds ONE team, so "adding" one that has a team would not add
    // it — it would pull it out of the other, whose remaining members are
    // still briefed to address a role that then reaches nobody, and who are
    // told nothing, because who left is asked only of the team being edited.
    const ws = workspace([pane("pane-1", { name: "web", role: "lead" })]);
    open(ws);
    type(nameField(), "api");
    // Listed, and where it is said out loud: the agent has not vanished, it
    // is spoken for. Hiding it would send somebody looking for it.
    expect(document.querySelector(".team__row-note")!.textContent).toContain("web");
    expect(adds()).toHaveLength(0);
    expect(roles()).toHaveLength(0);
  });

  it("puts starting an agent ABOVE the pool, since the pool can offer nothing", () => {
    // Every agent here is spoken for by another team, so the pool is a list
    // of rows with no control on them. Below it, the one live way to add a
    // member sat under four dead ones.
    const ws = workspace([
      pane("pane-1", { name: "web", role: "lead" }),
      pane("pane-2", { name: "web", role: "impl-1" }),
    ]);
    open(ws);
    expect(adds()).toHaveLength(0);
    const order = [...document.querySelectorAll(".team__add, .team__pool")];
    expect(order.map((el) => el.className)).toEqual(["team__add", "team__pool"]);
  });

  it("offers a free agent normally, and stops saying where it is once taken", () => {
    const ws = workspace([pane("pane-1")]);
    open(ws);
    type(nameField(), "api");
    expect(document.querySelector(".team__row-note")).toBeNull();
    act(() => adds()[0].click());
    expect(roles()).toEqual(["lead"]);
  });
});
