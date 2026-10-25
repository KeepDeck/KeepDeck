import { describe, expect, it } from "vitest";
import {
  createWorkspaceInstance,
  isWorkspaceInstance,
  UNMINTED_INSTANCE,
  workspaceInstanceOf,
} from "./workspaceInstance";

describe("workspace instance", () => {
  it("knows every lifetime it mints, and each one apart", () => {
    const first = createWorkspaceInstance();
    const second = createWorkspaceInstance();
    expect(isWorkspaceInstance(first)).toBe(true);
    expect(isWorkspaceInstance(second)).toBe(true);
    expect(first).not.toBe(second);
    expect(workspaceInstanceOf(first)).toBe(first);
  });

  it("carries a lifetime it never minted as one that names nothing", () => {
    for (const forged of ["", "ws-1", "workspace-", "workspace-x-y-z", "workspace-a-b-1 "]) {
      expect(isWorkspaceInstance(forged)).toBe(false);
      expect(workspaceInstanceOf(forged)).toBe(UNMINTED_INSTANCE);
    }
    expect(isWorkspaceInstance(42)).toBe(false);
  });
});
