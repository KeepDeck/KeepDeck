import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { recentProjects } from "./history";

/** Pins the wire contract with src-tauri/src/recent_projects.rs. */
describe("history ipc", () => {
  beforeEach(() => invoke.mockReset());

  it("recentProjects invokes recent_projects and passes its projects through", async () => {
    const answer = { home: "/Users/me", projects: [{ root: "/repo", sessions: 3, lastAt: 90 }] };
    invoke.mockResolvedValueOnce(answer);
    await expect(recentProjects()).resolves.toEqual(answer);
    expect(invoke).toHaveBeenCalledWith("recent_projects");
  });
});
