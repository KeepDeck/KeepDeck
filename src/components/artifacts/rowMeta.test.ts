import { describe, expect, it } from "vitest";
import type { ArtifactMetaRow } from "../../ipc/artifacts";
import { rowMeta } from "./rowMeta";

const NOW = 1_700_000_000_000;
const row = (over: Partial<ArtifactMetaRow> = {}): ArtifactMetaRow => ({
  id: "auth-flow",
  title: "The auth flow",
  versionCount: 3,
  updatedAt: NOW - 7_200_000,
  lastAuthor: "support 1",
  ...over,
});

describe("rowMeta", () => {
  it("reads id first, then version, age and author", () => {
    // The id leads because it is the half that survives a restart.
    expect(rowMeta(row(), NOW)).toEqual({
      id: "auth-flow",
      tail: " · v3 · 2h ago · support 1",
    });
  });

  it("leaves out an author the store does not have", () => {
    // Not an empty tail: a trailing separator reads as a value that
    // failed to load rather than as one that was never there.
    expect(rowMeta(row({ lastAuthor: "" }), NOW).tail).toBe(" · v3 · 2h ago");
  });
});
