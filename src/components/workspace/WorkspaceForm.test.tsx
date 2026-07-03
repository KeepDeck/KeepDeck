// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceForm } from "./WorkspaceForm";
import type { SpawnConfig } from "../../domain/workspaces";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The form pulls the agent catalog via useAgents → IPC; pin a static one.
vi.mock("../../ipc/agents", () => ({
  listAgents: async () => [
    {
      id: "claude",
      label: "Claude Code",
      command: "claude",
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
  const mount = async (isRepo: boolean) => {
    await act(async () =>
      root.render(
        createElement(WorkspaceForm, {
          onCreate: (c: SpawnConfig) => created.push(c),
          pickFolder: async () => "/repo",
          inspectDir: async () => ({ isRepo, branch: null }),
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
