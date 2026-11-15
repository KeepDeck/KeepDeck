// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveOutcome, Workspace } from "../domain/deck";
import { createWorkspaceInstance, type WorkspaceRef } from "../domain/workspaceInstance";
import { useArchiveFlow, type ArchiveFlow } from "./useArchiveFlow";
import { present } from "@keepdeck/plugin-api/testing";

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({
  id,
  instance: createWorkspaceInstance(),
  name: id === "ws-1" ? "Web" : "Site",
  cwd: `/${id}`,
  worktreeBaseDir: null,
  panes: [{ id: `${id}-p`, agentType: "claude" }],
  ...over,
});

describe("useArchiveFlow", () => {
  let root: Root;
  let flow: ArchiveFlow;
  let deck: Workspace[];
  const archive = vi.fn<(ref: WorkspaceRef) => Promise<ArchiveOutcome>>();
  const onRefused = vi.fn();

  function Probe({ workspaces }: { workspaces: Workspace[] }) {
    flow = useArchiveFlow({ workspaces, archive, onRefused });
    return null;
  }
  const render = () => act(() => root.render(createElement(Probe, { workspaces: deck })));

  beforeEach(() => {
    archive.mockReset().mockResolvedValue("archived");
    onRefused.mockReset();
    deck = [ws("ws-1"), ws("ws-2")];
    root = createRoot(document.body.appendChild(document.createElement("div")));
    render();
  });
  afterEach(() => act(() => root.unmount()));

  it("asks first, and archives the exact workspace it asked about only on confirm", async () => {
    act(() => flow.request("ws-1"));
    expect(flow.confirming?.title).toBe("Archive “Web”?");
    expect(archive).not.toHaveBeenCalled();

    await act(async () => flow.confirm());
    expect(archive).toHaveBeenCalledWith({ id: "ws-1", instance: deck[0].instance });
    expect(flow.confirming).toBeNull();
  });

  it("cancel archives nothing", () => {
    act(() => flow.request("ws-1"));
    act(() => flow.cancel());
    expect(flow.confirming).toBeNull();
    expect(archive).not.toHaveBeenCalled();
  });

  it("takes its confirm down when the workspace is archived or closed elsewhere meanwhile", () => {
    act(() => flow.request("ws-1"));
    deck = [{ ...deck[0], archived: { at: "2026-11-16T00:00:00.000Z", phase: "archiving" } }, deck[1]];
    render();
    expect(flow.confirming).toBeNull();

    act(() => flow.request("ws-2"));
    deck = [deck[0]];
    render();
    expect(flow.confirming).toBeNull();
    act(() => flow.confirm());
    expect(archive).not.toHaveBeenCalled();
  });

  it("never asks about a workspace already archived", () => {
    deck = [ws("ws-1", { archived: { at: "2026-11-16T00:00:00.000Z", phase: "archived" } })];
    render();
    act(() => flow.request("ws-1"));
    expect(flow.confirming).toBeNull();
  });

  it("says why when the archive is refused", async () => {
    archive.mockResolvedValue("closing");
    act(() => flow.request("ws-1"));
    await act(async () => flow.confirm());
    expect(onRefused).toHaveBeenCalledWith("Can't archive this workspace", "“Web” is being closed, so it cannot be archived.");
    expect(present(onRefused.mock.calls[0], "the alert")).toHaveLength(2);
  });
});
