// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceForm } from "./WorkspaceForm";
import type { SpawnConfig } from "../../domain/deck";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const worktreeInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Worktree directory"]')!;
const clearBtn = () =>
  document.querySelector<HTMLButtonElement>(".form__field-btn");
const chooseBtn = () =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Choose…",
  )!; // first Choose… = working directory
const createBtn = () =>
  Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent === "Create workspace",
  ) as HTMLButtonElement;

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

describe("WorkspaceForm", () => {
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

  const render = async (
    props: Partial<Parameters<typeof WorkspaceForm>[0]> = {},
    isRepo = false,
  ) =>
    act(async () =>
      root.render(
        createElement(WorkspaceForm, {
          onCreate: (c: SpawnConfig) => created.push(c),
          pickFolder: async () => "/repo",
          inspectDir: async () => ({ isRepo, branch: null }),
          ...props,
        }),
      ),
    );

  /** Mount with a chosen working directory (via the picker, as in the app). */
  const mount = async (isRepo: boolean) => {
    await render({}, isRepo);
    await act(async () => chooseBtn().click());
    await act(async () => {}); // flush the inspectDir probe
  };

  /** One Escape at the window, as `useEscape` hears it. */
  const escape = (): KeyboardEvent => {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    return event;
  };

  it("submits the workspace and nothing per-agent", async () => {
    // The form describes a workspace, which is born EMPTY: an agent type, a
    // YOLO tick or a count here would be a second answer to questions the
    // "+ Agent" dialog owns.
    await mount(false);
    submit();
    expect(created).toEqual([
      { name: "", cwd: "/repo", worktreeBaseDir: null },
    ]);
  });

  it("cannot be submitted before a working directory is chosen", async () => {
    await render();
    expect(createBtn().disabled).toBe(true);
    submit();
    expect(created).toHaveLength(0);
  });

  it("Escape cancels when there is a workspace to return to", async () => {
    const onCancel = vi.fn();
    await render({ onCancel });

    expect(escape().defaultPrevented).toBe(true);
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("Escape is left alone on the first-run form, which has nothing to cancel", async () => {
    await render();

    // No `onCancel` at all on the zero-workspace screen. Claiming the press
    // there swallowed Escape window-wide and dismissed nothing.
    expect(escape().defaultPrevented).toBe(false);
  });

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

  it("treats a whitespace-only path as empty, and asks nothing extra for a git repo", async () => {
    // The isolation question belonged to the batch this form used to spawn.
    // Nothing runs at create time now, so a blank path in a git repo is just a
    // blank path — the "+ Agent" dialog asks where each agent goes, and it can
    // answer for the agent it is actually starting.
    await mount(true);
    type(worktreeInput(), "   ");
    submit();
    expect(created).toEqual([{ name: "", cwd: "/repo", worktreeBaseDir: null }]);
    expect(document.body.textContent).not.toContain("No worktree isolation");
  });

  it("does not expose a setup command field", async () => {
    await mount(false);
    const setupInput = () =>
      document.querySelector('input[aria-label="Worktree setup command"]');
    expect(setupInput()).toBeNull();

    type(worktreeInput(), "/wt");
    expect(setupInput()).toBeNull();
    submit();
    expect(created[0].worktreeBaseDir).toBe("/wt");
  });
});
