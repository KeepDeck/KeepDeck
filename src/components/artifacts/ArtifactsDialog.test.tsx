// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactChanges } from "../../app/artifacts/changes";
import type { ArtifactMetaRow } from "../../ipc/artifacts";
import { ArtifactsDialog } from "./ArtifactsDialog";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Doubled at the IPC edge only: the dialog, its machine and the shared
// open-by-identity ladder all run for real, which is the seam worth
// covering — a row on screen has to reach the browser.
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
  versionCount: 3,
  updatedAt: Date.now(),
  lastAuthor: "support 1",
  ...over,
});

let host: HTMLDivElement;
let root: Root;

// The dialog portals to document.body, so every query starts there.
const buttonWithText = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === text,
  );
const rowsOnScreen = () =>
  Array.from(document.querySelectorAll(".artifacts__row"));

/** Mount SYNCHRONOUSLY: awaiting a sync `act` yields to the microtask
 * queue, which is where the list promise settles — its setState would
 * then land outside any act and warn. `settle` is the one await. */
const render = (
  activeWs: { id: string; name: string } | null = { id: "ws-1", name: "KeepDeck" },
) => {
  act(() =>
    root.render(createElement(ArtifactsDialog, { activeWs, onClose: () => {} })),
  );
};
const settle = () => act(async () => {});

beforeEach(() => {
  document.body.innerHTML = "";
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  listed.mockReset().mockResolvedValue([row("auth-flow"), row("deck-layout")]);
  resolved.mockReset().mockResolvedValue({
    url: "http://127.0.0.1:56513/a/tok/auth-flow",
    indexUrl: "http://127.0.0.1:56513/idx/",
  });
  opened.mockReset().mockResolvedValue(undefined);
  copied.mockReset().mockResolvedValue(undefined);
});

afterEach(() => act(() => root.unmount()));

describe("ArtifactsDialog", () => {
  it("gives each row its identity, not its address", async () => {
    // A url is what dies on restart, so a row must not offer one to copy
    // down or read off — the id and the version count are what it shows.
    render();
    await settle();
    expect(rowsOnScreen()).toHaveLength(2);
    const first = rowsOnScreen()[0]?.textContent ?? "";
    expect(first).toContain("The auth-flow");
    expect(first).toContain("auth-flow");
    expect(first).toContain("v3");
    expect(first).toContain("support 1");
    expect(document.body.textContent).not.toContain("127.0.0.1");
  });

  it("opens through the row itself, which carries no Open button", async () => {
    render();
    await settle();
    // The row is the control; pressing a row is how a list says "this one".
    expect(buttonWithText("Open")).toBeUndefined();

    act(() =>
      rowsOnScreen()[0]
        ?.querySelector<HTMLButtonElement>(".artifacts__row-open")
        ?.click(),
    );
    await settle();

    expect(resolved).toHaveBeenCalledWith({ workspaceId: "ws-1" }, "auth-flow");
    expect(opened).toHaveBeenCalledWith("http://127.0.0.1:56513/a/tok/auth-flow");
  });

  it("keeps Copy id beside the row control, not inside it", async () => {
    // A button inside a button is invalid markup and, worse, a copy that
    // also opens the artifact.
    render();
    await settle();

    act(() => buttonWithText("Copy id")?.click());
    await settle();

    expect(copied).toHaveBeenCalledWith("auth-flow");
    expect(resolved).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
  });

  it("acknowledges a copied id on the row that was copied", async () => {
    render();
    await settle();
    act(() => buttonWithText("Copy id")?.click());
    await settle();
    expect(copied).toHaveBeenCalledWith("auth-flow");
    expect(rowsOnScreen()[0]?.textContent).toContain("Copied");
    expect(rowsOnScreen()[1]?.textContent).toContain("Copy id");
  });

  it("follows the store on its own, with no refresh control to press", async () => {
    render();
    await settle();
    expect(rowsOnScreen()).toHaveLength(2);
    expect(buttonWithText("Refresh")).toBeUndefined();

    listed.mockResolvedValueOnce([row("auth-flow"), row("deck-layout"), row("port-map")]);
    act(() => artifactChanges.changed());
    await settle();

    expect(rowsOnScreen()).toHaveLength(3);
  });

  it("says nothing is published only when the store said so", async () => {
    listed.mockResolvedValueOnce([]);
    render();
    await settle();
    expect(document.body.textContent).toContain("Nothing published yet");
  });

  it("shows a refusal in the store's own words instead of an empty library", async () => {
    listed.mockRejectedValueOnce(
      new Error("artifact store is off — turn the artifacts experiment on first"),
    );
    render();
    await settle();
    expect(document.body.textContent).toContain(
      "artifact store is off — turn the artifacts experiment on first",
    );
    expect(document.body.textContent).not.toContain("Nothing published yet");
  });

  it("reads no store at all without a workspace", async () => {
    render(null);
    await settle();
    expect(listed).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("No workspace open");
  });
});
