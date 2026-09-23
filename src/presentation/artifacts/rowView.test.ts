import { describe, expect, it } from "vitest";
import type {
  ArtifactMetaRow,
  ArtifactVersionRow,
} from "../../app/artifacts/registryRead";
import { artifactRowView, type OpenHistory } from "./rowView";
import { HISTORY_GONE, HISTORY_LOADING } from "./words";

const NOW = 1_700_000_000_000;
const row: ArtifactMetaRow = {
  id: "auth-flow",
  title: "The auth flow",
  versionCount: 2,
  updatedAt: NOW - 60_000,
  generation: "gen-1",
};
const open = (
  versions: readonly ArtifactVersionRow[] | null,
  ref: Partial<OpenHistory> = {},
): OpenHistory => ({
  workspaceId: "ws-1",
  id: row.id,
  generation: row.generation,
  versions,
  ...ref,
});

describe("artifactRowView", () => {
  it("is closed, and offers History, while no history is open for it", () => {
    const view = artifactRowView(row, NOW, null, null);
    expect(view.history).toBeNull();
    expect(view.toggleLabel).toBe("History");
  });

  it("does not take a history held for an earlier artifact of the same id", () => {
    // Deleting frees an id; the next publish under it is another artifact.
    // Matching by id alone drew the dead one's versions under the new one.
    const stale = open([], { generation: "gen-0" });
    expect(artifactRowView(row, NOW, null, stale).history).toBeNull();
  });

  it("tells a read still out apart from one that came back empty", () => {
    expect(artifactRowView(row, NOW, null, open(null)).history).toEqual({
      kind: "note",
      text: HISTORY_LOADING,
    });
    expect(artifactRowView(row, NOW, null, open([])).history).toEqual({
      kind: "note",
      text: HISTORY_GONE,
    });
  });

  it("lists versions newest first, with the agent's note only where it left one", () => {
    const view = artifactRowView(
      row,
      NOW,
      null,
      open([
        { n: 1, at: NOW - 7_200_000, size: 10 },
        { n: 2, at: NOW - 60_000, size: 12, message: "tighter copy" },
      ]),
    );
    expect(view.toggleLabel).toBe("Hide history");
    expect(view.history).toEqual({
      kind: "versions",
      lines: [
        { n: 2, label: "v2", when: "1m ago", message: "tighter copy" },
        { n: 1, label: "v1", when: "2h ago", message: null },
      ],
    });
  });

  it("is busy only while the action in flight is its own", () => {
    expect(artifactRowView(row, NOW, "auth-flow", null).busy).toBe(true);
    expect(artifactRowView(row, NOW, "other", null).busy).toBe(false);
  });
});
