// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactChanges } from "../../app/artifacts/changes";
import { artifactsEnableStatus } from "../../app/artifacts/enableStatus";
import type { ArtifactMetaRow } from "../../ipc/artifacts";
import { useArtifactsRegistry, type ArtifactsRegistry } from "./useArtifactsRegistry";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The IPC edge is doubled, NOT `openArtifactByRef`: the ladder from an
// identity to a live url is the thing this surface leans on, so the test
// exercises the real one and doubles only what talks to Rust.
vi.mock("../../ipc/artifacts", () => ({
  artifactList: vi.fn(),
  artifactResolveUrls: vi.fn(),
  artifactDelete: vi.fn(),
}));
vi.mock("../../ipc/app", () => ({ openUrl: vi.fn() }));
vi.mock("../../ipc/clipboard", () => ({ writeText: vi.fn() }));

import { openUrl } from "../../ipc/app";
import {
  artifactDelete,
  artifactList,
  artifactResolveUrls,
} from "../../ipc/artifacts";
import { writeText } from "../../ipc/clipboard";

const listed = vi.mocked(artifactList);
const resolved = vi.mocked(artifactResolveUrls);
const removed = vi.mocked(artifactDelete);
const opened = vi.mocked(openUrl);
const copied = vi.mocked(writeText);

const row = (id: string, over: Partial<ArtifactMetaRow> = {}): ArtifactMetaRow => ({
  id,
  title: `The ${id}`,
  versionCount: 2,
  updatedAt: 1_700_000_000_000,
  lastAuthor: "support 1",
  ...over,
});

let registry: ArtifactsRegistry;
let host: HTMLDivElement;
let root: Root;
let workspaceId: string | null;

function Probe() {
  registry = useArtifactsRegistry(workspaceId);
  return null;
}

const mount = () => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(Probe)));
};

/** Let the pending IPC promises settle into state. */
const settle = () => act(async () => {});

