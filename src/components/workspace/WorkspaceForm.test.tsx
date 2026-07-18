// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceForm } from "./WorkspaceForm";
import {
  initSettings,
  resetSettingsManager,
  updateSettings,
} from "../../app/settingsManager";
import { resetAgentsCache } from "../../app/useAgents";
import type { SpawnConfig } from "../../domain/deck";

// React 19 requires this flag for act() outside a test-framework integration.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// The form pulls the agent catalog via useAgents → IPC; pin a swappable one
// (the default-agent tests vary which agents count as installed).
const agent = (id: string, label: string) => ({
  id,
  label,
  command: id,
  installed: true,
  path: null,
});
const TWO_AGENTS = [agent("claude", "Claude Code"), agent("codex", "Codex")];
const THREE_AGENTS = [...TWO_AGENTS, agent("opencode", "OpenCode")];
const catalog = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock("../../app/useAgents", () => ({
  useAgents: () => ({ agents: catalog.list, loading: false }),
  resetAgentsCache: () => {},
}));

// The form reads the default agent from the settings store ([F6]); run the
// real manager over a mocked IPC so the tests exercise the store→hook bridge.
vi.mock("../../ipc/settings", () => ({
  loadSettings: async () => null,
  saveSettings: async () => {},
  quarantineSettings: async () => {},
}));

/** Boot the settings store and set the default-agent preference. */
async function seedDefaultAgent(defaultAgent: SpawnConfig["agentType"]) {
  resetSettingsManager();
  await initSettings();
  updateSettings({ defaultAgent });
}

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
    resetAgentsCache();
    catalog.list = TWO_AGENTS;
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    created = [];
  });
  afterEach(() => act(() => root.unmount()));

  /** Mount with a chosen working directory (via the picker, as in the app). */
  const mount = async (isRepo: boolean) => {
    await seedDefaultAgent("claude");
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

describe("WorkspaceForm YOLO toggle", () => {
  let root: Root;
  let created: SpawnConfig[];

  beforeEach(() => {
    resetAgentsCache();
    catalog.list = [{ ...agent("claude", "Claude Code"), supportsYolo: true }];
    document.body.innerHTML = "";
    root = createRoot(document.body.appendChild(document.createElement("div")));
    created = [];
  });
  afterEach(() => act(() => root.unmount()));

  const checkbox = () =>
    document.querySelector<HTMLInputElement>(".form__yolo input");

  const mount = async (defaultYolo: boolean) => {
    await seedDefaultAgent("claude");
    updateSettings({ defaultYolo });
    await act(async () =>
      root.render(
        createElement(WorkspaceForm, {
          onCreate: (c: SpawnConfig) => created.push(c),
          pickFolder: async () => "/repo",
          inspectDir: async () => ({ isRepo: false, branch: null }),
        }),
      ),
    );
    await act(async () => chooseBtn().click());
    await act(async () => {}); // flush the probe + catalog load
  };

  it("prefills from the global default; the whole batch carries the choice", async () => {
    await mount(true);
    expect(checkbox()?.checked).toBe(true);
    submit();
    expect(created[0].yolo).toBe(true);
  });

  it("stays sparse when off, and hides entirely without agent support", async () => {
    await mount(false);
    expect(checkbox()?.checked).toBe(false);
    submit();
    expect("yolo" in created[0]).toBe(false);

    catalog.list = TWO_AGENTS; // no supportsYolo anywhere
    await mount(true);
    expect(checkbox()).toBeNull();
    submit();
    // The global default must not leak through a non-supporting agent.
    expect("yolo" in created[1]).toBe(false);
  });
});

describe("WorkspaceForm default agent ([F6])", () => {
  let root: Root;

  beforeEach(() => {
    resetAgentsCache();
    catalog.list = TWO_AGENTS;
    document.body.innerHTML = "";
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
  afterEach(() => act(() => root.unmount()));

  const mount = async (defaultAgent: SpawnConfig["agentType"]) => {
    await seedDefaultAgent(defaultAgent);
    await act(async () =>
      root.render(
        createElement(WorkspaceForm, {
          onCreate: () => {},
          pickFolder: async () => "/repo",
          inspectDir: async () => ({ isRepo: false, branch: null }),
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
    // only screen) — a default set there must reach the mounted form
    // through the store subscription.
    catalog.list = THREE_AGENTS;
    await mount("claude");
    expect(typeButton("Claude Code").className).toContain("form__type--active");
    act(() => updateSettings({ defaultAgent: "opencode" }));
    expect(typeButton("OpenCode").className).toContain("form__type--active");
  });

  it("a manual pick survives a preference change", async () => {
    catalog.list = THREE_AGENTS;
    await mount("claude");
    act(() => (typeButton("Codex") as HTMLButtonElement).click());
    act(() => updateSettings({ defaultAgent: "opencode" })); // the settings dialog moves the preference
    expect(typeButton("Codex").className).toContain("form__type--active");
  });
});

describe("WorkspaceForm setup command", () => {
  let root: Root;
  let created: SpawnConfig[];

  beforeEach(() => {
    resetAgentsCache();
    catalog.list = TWO_AGENTS;
    document.body.innerHTML = "";
    root = createRoot(document.body.appendChild(document.createElement("div")));
    created = [];
  });
  afterEach(() => act(() => root.unmount()));

  const setupInput = () =>
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Worktree setup command"]',
    );

  const mount = async () => {
    await seedDefaultAgent("claude");
    await act(async () =>
      root.render(
        createElement(WorkspaceForm, {
          onCreate: (c: SpawnConfig) => created.push(c),
          pickFolder: async () => "/repo",
          inspectDir: async () => ({ isRepo: false, branch: null }),
        }),
      ),
    );
    await act(async () => chooseBtn().click());
    await act(async () => {});
  };

  it("does not expose a setup command field for new workspaces", async () => {
    await mount();
    expect(setupInput()).toBeNull();

    type(worktreeInput(), "/wt");
    expect(setupInput()).toBeNull();

    submit();
    expect(created[0].setup).toBeUndefined();
    expect(created[0].worktreeBaseDir).toBe("/wt");
  });
});
