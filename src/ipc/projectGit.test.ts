import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { projectGitDiffFile } from "./projectGit";

/** Pins the wire contract with src-tauri/src/project_git.rs. */
describe("projectGit ipc", () => {
  beforeEach(() => invoke.mockReset());

  it("sends a diff's own parameters as one request, beside where the repo is", async () => {
    const answer = { text: "@@", truncated: false };
    invoke.mockResolvedValueOnce(answer);
    await expect(
      projectGitDiffFile("/repo", ["/repo"], false, {
        file: "src/a.ts",
        staged: true,
        origPath: "src/old.ts",
      }),
    ).resolves.toEqual(answer);
    // The keys DiffRequest deserializes: camelCase, an absent side as null.
    expect(invoke).toHaveBeenCalledWith("project_git_diff_file", {
      path: "/repo",
      roots: ["/repo"],
      everywhere: false,
      request: {
        file: "src/a.ts",
        staged: true,
        from: null,
        to: null,
        origPath: "src/old.ts",
      },
    });
  });
});
