// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceForm } from "./WorkspaceForm";
import type { SpawnConfig } from "../../domain/workspaces";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The form pulls the agent catalog via useAgents → IPC; pin a static one
// (two installed agents, so the default-agent preference has a real choice).
vi.mock("../../ipc/agents", () => ({
  listAgents: async () => [
    {
      id: "claude",
      label: "Claude Code",
      command: "claude",
      installed: true,
      path: null,
    },
    {
      id: "codex",
      label: "Codex",
      command: "codex",
      installed: true,
      path: null,
    },
  ],
}));

const worktreeInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Worktree directory"]')!;
const clearBtn = () =>
  document.querySelector<HTMLButtonElement>(".form__field-btn");
const chooseBtn = () =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Choose…",
  )!; // first Choose… = working directory

/** Type into a controlled React input: set via the native setter (bypassing
 * React's value tracker) and fire a bubbling `input` event. */
function type(el: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const submit = () =>
  act(() => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

describe("WorkspaceForm worktree directory", () => {
  let host: HTMLElement;
  let root: Root;
  let created: SpawnConfig[];

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    created = [];
  });
  afterEach(() => act(() => root.unmount()));

  /** Mount with a chosen working directory (via the picker, as in the app). */
  const mount = async (
    isRepo: boolean,
    defaultAgent: SpawnConfig["agentType"] | null = null,
  ) => {
    await act(async () =>
      root.render(
        createElement(WorkspaceForm, {
          onCreate: (c: SpawnConfig) => created.push(c),
          pickFolder: async () => "/repo",
          inspectDir: async () => ({ isRepo, branch: null }),
          defaultAgent,
        }),
      ),
    );
    await act(async () => chooseBtn().click());
    await act(async () => {}); // flush the inspectDir probe
  };

  it("submits worktreeBaseDir: null while the field is empty", async () => {
    await mount(false);
    submit();
    expect(created).toHaveLength(1);
    expect(created[0].worktreeBaseDir).toBeNull();
  });

  it("passes a typed path through trimmed", async () => {
    await mount(false);
    type(worktreeInput(), "  /base/worktrees  ");
    submit();
    expect(created[0].worktreeBaseDir).toBe("/base/worktrees");
  });

  it("clears back to null via the inline ✕", async () => {
    await mount(false);
    type(worktreeInput(), "/base/worktrees");
    expect(clearBtn()).not.toBeNull();

    act(() => clearBtn()!.click());
    expect(worktreeInput().value).toBe("");
    submit();
    expect(created[0].worktreeBaseDir).toBeNull();
  });

  it("treats a whitespace-only path as empty — a git repo still gets the isolation nudge", async () => {
    await mount(true);
    type(worktreeInput(), "   ");
    submit();
    expect(created).toHaveLength(0); // nudge dialog instead of create
    expect(document.body.textContent).toContain("No worktree isolation");
  });
});

describe("WorkspaceForm default agent ([F6])", () => {
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = "";
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
  afterEach(() => act(() => root.unmount()));

  const mount = async (defaultAgent: SpawnConfig["agentType"] | null) => {
    await act(async () =>
      root.render(
        createElement(WorkspaceForm, {
          onCreate: () => {},
          pickFolder: async () => "/repo",
          inspectDir: async () => ({ isRepo: false, branch: null }),
          defaultAgent,
        }),
      ),
    );
    await act(async () => {}); // flush the agent-catalog load
  };

  const typeButton = (label: string) =>
    Array.from(document.querySelectorAll(".form__type")).find(
      (b) => b.textContent === label,
    )!;

  it("preselects the configured default agent", async () => {
    await mount("codex");
    expect(typeButton("Codex").className).toContain("form__type--active");
  });

  it("an uninstalled preference snaps to the first installed", async () => {
    await mount("opencode"); // not in the mocked catalog
    expect(typeButton("Claude Code").className).toContain("form__type--active");
  });

  it("follows a preference change while the picker is untouched", async () => {
    // The settings dialog opens OVER the form (first run: the form is the
    // only screen) — a default set there must reach the mounted form.
    await mount(null);
    expect(typeButton("Claude Code").className).toContain("form__type--active");
    await mount("codex"); // re-render with the new preference
    expect(typeButton("Codex").className).toContain("form__type--active");
  });

  it("a manual pick survives a preference change", async () => {
    await mount(null);
    act(() => (typeButton("Codex") as HTMLButtonElement).click());
    await mount("claude"); // the settings dialog moves the preference
    expect(typeButton("Codex").className).toContain("form__type--active");
  });
});
