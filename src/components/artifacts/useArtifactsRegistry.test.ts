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
}));
vi.mock("../../ipc/app", () => ({ openUrl: vi.fn() }));
vi.mock("../../ipc/clipboard", () => ({ writeText: vi.fn() }));

import { openUrl } from "../../ipc/app";
import { artifactList, artifactResolveUrls } from "../../ipc/artifacts";
import { writeText } from "../../ipc/clipboard";

const listed = vi.mocked(artifactList);
const resolved = vi.mocked(artifactResolveUrls);
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
