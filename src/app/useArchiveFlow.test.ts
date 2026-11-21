// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../domain/deck";
import type { IntentOutcome } from "../domain/lifecycle";
import { createWorkspaceInstance, type WorkspaceRef } from "../domain/workspaceInstance";
import type { Intent } from "../ipc/generated/lifecycle/Intent";
import type { Preview } from "../ipc/generated/lifecycle/Preview";
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
const offer = (stops: string[]): Preview => ({ refusal: null, stops, folders: [], creations: [], lastOf: null });

describe("useArchiveFlow", () => {
  let root: Root;
  let flow: ArchiveFlow;
  let deck: Workspace[];
  const preview = vi.fn<(intent: Intent) => Promise<Preview>>();
  const archive = vi.fn<(ref: WorkspaceRef) => Promise<IntentOutcome>>();
  const onRefused = vi.fn();

  function Probe({ workspaces }: { workspaces: Workspace[] }) {
    flow = useArchiveFlow({ workspaces, preview, archive, onRefused });
    return null;
  }
  const render = () => act(() => root.render(createElement(Probe, { workspaces: deck })));
  /** Ask about `wsId`, and let the machine's preview come back. */
  const request = (wsId: string) => act(async () => flow.request(wsId));

  beforeEach(() => {
    preview.mockReset().mockImplementation((intent) => Promise.resolve(offer(intent.kind === "archive" ? [`${intent.workspace}-p`] : [])));
    archive.mockReset().mockResolvedValue({ kind: "accepted", op: 1, minted: { workspace: null, team: null, panes: [] } });
    onRefused.mockReset();
    deck = [ws("ws-1"), ws("ws-2")];
    root = createRoot(document.body.appendChild(document.createElement("div")));
    render();
  });
  afterEach(() => act(() => root.unmount()));

  it("asks first, and archives the exact workspace it asked about only on confirm", async () => {
    await request("ws-1");
    expect(flow.confirming?.title).toBe("Archive “Web”?");
    expect(archive).not.toHaveBeenCalled();

    await act(async () => flow.confirm());
    expect(archive).toHaveBeenCalledWith({ id: "ws-1", instance: deck[0].instance });
    expect(flow.confirming).toBeNull();
  });

  it("opens the confirm on the machine's word: the agents its preview says the archive stops", async () => {
    preview.mockResolvedValue(offer(["a", "b", "c"]));
    await request("ws-1");
    expect(preview).toHaveBeenCalledWith({ kind: "archive", workspace: "ws-1" });
    expect(flow.confirming?.message).toMatch(/^3 agents stop\./);
  });

  it("says at once an archive the machine would not take now, with no confirm", async () => {
    preview.mockResolvedValue({ ...offer([]), refusal: { kind: "alreadyClosing" } });
    await request("ws-1");
    expect(flow.confirming).toBeNull();
    expect(onRefused).toHaveBeenCalledWith("Can't archive this workspace", "“Web” is being closed, so it cannot be archived.");
  });

  it("opens nothing for a preview that comes back after its ask was cancelled or asked again", async () => {
    let answer: (preview: Preview) => void = () => {};
    preview.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    act(() => flow.request("ws-1"));
    act(() => flow.cancel());
    await act(async () => answer(offer(["ws-1-p"])));
    expect(flow.confirming).toBeNull();

    preview.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    act(() => flow.request("ws-1"));
    await request("ws-2");
    await act(async () => answer(offer(["ws-1-p"])));
    expect(flow.confirming?.title).toBe("Archive “Site”?");
  });

  it("cancel archives nothing", async () => {
    await request("ws-1");
    act(() => flow.cancel());
    expect(flow.confirming).toBeNull();
    expect(archive).not.toHaveBeenCalled();
  });

  it("takes its confirm down when the workspace is archived or closed elsewhere meanwhile", async () => {
    await request("ws-1");
    deck = [{ ...deck[0], archived: { at: "2026-11-16T00:00:00.000Z", phase: "archiving" } }, deck[1]];
    render();
    expect(flow.confirming).toBeNull();

    await request("ws-2");
    deck = [deck[0]];
    render();
    expect(flow.confirming).toBeNull();
    act(() => flow.confirm());
    expect(archive).not.toHaveBeenCalled();
  });

  it("never asks about a workspace already archived", async () => {
    deck = [ws("ws-1", { archived: { at: "2026-11-16T00:00:00.000Z", phase: "archived" } })];
    render();
    await request("ws-1");
    expect(flow.confirming).toBeNull();
    expect(preview).not.toHaveBeenCalled();
  });

  it("says why when the archive is refused", async () => {
    archive.mockResolvedValue({ kind: "refused", refusal: { kind: "alreadyClosing" } });
    await request("ws-1");
    await act(async () => flow.confirm());
    expect(onRefused).toHaveBeenCalledWith("Can't archive this workspace", "“Web” is being closed, so it cannot be archived.");
    expect(present(onRefused.mock.calls[0], "the alert")).toHaveLength(2);
  });
});
