import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import { announceArtifact } from "./producers";
import {
  artifactSource,
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
    const result = await openArtifactFromNotification(source);
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
    const result = await openArtifactFromNotification(source);
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
    const result = await openArtifactFromNotification(source);
    expect(openUrl).not.toHaveBeenCalled();
    expect(result).toEqual({ silent: "unresolved" });
  });
});