beforeEach(() => {
  workspaceId = "ws-1";
  // The app-wide status is a singleton; a landed enable is the neutral
  // state every case but the contention one starts from.
  artifactsEnableStatus.record({ desired: true, ok: true, detail: null });
  listed.mockReset().mockResolvedValue([row("auth-flow"), row("deck-layout")]);
  resolved
    .mockReset()
    .mockResolvedValue({ url: "http://127.0.0.1:56513/a/tok/auth-flow", indexUrl: "http://127.0.0.1:56513/idx/" });
  opened.mockReset().mockResolvedValue(undefined);
  copied.mockReset().mockResolvedValue(undefined);
  removed.mockReset().mockResolvedValue({
    id: "auth-flow",
    deleted: true,
    versionCount: 2,
    createdAt: 1,
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("useArtifactsRegistry", () => {
  it("holds `null` until the store answers, so loading never reads as empty", async () => {
    mount();
    expect(registry.rows).toBeNull();
    await settle();
    expect(registry.rows?.map((r) => r.id)).toEqual(["auth-flow", "deck-layout"]);
    expect(listed).toHaveBeenCalledWith({ workspaceId: "ws-1" });
  });

  it("renders a refusal as itself, never as a workspace that published nothing", async () => {
    // The store's own sentence — "turn the artifacts experiment on first"
    // — is the only thing that explains an empty screen honestly.
    listed.mockRejectedValueOnce(
      new Error("artifact store is off — turn the artifacts experiment on first"),
    );
    mount();
    await settle();
    expect(registry.error).toBe(
      "artifact store is off — turn the artifacts experiment on first",
    );
    expect(registry.rows).toEqual([]);
  });

  it("blames the failed enable, not the user's setting, when the store never opened", async () => {
    // The bug this exists for: the experiment is ON, another KeepDeck
    // owns the claim, and the only sentence the store has is "turn the
    // artifacts experiment on first" — which sends the user to a switch
    // that is already where it should be.
    artifactsEnableStatus.record({
      desired: true,
      ok: false,
      detail: "artifact store is owned by another KeepDeck process",
    });
    listed.mockRejectedValueOnce(
      new Error("artifact store is off — turn the artifacts experiment on first"),
    );
    mount();
    await settle();
    expect(registry.error).toBe(
      "artifact store is owned by another KeepDeck process",
    );
  });

  it("resolves the address at the click, not at the listing", async () => {
    mount();
    await settle();
    expect(resolved).not.toHaveBeenCalled();
    act(() => registry.open("auth-flow"));
    await settle();
    expect(resolved).toHaveBeenCalledWith({ workspaceId: "ws-1" }, "auth-flow");
    expect(opened).toHaveBeenCalledWith("http://127.0.0.1:56513/a/tok/auth-flow");
  });

  it("marks the row busy while its open is in flight and frees it after", async () => {
    let release = (): void => {};
    resolved.mockImplementationOnce(
      () =>
        new Promise((res) => {
          release = () =>
            res({ url: "http://127.0.0.1:1/a/t/auth-flow", indexUrl: "http://127.0.0.1:1/i/" });
        }),
    );
    mount();
    await settle();
    act(() => registry.open("auth-flow"));
    expect(registry.busyId).toBe("auth-flow");
    release();
    await settle();
    expect(registry.busyId).toBeNull();
  });

  it("surfaces an open that failed and leaves the row usable", async () => {
    resolved.mockRejectedValueOnce(new Error("display server is down"));
    mount();
    await settle();
    act(() => registry.open("auth-flow"));
    await settle();
    expect(registry.error).toBe("display server is down");
    expect(registry.busyId).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });

  it("asks before deleting, names the artifact in the question, and a cancel touches nothing", async () => {
    mount();
    await settle();

    act(() => registry.requestDelete("auth-flow"));
    // The TITLE, not the id: the question has to name what the user is
    // looking at. The stamp rides along so the answer belongs to THIS
    // row rather than to whatever wears its id later.
    expect(registry.confirm).toEqual({
      id: "auth-flow",
      title: "The auth-flow",
      updatedAt: 1_700_000_000_000,
      versionCount: 2,
    });
    expect(removed).not.toHaveBeenCalled();

    act(() => registry.cancelConfirm());
    expect(registry.confirm).toBeNull();
    expect(removed).not.toHaveBeenCalled();
  });

  it("a confirmed delete goes to the store and is announced to the whole app", async () => {
    mount();
    await settle();
    act(() => registry.requestDelete("auth-flow"));

    listed.mockResolvedValueOnce([row("deck-layout")]);
    act(() => registry.confirmDelete());
    await settle();

    expect(removed).toHaveBeenCalledWith({ workspaceId: "ws-1", slug: "auth-flow" });
    // Announced, not spliced out locally: other surfaces show this store
    // too, and a delete kept to one of them leaves the rest lying.
    expect(registry.rows?.map((r) => r.id)).toEqual(["deck-layout"]);
    expect(registry.confirm).toBeNull();
  });

  it("withdraws the question when the row moves under it", async () => {
    // An id is not an identity: a delete frees it, and the next publish
    // under the same id is a NEW artifact. An agent doing exactly that
    // while the user sits on the question would leave the answer aimed at
    // something they never saw — the modal blocks the human, not the
    // agent.
    mount();
    await settle();
    act(() => registry.requestDelete("auth-flow"));
    expect(registry.confirm).not.toBeNull();

    // Same id, new artifact: version 1 again, a newer stamp.
    listed.mockResolvedValueOnce([
      row("auth-flow", { versionCount: 1, updatedAt: 1_700_000_009_999 }),
      row("deck-layout"),
    ]);
    act(() => artifactChanges.changed());
    await settle();

    expect(registry.confirm).toBeNull();
    expect(removed).not.toHaveBeenCalled();
  });

  it("keeps the question standing while its own row is untouched", async () => {
    // The cure must not be a surface that closes itself whenever anything
    // else in the workspace is published.
    mount();
    await settle();
    act(() => registry.requestDelete("auth-flow"));

    listed.mockResolvedValueOnce([row("auth-flow"), row("deck-layout"), row("port-map")]);
    act(() => artifactChanges.changed());
    await settle();

    expect(registry.confirm).toEqual({
      id: "auth-flow",
      title: "The auth-flow",
      updatedAt: 1_700_000_000_000,
      versionCount: 2,
    });
  });

  it("does not claim the store changed when nothing was deleted", async () => {
    // Deleting is idempotent; a no-op that announced a change would send
    // every subscriber to walk the store again over nothing. The agent's
    // delete already obeys this rule.
    removed.mockResolvedValueOnce({
      id: "auth-flow",
      deleted: false,
      versionCount: null,
      createdAt: null,
    });
    mount();
    await settle();
    act(() => registry.requestDelete("auth-flow"));

    act(() => registry.confirmDelete());
    await settle();

    expect(listed).toHaveBeenCalledTimes(1);
  });

  it("a refused delete says so and leaves the row where it is", async () => {
    removed.mockRejectedValueOnce(new Error("artifact store is off"));
    mount();
    await settle();
    act(() => registry.requestDelete("auth-flow"));

    act(() => registry.confirmDelete());
    await settle();

    expect(registry.error).toBe("artifact store is off");
    expect(registry.rows?.map((r) => r.id)).toEqual(["auth-flow", "deck-layout"]);
    expect(registry.busyId).toBeNull();
  });

  it("copies the IDENTITY, not an address, and lets the ack expire", async () => {
    vi.useFakeTimers();
    mount();
    await settle();
    act(() => registry.copyId("auth-flow"));
    await settle();
    // The whole point of the surface: a url dies with the port, an id does not.
    expect(copied).toHaveBeenCalledWith("auth-flow");
    expect(registry.copiedId).toBe("auth-flow");
    act(() => void vi.advanceTimersByTime(2_000));
    expect(registry.copiedId).toBeNull();
  });

  it("does not let a workspace's late answer paint under another's name", async () => {
    const answers: Array<(rows: ArtifactMetaRow[]) => void> = [];
    listed.mockImplementation(() => new Promise((res) => answers.push(res)));
    mount();
    // Switch before the first read lands, then answer them in the order
    // they were asked — the stale one first.
    workspaceId = "ws-2";
    act(() => root.render(createElement(Probe)));
    // Rows in hand belong to the workspace that was just left, so the
    // list is UNKNOWN from the moment of the switch — not stale content
    // under a new name.
    expect(registry.rows).toBeNull();
    answers[1]?.([row("deck-layout")]);
    answers[0]?.([row("auth-flow")]);
    await settle();
    expect(registry.rows?.map((r) => r.id)).toEqual(["deck-layout"]);
  });

  it("reads nothing when there is no workspace, and says so as an empty list", async () => {
    workspaceId = null;
    mount();
    await settle();
    expect(listed).not.toHaveBeenCalled();
    expect(registry.rows).toEqual([]);
    expect(registry.error).toBeNull();
  });

  it("keeps the rows up while it re-reads, so the dialog does not flinch", async () => {
    // The read is a local disk walk: blanking the list for its duration
    // swapped the rows for a placeholder and back, which on every publish
    // is a card that jumps rather than a list that updated.
    mount();
    await settle();
    const answers: Array<(rows: ArtifactMetaRow[]) => void> = [];
    listed.mockImplementationOnce(() => new Promise((res) => answers.push(res)));

    act(() => artifactChanges.changed());

    expect(registry.rows?.map((r) => r.id)).toEqual(["auth-flow", "deck-layout"]);
    answers[0]?.([row("auth-flow")]);
    await settle();
    expect(registry.rows?.map((r) => r.id)).toEqual(["auth-flow"]);
  });

  it("re-reads when the app writes — a list read once is stale the moment an agent publishes", async () => {
    // No refresh control exists, and none should: the writer is in this
    // process, so the list follows it instead of waiting to be asked.
    mount();
    await settle();
    listed.mockResolvedValueOnce([row("auth-flow"), row("deck-layout"), row("port-map")]);
    act(() => artifactChanges.changed());
    await settle();
    expect(listed).toHaveBeenCalledTimes(2);
    expect(registry.rows).toHaveLength(3);
  });
});
