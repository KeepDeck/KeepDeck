// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../domain/deck";
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
    const labels = Array.from(document.querySelectorAll(".workspaces__group")).map((g) => g.textContent);
    expect(labels).toEqual(["In the strip · 1", "Archived · 1"]);
    expect(rows().map((row) => row.querySelector(".workspaces__row-name")?.textContent)).toEqual(["Web", "Blog"]);
    expect(document.querySelector(".workspaces__title h3")?.textContent).toBe("Web");
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
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent === "Archive…")).toBe(false);
  });

  it("hands Archive and Close back to the flows that own them", () => {
    render();
    act(() => button("Archive…").click());
    expect(acts.onArchive).toHaveBeenCalledWith("ws-1");
    act(() => button("Close workspace…").click());
    expect(acts.onCloseWorkspace).toHaveBeenCalledWith("ws-1");
  });

  it("closes on its ✕", () => {
    render();
    act(() => present(document.querySelector<HTMLButtonElement>("[aria-label='Close workspaces']"), "the close button").click());
    expect(acts.onClose).toHaveBeenCalledOnce();
  });
});
