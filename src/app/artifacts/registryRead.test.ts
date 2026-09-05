import { describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/artifacts", () => ({
  artifactList: vi.fn(),
  artifactVersions: vi.fn(),
}));

import { artifactList, artifactVersions } from "../../ipc/artifacts";
import { artifactsRegistryReads } from "./registryRead";

describe("artifactsRegistryReads", () => {
  it("binds the two reads to IPC with the arguments it was handed, and offers nothing else", async () => {
    vi.mocked(artifactList).mockResolvedValue([
      { id: "auth-flow", title: "Auth flow", versionCount: 1, updatedAt: 1, generation: "g-1" },
    ]);
    vi.mocked(artifactVersions).mockResolvedValue([{ n: 1, at: 1, size: 10 }]);
    const reads = artifactsRegistryReads();

    await expect(reads.list({ workspaceId: "ws-1" })).resolves.toEqual([
      expect.objectContaining({ id: "auth-flow" }),
    ]);
    expect(artifactList).toHaveBeenCalledWith({ workspaceId: "ws-1" });

    await expect(reads.versions({ workspaceId: "ws-1", slug: "auth-flow" })).resolves.toEqual([
      { n: 1, at: 1, size: 10 },
    ]);
    expect(artifactVersions).toHaveBeenCalledWith({ workspaceId: "ws-1", slug: "auth-flow" });

    // The surface is handed reads and only reads: open, delete and url
    // resolution stay behind this layer's own facades.
    expect(Object.keys(reads).sort()).toEqual(["list", "versions"]);
  });
});
