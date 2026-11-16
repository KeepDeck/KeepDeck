// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RepoCheckout,
  UnheldRemoval,
  UnheldRemovalRequest,
  Workspace,
  WorkspacePatch,
  WorkspaceUpdateResult,
} from "../../domain/deck";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { WorkspacesDialog, type WorkspacesDialogProps } from "./WorkspacesDialog";
import { present } from "@keepdeck/plugin-api/testing";

const ws = (id: string, name: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name,
  cwd: `/Users/me/${name.toLowerCase()}`,
  worktreeBaseDir: null,
  panes: [],
  ...over,
});
const DECK = [
  ws("ws-1", "Web"),
  ws("ws-2", "Blog", { archived: { at: new Date(Date.now() - 3 * 86_400_000).toISOString(), phase: "archived" } }),
];

describe("WorkspacesDialog", () => {
  let root: Root;
  const acts = {
    onFocus: vi.fn(),
    onRestore: vi.fn(),
    onArchive: vi.fn(),
    onCloseWorkspace: vi.fn(),
    onClose: vi.fn(),
    onUpdate: vi.fn<(wsId: string, patch: WorkspacePatch) => WorkspaceUpdateResult>(() => ({ ok: true, workspaces: [] })),
    pickFolder: vi.fn<(title: string) => Promise<string | null>>(() => Promise.resolve("/picked")),
    listWorktrees: vi.fn<(repo: string) => Promise<RepoCheckout[]>>(() => Promise.resolve([])),
    onRemoveWorktree: vi.fn<(request: UnheldRemovalRequest) => Promise<UnheldRemoval>>(() =>
      Promise.resolve({ kind: "removed" }),
    ),
    onNewTeam: vi.fn(),
  };
  const render = (over: Partial<WorkspacesDialogProps> = {}) =>
    act(() =>
      root.render(
        createElement(WorkspacesDialog, { workspaces: DECK, activeId: "ws-1", focus: null, canClose: true, ...acts, ...over }),
      ),
    );
  const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".workspaces__row"));
  const button = (text: string) =>
    present(
      Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text),
      `the "${text}" button`,
    );

  beforeEach(() => {
    for (const fn of Object.values(acts)) fn.mockClear();
    document.body.innerHTML = "";
    root = createRoot(document.body.appendChild(document.createElement("div")));
  });
  afterEach(() => act(() => root.unmount()));

  it("lists every workspace, archived ones under their own heading, and opens a row's page", () => {
    render();
    const groups = Array.from(document.querySelectorAll(".workspaces__group")).map((g) =>
      Array.from(g.children).map((part) => part.textContent),
    );
    expect(groups).toEqual([
      ["Active", "1"],
      ["Archived", "1"],
    ]);
    expect(rows().map((row) => row.querySelector(".workspaces__row-name")?.textContent)).toEqual(["Web", "Blog"]);
    expect(document.querySelector(".workspaces__title h3")?.textContent).toBe("Web");
    // The one on screen: its letters outlined, no words; every row names
    // itself in full on hover.
    expect(rows().map((row) => row.querySelector(".workspaces__tile--active") !== null)).toEqual([true, false]);
    expect(rows()[0].querySelector(".workspaces__row-meta")).toBeNull();
    expect(rows().map((row) => row.title)).toEqual(["Web", "Blog"]);
    act(() => rows()[1].click());
    expect(acts.onFocus).toHaveBeenCalledWith("ws-2");
  });

  it("narrows the list as the search is typed", () => {
    render();
    const search = present(document.querySelector<HTMLInputElement>(".workspaces__search"), "the search field");
    act(() => {
      present(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"), "value").set?.call(search, "blo");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows().map((row) => row.querySelector(".workspaces__row-name")?.textContent)).toEqual(["Blog"]);
  });

  it("offers Restore on an archive's page, and says nobody is woken", () => {
    render({ focus: "ws-2" });
    expect(document.querySelector(".workspaces__banner")?.textContent).toContain("nobody is woken");
    act(() => button("Restore to the strip").click());
    expect(acts.onRestore).toHaveBeenCalledWith("ws-2");
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Archive")).toBe(false);
  });

  it("hands Archive and Close back to the flows that own them", () => {
    render();
    act(() => button("Archive").click());
    expect(acts.onArchive).toHaveBeenCalledWith("ws-1");
    act(() => button("Close workspace").click());
    expect(acts.onCloseWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("renames the workspace when its name field is left", () => {
    render();
    const field = present(document.querySelector<HTMLInputElement>("input[aria-label='Name']"), "the name field");
    act(() => {
      present(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"), "value").set?.call(field, "Web app");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      field.focus();
      field.blur();
    });
    expect(acts.onUpdate).toHaveBeenCalledWith("ws-1", { name: "Web app" });
  });

  it("moves an empty workspace's folder through the picker, and sets or clears its worktree folder", async () => {
    render();
    await act(async () => button("Choose…").click());
    expect(acts.pickFolder).toHaveBeenCalledWith("Choose the workspace's working directory");
    expect(acts.onUpdate).toHaveBeenCalledWith("ws-1", { cwd: "/picked" });

    render({ workspaces: [ws("ws-1", "Web", { worktreeBaseDir: "/wt" }), DECK[1]] });
    act(() => button("Clear").click());
    expect(acts.onUpdate).toHaveBeenCalledWith("ws-1", { worktreeBaseDir: null });
  });

  it("keeps the folder of a workspace that has teams, and says why", () => {
    render({ workspaces: [ws("ws-1", "Web", { teams: [{ id: "t1", name: "api" }] }), DECK[1]] });
    expect(document.querySelector("[aria-label=\"Choose the workspace's working directory\"]")).toBeNull();
    expect(document.body.textContent).toContain("Can be changed only while the workspace has no teams and no agents.");
  });

  it("says why an edit was refused", () => {
    acts.onUpdate.mockReturnValueOnce({ ok: false, refusal: { kind: "unknown-workspace" } });
    render({ workspaces: [ws("ws-1", "Web", { worktreeBaseDir: "/wt" }), DECK[1]] });
    act(() => button("Clear").click());
    expect(document.querySelector("[role='alert']")?.textContent).toBe("This workspace is no longer open.");
  });

  it("shows an archive's fields as they are, and offers no edit", () => {
    render({ focus: "ws-2" });
    expect(present(document.querySelector<HTMLInputElement>("input[aria-label='Name']"), "the name field").readOnly).toBe(true);
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Choose…")).toBe(false);
    expect(document.body.textContent).toContain("restore it to change it");
  });

  it("sets the mark's letters when that field is left, showing the name's letters until then", () => {
    render();
    const field = present(document.querySelector<HTMLInputElement>("input[aria-label='Mark letters']"), "the letters field");
    expect(field.placeholder).toBe("We");
    act(() => {
      present(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"), "value").set?.call(field, "W");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      field.focus();
      field.blur();
    });
    expect(acts.onUpdate).toHaveBeenCalledWith("ws-1", { mark: "W" });
  });

  it("closes on its ✕", () => {
    render();
    act(() => present(document.querySelector<HTMLButtonElement>("[aria-label='Close workspaces']"), "the close button").click());
    expect(acts.onClose).toHaveBeenCalledOnce();
  });
});
