import { describe, expect, it } from "vitest";
import type { ArtifactMetaRow } from "../../ipc/artifacts";
import { rowMeta } from "./rowMeta";

const NOW = 1_700_000_000_000;
const row = (over: Partial<ArtifactMetaRow> = {}): ArtifactMetaRow => ({
  id: "auth-flow",
  title: "The auth flow",
  versionCount: 3,
  updatedAt: NOW - 7_200_000,
  generation: "gen-1",
  ...over,
});

describe("rowMeta", () => {
  it("reads id first, then version and age", () => {
    // The id leads because it is the half that survives a restart.
    expect(rowMeta(row(), NOW)).toEqual({
      id: "auth-flow",
      tail: " · v3 · 2h ago",
    });
  });

});
