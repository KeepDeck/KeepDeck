import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { announceArtifact } from "./producers";
import {
  artifactSource,
  openArtifactByRef,
  openArtifactFromNotification,
} from "./entryPoints";
import type { NotificationSource } from "../../domain/notifications";

vi.mock("../notificationCenter", () => ({
  notify: vi.fn(),
}));
vi.mock("../../ipc/app", () => ({
  openUrl: vi.fn(),
}));
vi.mock("../../ipc/artifacts", () => ({
  artifactResolveUrls: vi.fn(),
  artifactsEnable: vi.fn(),
  artifactsDisable: vi.fn(),
  artifactPublish: vi.fn(),
  artifactList: vi.fn(),
  artifactRead: vi.fn(),
  artifactDelete: vi.fn(),
}));

import { notify } from "../notificationCenter";
import { openUrl } from "../../ipc/app";
import { artifactResolveUrls } from "../../ipc/artifacts";

const instance = createWorkspaceInstance();
const workspaceIsLive = () => true;

const workspaces = () => [{ id: "ws-1", name: "KeepDeck" }];

describe("announceArtifact", () => {
  it("first publish notifies once, naming pane, slug and workspace", () => {
    announceArtifact(
      {
        kind: "published",
        workspaceId: "ws-1",
        workspaceInstance: instance,
        slug: "auth-flow",
        paneLabel: "support 1",
      },
      { workspaces },
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "support 1 published an artifact",
        body: expect.stringContaining("auth-flow"),
        tag: "artifacts:ws-1:auth-flow",
      }),
    );
  });

  it("delete notifies with the removed wording", () => {
    announceArtifact(
      {
        kind: "deleted",
        workspaceId: "ws-1",
        workspaceInstance: instance,
        slug: "gone",
        paneLabel: "support 1",
      },
      { workspaces },
    );
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "support 1 removed an artifact",
        source: { type: "artifacts", workspace: { id: "ws-1", instance } },
      }),
    );
  });
});

describe("artifactSource", () => {
  it("carries identifiers only — publish sets artifactId, delete omits it", () => {
    const published = artifactSource({
      kind: "published",
      workspaceId: "ws-1",
      workspaceInstance: instance,
      slug: "x",
      paneLabel: "l",
    });
    expect(published.artifactId).toBe("x");
    const deleted = artifactSource({
      kind: "deleted",
      workspaceId: "ws-1",
      workspaceInstance: instance,
      slug: "x",
      paneLabel: "l",
    });
    expect(deleted.artifactId).toBeUndefined();
    expect(JSON.stringify(published)).not.toContain("http");
  });
});

describe("openArtifactByRef", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a ref that names no artifact goes to the workspace index", async () => {
    // The arm the delete-built notification and a future index door both
    // take: the server's entry is identifier-only, so "no artifact" is an
    // empty slug and the index is the answer — never a slug probe whose
    // 404 the caller would have to interpret.
    vi.mocked(artifactResolveUrls).mockResolvedValue({
      url: "http://127.0.0.1:41/a/t/x",
      indexUrl: "http://127.0.0.1:41/i/",
    });

    const opened = await openArtifactByRef("ws-1", null);

    expect(artifactResolveUrls).toHaveBeenCalledWith({ workspaceId: "ws-1" }, "");
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:41/i/");
    expect(opened).toBe("http://127.0.0.1:41/i/");
  });

  it("lets a refusal through — each door decides how loudly to react", async () => {
    // The registry shows it; the notification router swallows it. Neither
    // can happen if the ladder swallows it first.
    vi.mocked(artifactResolveUrls).mockRejectedValue(new Error("display off"));

    await expect(openArtifactByRef("ws-1", "x")).rejects.toThrow("display off");
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("openArtifactFromNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a live artifact opens its URL in the system browser", async () => {
    vi.mocked(artifactResolveUrls).mockResolvedValue({
      url: "http://127.0.0.1:41/a/t/x",
      indexUrl: "http://127.0.0.1:41/i/",
    });
    const source = artifactSource({
      kind: "published",
      workspaceId: "ws-1",
      workspaceInstance: instance,
      slug: "x",
      paneLabel: "l",
    });
    const result = await openArtifactFromNotification(source, workspaceIsLive);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:41/a/t/x");
    expect(result).toEqual({ opened: "http://127.0.0.1:41/a/t/x" });
  });

  it("a DEAD artifactId falls back to the index URL", async () => {
    vi.mocked(artifactResolveUrls).mockResolvedValue({
      url: null,
      indexUrl: "http://127.0.0.1:41/i/",
    });
    const source: NotificationSource = {
      type: "artifacts",
      workspace: { id: "ws-1", instance },
      artifactId: "deleted-since",
    };
    const result = await openArtifactFromNotification(source, workspaceIsLive);
    expect(openUrl).toHaveBeenCalledWith("http://127.0.0.1:41/i/");
    expect(result).toEqual({ opened: "http://127.0.0.1:41/i/" });
  });

  it("an unresolvable click (server down) is a SILENT no-op", async () => {
    vi.mocked(artifactResolveUrls).mockRejectedValue("display server off");
    const source = artifactSource({
      kind: "published",
      workspaceId: "ws-1",
      workspaceInstance: instance,
      slug: "x",
      paneLabel: "l",
    });
    const result = await openArtifactFromNotification(source, workspaceIsLive);
    expect(openUrl).not.toHaveBeenCalled();
    expect(result).toEqual({ silent: "unresolved" });
  });

  it("stale workspace instances are a silent no-op", async () => {
    const source = artifactSource({
      kind: "published",
      workspaceId: "ws-1",
      workspaceInstance: instance,
      slug: "x",
      paneLabel: "l",
    });

    const result = await openArtifactFromNotification(source, () => false);

    expect(artifactResolveUrls).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
    expect(result).toEqual({ silent: "unresolved" });
  });
});
